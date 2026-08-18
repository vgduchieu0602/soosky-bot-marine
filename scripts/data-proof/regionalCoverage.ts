/**
 * REGIONAL-DATA-PROOF-1 — US / UK / Norway standalone crawler proof.
 *
 * Measures what the free crawler REALLY collects per region, per provider,
 * through the production pipeline:
 *
 *   VesselFinder map tile (scanArea)
 *     -> ProviderPositionResult -> ObservationRecorder -> vessel_observations
 *   free detail per vessel (CollectVesselObservations, per-source crawl runtime)
 *     -> ProviderDetailsResult -> ObservationRecorder -> vessel_observations
 *   ResolveAndStoreCurrentVessel -> canonical_current_vessels
 *
 * Canonical is NEVER written directly. Nothing here re-implements retry, rate
 * limiting, cooldown, validation, dedupe or resolution — all of that is the
 * existing runtime's job and is reused as-is.
 *
 * Hard rules enforced at startup:
 *   BOT_DATA_PROOF_MODE=true · isolated Mongo DB · BOT_AIS_ENABLED=false ·
 *   PAID_FALLBACK_ENABLED=false · MyShipTracking provider must not be registered.
 *
 * Usage:
 *   npm run proof:regional:a          # Stage A, 30 vessels per region
 *   npm run proof:regional:b          # Stage B, 100 vessels per region (manual)
 *   ts-node scripts/data-proof/regionalCoverage.ts --discovery-only --max-subregions=2
 */
import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";

import { buildContainer, Container } from "../../src/bootstrap/container";
import { config as loadedConfig } from "../../src/config";
import { assertSafeBotDatabase, isProofModeEnabled } from "../../src/config/databaseSafety";
import { ProviderOperation } from "../../src/application/contracts/providers/VesselDataProvider";
import { ProviderPositionResult } from "../../src/application/contracts/providers/ProviderResults";
import { CollectStatus } from "../../src/application/use-cases/observation/CollectVesselObservations";
import {
  SourceErrorCategory,
  SourceRequestError,
  SourceUnavailableError,
} from "../../src/application/services/crawl-runtime/SourceError";
import {
  VesselObservationType,
  VesselSourceObservation,
} from "../../src/domain/entities/VesselObservation";
import { VesselIdentity } from "../../src/domain/value-objects/VesselIdentity";
import { VesselPositionReport } from "../../src/domain/value-objects/VesselPositionReport";
import { mmsiIdentifier } from "../../src/domain/value-objects/VesselIdentifier";
import { isValidMmsi } from "../../src/domain/validators/identifiers";
import { VesselSource } from "../../src/domain/enums/VesselSource";
import { CrawlCheckpointModel } from "../../src/infrastructure/persistence/mongo/crawlCheckpointModel";
import { CurrentVesselModel } from "../../src/infrastructure/persistence/mongo/currentVesselModel";
import { VesselObservationModel } from "../../src/infrastructure/persistence/mongo/observationModels";
import { HttpClient } from "../../src/infrastructure/http/HttpClient";
import { VesselFinderHtmlSource } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderHtmlSource";

import { PROOF_REGIONS, PROOF_SUB_REGIONS, ProofRegion, ProofSubRegion } from "./regions";
import {
  CoverageBlock,
  RequestMetrics,
  RequestMetricsSummary,
  RequestOutcome,
  TimestampDerivation,
  VesselBasicsSample,
  coverageBlock,
  newRequestMetrics,
  recordRequest,
  renderClassificationTable,
  renderProviderMatrix,
  renderRegionalMatrix,
  renderRequestMetricsTable,
  severeBlockCount,
  summarizeRequests,
} from "./reportUtils";

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

type ProviderKey = "vesselfinder" | "shipfinder" | "shipinfo";

const PROVIDER_KEYS: readonly ProviderKey[] = ["vesselfinder", "shipfinder", "shipinfo"];

const PROVIDER_SOURCE: Readonly<Record<ProviderKey, VesselSource>> = Object.freeze({
  vesselfinder: VesselSource.VESSELFINDER,
  shipfinder: VesselSource.SHIPFINDER,
  shipinfo: VesselSource.SHIPINFO,
});

const DISCOVERY_JOB = "regional-data-proof-discovery";
const DISCOVERY_PARSER_VERSION = "regional-data-proof-vf-map-v1";

/** Consecutive 403/429 per source before that lane is abandoned (§24: measure, do not escalate). */
const BLOCK_STOP_THRESHOLD = 5;

// ---------------------------------------------------------------------------
//  CLI helpers
// ---------------------------------------------------------------------------

function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length).trim();
}

function flagInt(args: string[], name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --${name}=${raw}`);
  return Math.floor(n);
}

function flagBool(args: string[], name: string, fallback: boolean): boolean {
  const raw = flag(args, name);
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A shared, BOUNDED wait budget for crawl-runtime cooldowns.
 *
 * A cooldown means the runtime decided a source needs a rest. Racing through
 * the remaining queue and recording every call as "skipped" would measure our
 * own impatience rather than the source, so callers wait it out — a strictly
 * more polite behaviour, never an escalation (§24). The budget is finite: a
 * source that keeps cooling down gets REPORTED, not fought.
 */
class CooldownBudget {
  private used = 0;

  constructor(private readonly max: number) {}

  get spent(): number {
    return this.used;
  }

  /** @returns true when the caller should retry the same unit of work. */
  async waitFor(err: unknown, label: string): Promise<boolean> {
    if (!(err instanceof SourceUnavailableError)) return false;
    if (err.code !== "SOURCE_COOLDOWN" || err.retryAt === undefined) return false;
    if (this.used >= this.max) return false;
    this.used += 1;
    const waitMs = Math.max(0, err.retryAt.getTime() - Date.now()) + 1_000;
    console.log(
      `[cooldown] ${label} waiting ${Math.round(waitMs / 1000)}s (${this.used}/${this.max})`
    );
    await sleep(waitMs);
    return true;
  }
}

// ---------------------------------------------------------------------------
//  Runtime instrumentation
// ---------------------------------------------------------------------------

interface ResourceUsage {
  peakRssMb: number;
  peakHeapUsedMb: number;
  cpuUserMs: number;
  cpuSystemMs: number;
}

class ResourceTracker {
  private peakRss = 0;
  private peakHeap = 0;
  private readonly cpuStart = process.cpuUsage();

  sample(): void {
    const mem = process.memoryUsage();
    this.peakRss = Math.max(this.peakRss, mem.rss);
    this.peakHeap = Math.max(this.peakHeap, mem.heapUsed);
  }

  snapshot(): ResourceUsage {
    this.sample();
    const cpu = process.cpuUsage(this.cpuStart);
    return {
      peakRssMb: Math.round(this.peakRss / 1024 / 1024),
      peakHeapUsedMb: Math.round(this.peakHeap / 1024 / 1024),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
    };
  }
}

/** Category -> report bucket. HTTP 404 is folded into NOT_FOUND by the shared runtime. */
function outcomeOf(err: unknown): RequestOutcome {
  if (err instanceof SourceUnavailableError) return "skipped";
  if (err instanceof SourceRequestError) {
    switch (err.category) {
      case SourceErrorCategory.NOT_FOUND:
        return "notFound";
      case SourceErrorCategory.TIMEOUT:
        return "timeout";
      case SourceErrorCategory.BLOCKED:
        return "403";
      case SourceErrorCategory.RATE_LIMITED:
        return "429";
      case SourceErrorCategory.SERVER_ERROR:
        return "5xx";
      case SourceErrorCategory.NETWORK_ERROR:
        return "networkError";
      case SourceErrorCategory.PARSE_ERROR:
        return "parseError";
      default:
        return "unknown";
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
//  Discovery
// ---------------------------------------------------------------------------

interface SubRegionOutcome {
  region: ProofRegion;
  subRegion: string;
  label: string;
  box: ProofSubRegion["box"];
  shipsReturned: number;
  uniqueAdded: number;
  outcome: RequestOutcome;
  latencyMs: number;
  observationsSaved: number;
  error?: string;
}

interface SampledVessel {
  mmsi: string;
  region: ProofRegion;
  subRegion: string;
  discoverySource: string;
}

interface DiscoveryResult {
  subRegions: SubRegionOutcome[];
  vessels: SampledVessel[];
  metricsByRegion: Record<ProofRegion, RequestMetrics>;
  resumedFromIndex: number;
  completedIndex: number;
}

interface DiscoveryCursor {
  subRegionIndex: number;
  subRegionsTotal: number;
  lastSubRegion: string;
}

async function loadDiscoveryCursor(): Promise<DiscoveryCursor | null> {
  const doc = await CrawlCheckpointModel.findOne({ job: DISCOVERY_JOB }).lean();
  return doc ? (doc.cursor as DiscoveryCursor) : null;
}

async function saveDiscoveryCursor(cursor: DiscoveryCursor, stats: object): Promise<void> {
  await CrawlCheckpointModel.findOneAndUpdate(
    { job: DISCOVERY_JOB },
    {
      job: DISCOVERY_JOB,
      provider: VesselSource.VESSELFINDER,
      cursor,
      stats,
      updatedAt: new Date(),
    },
    { upsert: true }
  );
}

async function runDiscovery(
  container: Container,
  options: {
    perRegion: number;
    resetCheckpoint: boolean;
    maxSubRegions: number;
    cooldown: CooldownBudget;
    resources: ResourceTracker;
  }
): Promise<DiscoveryResult> {
  const provider = container.providerRegistry.get(VesselSource.VESSELFINDER);
  if (!provider?.scanArea) throw new Error("VesselFinderProvider.scanArea unavailable");
  const executor = container.crawlRuntime.getExecutor(VesselSource.VESSELFINDER);

  const total = PROOF_SUB_REGIONS.length;
  let startIndex = 0;
  if (options.resetCheckpoint) {
    await CrawlCheckpointModel.deleteOne({ job: DISCOVERY_JOB });
  } else {
    const cursor = await loadDiscoveryCursor();
    if (cursor && cursor.subRegionIndex > 0 && cursor.subRegionIndex < total) {
      startIndex = cursor.subRegionIndex;
      console.log(
        `[discovery] resuming checkpoint at sub-region ${startIndex}/${total} (last=${cursor.lastSubRegion})`
      );
    }
  }

  const endIndex = Math.min(total, startIndex + options.maxSubRegions);
  const subRegions: SubRegionOutcome[] = [];
  const metricsByRegion = {
    US: newRequestMetrics(),
    UK: newRequestMetrics(),
    NORWAY: newRequestMetrics(),
  } as Record<ProofRegion, RequestMetrics>;

  // Per-sub-region MMSI buckets keep the sample spread across the whole region
  // instead of letting one busy port fill the quota alone.
  const buckets = new Map<string, string[]>();
  const seenByRegion = new Map<ProofRegion, Set<string>>(
    PROOF_REGIONS.map((r) => [r, new Set<string>()])
  );

  let index = startIndex;
  for (; index < endIndex; index++) {
    const sub = PROOF_SUB_REGIONS[index];
    const row: SubRegionOutcome = {
      region: sub.region,
      subRegion: sub.name,
      label: sub.label,
      box: sub.box,
      shipsReturned: 0,
      uniqueAdded: 0,
      outcome: "200",
      latencyMs: 0,
      observationsSaved: 0,
    };

    let attemptTile = true;
    while (attemptTile) {
      attemptTile = false;
      const attemptStartedAt = Date.now();
      try {
        const results = await executor.execute<readonly ProviderPositionResult[]>(
          () => provider.scanArea!(sub.box),
          { operation: ProviderOperation.SCAN_AREA }
        );
        row.latencyMs = Date.now() - attemptStartedAt;
        row.shipsReturned = results.length;
        row.outcome = "200";
        recordRequest(metricsByRegion[sub.region], "200", row.latencyMs);

        // Real pipeline: map rows become POSITION/IDENTITY observations.
        const saved = await container.observationRecorder.recordPositions(results, {
          parserVersion: DISCOVERY_PARSER_VERSION,
        });
        row.observationsSaved = saved.filter((s) => s.status === "SAVED").length;

        const bucket: string[] = [];
        const seen = seenByRegion.get(sub.region)!;
        for (const result of results) {
          const mmsi = result.position?.mmsi ?? result.identity?.mmsi ?? null;
          if (!isValidMmsi(mmsi)) continue;
          if (seen.has(mmsi!)) continue;
          seen.add(mmsi!);
          bucket.push(mmsi!);
        }
        buckets.set(sub.name, bucket);
        row.uniqueAdded = bucket.length;
      } catch (err) {
        row.latencyMs = Date.now() - attemptStartedAt;
        row.error = (err as Error).message?.slice(0, 240);
        if (await options.cooldown.waitFor(err, `discovery/${sub.name}`)) {
          attemptTile = true;
          continue;
        }
        row.outcome = outcomeOf(err);
        recordRequest(metricsByRegion[sub.region], row.outcome, row.latencyMs);
        buckets.set(sub.name, []);
      }
    }

    subRegions.push(row);
    options.resources.sample();
    console.log(
      `[discovery] ${sub.name} ${row.outcome} ships=${row.shipsReturned} ` +
        `unique=${row.uniqueAdded} obs+=${row.observationsSaved} ${row.latencyMs}ms`
    );

    await saveDiscoveryCursor(
      { subRegionIndex: index + 1, subRegionsTotal: total, lastSubRegion: sub.name },
      {
        shipsReturned: row.shipsReturned,
        uniqueAdded: row.uniqueAdded,
        observationsSaved: row.observationsSaved,
      }
    );
  }

  // Quota: even split across the region's sub-regions, then top up from whoever
  // still has spare MMSIs. A blocked or empty sub-region cannot starve the run.
  const vessels: SampledVessel[] = [];
  for (const region of PROOF_REGIONS) {
    const regionSubs = PROOF_SUB_REGIONS.filter((s) => s.region === region);
    const quota = Math.ceil(options.perRegion / Math.max(1, regionSubs.length));
    const cursors = new Map<string, number>();
    const picked: SampledVessel[] = [];

    for (const sub of regionSubs) {
      const bucket = buckets.get(sub.name) ?? [];
      const take = bucket.slice(0, quota);
      cursors.set(sub.name, take.length);
      for (const mmsi of take) {
        picked.push({ mmsi, region, subRegion: sub.name, discoverySource: "vesselfinder-map" });
      }
    }
    let progressed = true;
    while (picked.length < options.perRegion && progressed) {
      progressed = false;
      for (const sub of regionSubs) {
        if (picked.length >= options.perRegion) break;
        const bucket = buckets.get(sub.name) ?? [];
        const cursor = cursors.get(sub.name) ?? 0;
        if (cursor >= bucket.length) continue;
        picked.push({
          mmsi: bucket[cursor],
          region,
          subRegion: sub.name,
          discoverySource: "vesselfinder-map",
        });
        cursors.set(sub.name, cursor + 1);
        progressed = true;
      }
    }
    vessels.push(...picked.slice(0, options.perRegion));
    console.log(`[discovery] ${region} sample=${Math.min(picked.length, options.perRegion)}`);
  }

  return {
    subRegions,
    vessels,
    metricsByRegion,
    resumedFromIndex: startIndex,
    completedIndex: index,
  };
}

// ---------------------------------------------------------------------------
//  Detail probe (provider isolation, §17)
// ---------------------------------------------------------------------------

interface ProbeRow {
  mmsi: string;
  region: ProofRegion;
  provider: ProviderKey;
  outcome: RequestOutcome;
  latencyMs: number;
  status?: CollectStatus;
  error?: string;
}

interface ProbeResult {
  rows: ProbeRow[];
  metricsByProvider: Record<ProviderKey, RequestMetrics>;
  metricsByRegionProvider: Record<string, RequestMetrics>;
  stoppedProviders: ProviderKey[];
  cooldownWaitsByProvider: Record<ProviderKey, number>;
  /** MMSI -> relative source age, measured on the raw VesselFinder detail page. */
  vesselFinderRelativeAge: Map<string, { observedAt: Date; ageMinutes: number }>;
  vesselFinderProbeMetrics: RequestMetrics;
}

/** "5 min ago" / "1 hour ago" -> milliseconds. Anything unrecognised -> null. */
function parseRelativeAgeMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  if (text === "" || text === "-" || text === "n/a") return null;
  if (text === "just now" || text === "0 min ago") return 0;
  let m = /^(\d+)\s*m(?:in(?:ute)?s?)?\s*ago$/.exec(text);
  if (m) return Number(m[1]) * 60_000;
  m = /^(\d+)\s*h(?:our)?s?\s*ago$/.exec(text);
  if (m) return Number(m[1]) * 3_600_000;
  m = /^(\d+)\s*d(?:ay)?s?\s*ago$/.exec(text);
  if (m) return Number(m[1]) * 86_400_000;
  return null;
}

async function runProbe(
  container: Container,
  vessels: readonly SampledVessel[],
  options: {
    providers: readonly ProviderKey[];
    vesselFinderTimestampProbe: boolean;
    maxCooldownWaits: number;
    resources: ResourceTracker;
  }
): Promise<ProbeResult> {
  const rows: ProbeRow[] = [];
  const metricsByProvider = {
    vesselfinder: newRequestMetrics(),
    shipfinder: newRequestMetrics(),
    shipinfo: newRequestMetrics(),
  } as Record<ProviderKey, RequestMetrics>;
  const metricsByRegionProvider: Record<string, RequestMetrics> = {};
  const stoppedProviders: ProviderKey[] = [];
  const cooldownByProvider = {
    vesselfinder: new CooldownBudget(options.maxCooldownWaits),
    shipfinder: new CooldownBudget(options.maxCooldownWaits),
    shipinfo: new CooldownBudget(options.maxCooldownWaits),
  } as Record<ProviderKey, CooldownBudget>;
  const vesselFinderRelativeAge = new Map<string, { observedAt: Date; ageMinutes: number }>();
  const vesselFinderProbeMetrics = newRequestMetrics();

  const regionProviderMetrics = (region: ProofRegion, provider: ProviderKey): RequestMetrics => {
    const key = `${region}/${provider}`;
    if (!metricsByRegionProvider[key]) metricsByRegionProvider[key] = newRequestMetrics();
    return metricsByRegionProvider[key];
  };

  // One lane per provider. Concurrency INSIDE a lane is 1 and the pacing/retry/
  // cooldown all come from the shared crawl runtime — nothing is re-invented.
  async function lane(provider: ProviderKey): Promise<void> {
    const source = PROVIDER_SOURCE[provider];
    let blocks = 0;
    let stopped = false;

    for (const vessel of vessels) {
      if (stopped) {
        rows.push({
          mmsi: vessel.mmsi,
          region: vessel.region,
          provider,
          outcome: "skipped",
          latencyMs: 0,
          error: "lane stopped after severe blocking",
        });
        recordRequest(metricsByProvider[provider], "skipped", 0);
        recordRequest(regionProviderMetrics(vessel.region, provider), "skipped", 0);
        continue;
      }

      const row: ProbeRow = {
        mmsi: vessel.mmsi,
        region: vessel.region,
        provider,
        outcome: "200",
        latencyMs: 0,
      };

      let attemptVessel = true;
      while (attemptVessel) {
        attemptVessel = false;
        const startedAt = Date.now();
        try {
          const result = await container.collectVesselObservations.execute({
            source,
            identifier: mmsiIdentifier(vessel.mmsi),
            operation: ProviderOperation.GET_DETAILS,
          });
          row.latencyMs = Date.now() - startedAt;
          row.status = result.status;
          row.outcome =
            result.status === CollectStatus.RECORDED
              ? "200"
              : result.status === CollectStatus.NOT_FOUND
                ? "notFound"
                : "skipped";
        } catch (err) {
          row.latencyMs = Date.now() - startedAt;
          row.error = (err as Error).message?.slice(0, 240);
          if (await cooldownByProvider[provider].waitFor(err, `probe/${provider}`)) {
            attemptVessel = true;
            continue;
          }
          if (err instanceof SourceUnavailableError) {
            // Cooldown budget spent, or the source is disabled outright.
            stopped = true;
            if (!stoppedProviders.includes(provider)) stoppedProviders.push(provider);
            console.log(`[probe] ${provider} STOPPED — ${err.code}, remaining marked skipped`);
          }
          row.outcome = outcomeOf(err);
        }
      }

      rows.push(row);
      recordRequest(metricsByProvider[provider], row.outcome, row.latencyMs);
      recordRequest(regionProviderMetrics(vessel.region, provider), row.outcome, row.latencyMs);
      options.resources.sample();

      if (row.outcome === "403" || row.outcome === "429") {
        blocks += 1;
        console.log(`[probe] ${provider} block #${blocks} (${row.outcome})`);
        if (blocks >= BLOCK_STOP_THRESHOLD) {
          stopped = true;
          stoppedProviders.push(provider);
          console.log(`[probe] ${provider} STOPPED — severe blocking, remaining marked skipped`);
        }
      }
      console.log(
        `[probe] ${provider} ${vessel.region} ${vessel.mmsi} ${row.outcome} ${row.latencyMs}ms`
      );
    }
  }

  /**
   * Diagnostic-only VesselFinder surface probe (§21).
   *
   * The production provider deliberately refuses the `lrpd` relative age as
   * `sourceReceivedAt`, so the pipeline stores NO source time for VesselFinder.
   * To classify the SOURCE rather than the mapping, the raw detail page is read
   * once more — through the SAME crawl-runtime executor, so VesselFinder still
   * sees one request at a time at the configured pace.
   */
  async function vesselFinderTimestampLane(): Promise<void> {
    const executor = container.crawlRuntime.getExecutor(VesselSource.VESSELFINDER);
    const html = new VesselFinderHtmlSource(
      new HttpClient({ timeoutMs: container.crawlRuntime.getConfig(VesselSource.VESSELFINDER).timeoutMs })
    );
    for (const vessel of vessels) {
      let attemptVessel = true;
      while (attemptVessel) {
        attemptVessel = false;
        const startedAt = Date.now();
        try {
          const details = await executor.execute(() => html.getDetails(vessel.mmsi), {
            operation: ProviderOperation.GET_DETAILS,
          });
          const latencyMs = Date.now() - startedAt;
          recordRequest(vesselFinderProbeMetrics, "200", latencyMs);
          const ageMs = parseRelativeAgeMs(details.position?.positionTime);
          if (ageMs !== null) {
            vesselFinderRelativeAge.set(vessel.mmsi, {
              observedAt: new Date(Date.now() - ageMs),
              ageMinutes: Math.round(ageMs / 60_000),
            });
          }
        } catch (err) {
          if (await cooldownByProvider.vesselfinder.waitFor(err, "probe/vf-timestamp")) {
            attemptVessel = true;
            continue;
          }
          recordRequest(vesselFinderProbeMetrics, outcomeOf(err), Date.now() - startedAt);
        }
      }
      options.resources.sample();
    }
  }

  const lanes = options.providers.map((provider) => lane(provider));
  if (options.vesselFinderTimestampProbe && options.providers.includes("vesselfinder")) {
    lanes.push(vesselFinderTimestampLane());
  }
  await Promise.all(lanes);

  return {
    rows,
    metricsByProvider,
    metricsByRegionProvider,
    stoppedProviders,
    cooldownWaitsByProvider: {
      vesselfinder: cooldownByProvider.vesselfinder.spent,
      shipfinder: cooldownByProvider.shipfinder.spent,
      shipinfo: cooldownByProvider.shipinfo.spent,
    },
    vesselFinderRelativeAge,
    vesselFinderProbeMetrics,
  };
}

// ---------------------------------------------------------------------------
//  Resolution (observations -> canonical)
// ---------------------------------------------------------------------------

async function resolveAll(
  container: Container,
  vessels: readonly SampledVessel[],
  concurrency: number
): Promise<{ resolved: number; failed: number; errors: string[] }> {
  let index = 0;
  let resolved = 0;
  let failed = 0;
  const errors: string[] = [];

  async function worker(): Promise<void> {
    while (index < vessels.length) {
      const vessel = vessels[index++];
      try {
        await container.resolveAndStoreCurrentVessel.execute({ mmsi: vessel.mmsi });
        resolved += 1;
      } catch (err) {
        failed += 1;
        if (errors.length < 20) errors.push(`${vessel.mmsi}: ${(err as Error).message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, vessels.length || 1)) }, () => worker())
  );
  return { resolved, failed, errors };
}

// ---------------------------------------------------------------------------
//  Measurement — read back what actually landed in the pipeline
// ---------------------------------------------------------------------------

interface MeasuredVessel {
  vessel: SampledVessel;
  byProvider: Record<ProviderKey, VesselBasicsSample>;
  canonical: VesselBasicsSample;
  canonicalGroups: { identity: boolean; position: boolean; particulars: boolean; voyage: boolean };
  canonicalSample: Record<string, unknown>;
}

function emptySample(mmsi: string): VesselBasicsSample {
  return {
    mmsi,
    vesselName: null,
    imo: null,
    vesselType: null,
    vesselTypeCode: null,
    lat: null,
    lon: null,
    course: null,
    speed: null,
    navStatusCode: null,
    navStatusText: null,
    observedAt: null,
    timestampDerivation: TimestampDerivation.NO_SOURCE_TIME,
  };
}

function applyIdentity(sample: VesselBasicsSample, identity: VesselIdentity): void {
  sample.vesselName = identity.name ?? sample.vesselName;
  sample.imo = identity.imo ?? sample.imo;
  sample.vesselType = identity.vesselType ?? sample.vesselType;
  sample.vesselTypeCode = identity.vesselTypeCode ?? sample.vesselTypeCode;
}

function applyPosition(
  sample: VesselBasicsSample,
  position: VesselPositionReport,
  sourceReceivedAt: Date | null | undefined
): void {
  sample.lat = position.lat ?? sample.lat;
  sample.lon = position.lng ?? sample.lon;
  sample.course = position.course ?? sample.course;
  sample.speed = position.speed ?? sample.speed;
  sample.navStatusCode = position.navStatus?.code ?? sample.navStatusCode;
  sample.navStatusText = position.navStatus?.text ?? sample.navStatusText;
  sample.imo = sample.imo ?? position.imo ?? null;
  if (sourceReceivedAt instanceof Date && Number.isFinite(sourceReceivedAt.getTime())) {
    sample.observedAt = sourceReceivedAt;
    sample.timestampDerivation = TimestampDerivation.ABSOLUTE_SOURCE_TIME;
  }
}

async function measure(
  container: Container,
  vessels: readonly SampledVessel[],
  vesselFinderRelativeAge: Map<string, { observedAt: Date; ageMinutes: number }>
): Promise<MeasuredVessel[]> {
  const measured: MeasuredVessel[] = [];

  for (const vessel of vessels) {
    const key = { mmsi: vessel.mmsi };
    const [identityObs, positionObs] = await Promise.all([
      container.observationRepository.findLatestPerSourceByVesselAndType(
        key,
        VesselObservationType.IDENTITY
      ),
      container.observationRepository.findLatestPerSourceByVesselAndType(
        key,
        VesselObservationType.POSITION
      ),
    ]);

    const byProvider = {
      vesselfinder: emptySample(vessel.mmsi),
      shipfinder: emptySample(vessel.mmsi),
      shipinfo: emptySample(vessel.mmsi),
    } as Record<ProviderKey, VesselBasicsSample>;

    const providerOf = (observation: VesselSourceObservation): ProviderKey | null => {
      const hit = PROVIDER_KEYS.find((p) => PROVIDER_SOURCE[p] === observation.source);
      return hit ?? null;
    };

    for (const observation of identityObs) {
      const provider = providerOf(observation);
      if (!provider || observation.type !== VesselObservationType.IDENTITY) continue;
      applyIdentity(byProvider[provider], observation.data);
    }
    for (const observation of positionObs) {
      const provider = providerOf(observation);
      if (!provider || observation.type !== VesselObservationType.POSITION) continue;
      applyPosition(byProvider[provider], observation.data, observation.sourceReceivedAt);
    }

    // VesselFinder only: the source exposes a RELATIVE age, which the production
    // mapper refuses. Classify the source honestly without pretending the
    // pipeline stored it.
    const relative = vesselFinderRelativeAge.get(vessel.mmsi);
    if (
      relative &&
      byProvider.vesselfinder.timestampDerivation === TimestampDerivation.NO_SOURCE_TIME
    ) {
      byProvider.vesselfinder.observedAt = relative.observedAt;
      byProvider.vesselfinder.timestampDerivation = TimestampDerivation.RELATIVE_SOURCE_AGE;
    }

    const doc = (await CurrentVesselModel.findOne({ mmsi: vessel.mmsi }).lean()) as
      | Record<string, any>
      | null;

    const canonical = emptySample(vessel.mmsi);
    const canonicalGroups = {
      identity: Boolean(doc?.identity),
      position: Boolean(doc?.position),
      particulars: Boolean(doc?.particulars),
      voyage: Boolean(doc?.voyage),
    };
    if (doc?.identity) {
      canonical.vesselName = doc.identity.name?.value ?? null;
      canonical.imo = doc.identity.imo?.value ?? doc.imo ?? null;
      canonical.vesselType = doc.identity.vesselType?.value ?? null;
      canonical.vesselTypeCode = doc.identity.vesselTypeCode?.value ?? null;
    }
    if (doc?.position?.position) {
      const p = doc.position.position;
      canonical.lat = typeof p.lat === "number" ? p.lat : null;
      canonical.lon = typeof p.lng === "number" ? p.lng : null;
      canonical.course = typeof p.course === "number" ? p.course : null;
      canonical.speed = typeof p.speed === "number" ? p.speed : null;
      canonical.navStatusCode = p.navStatus?.code ?? null;
      canonical.navStatusText = p.navStatus?.text ?? null;
      const observedAt = doc.position.observedAt;
      if (observedAt instanceof Date && Number.isFinite(observedAt.getTime())) {
        canonical.observedAt = observedAt;
        canonical.timestampDerivation = TimestampDerivation.ABSOLUTE_SOURCE_TIME;
      }
    }

    measured.push({
      vessel,
      byProvider,
      canonical,
      canonicalGroups,
      canonicalSample: {
        region: vessel.region,
        subRegion: vessel.subRegion,
        mmsi: vessel.mmsi,
        imo: canonical.imo,
        vesselName: canonical.vesselName,
        vesselType: canonical.vesselType,
        lat: canonical.lat,
        lon: canonical.lon,
        course: canonical.course,
        speed: canonical.speed,
        navStatus: canonical.navStatusCode ?? canonical.navStatusText,
        observedAt: canonical.observedAt ? canonical.observedAt.toISOString() : null,
        positionSource: doc?.position?.source ?? null,
        positionFreshness: doc?.position?.freshness ?? null,
        resolvedAt: doc?.resolvedAt ? new Date(doc.resolvedAt).toISOString() : null,
      },
    });
  }

  return measured;
}

// ---------------------------------------------------------------------------
//  Database proof (§27)
// ---------------------------------------------------------------------------

async function databaseProof(
  dbName: string,
  sampledMmsis: readonly string[]
): Promise<Record<string, unknown>> {
  const [observations, canonical, withPosition, withIdentity, withParticulars, withVoyage] =
    await Promise.all([
      VesselObservationModel.countDocuments(),
      CurrentVesselModel.countDocuments(),
      CurrentVesselModel.countDocuments({ position: { $ne: null } }),
      CurrentVesselModel.countDocuments({ identity: { $ne: null } }),
      CurrentVesselModel.countDocuments({ particulars: { $ne: null } }),
      CurrentVesselModel.countDocuments({ voyage: { $ne: null } }),
    ]);

  // The proof database is shared with earlier runs of this same phase, so the
  // collection-wide totals above are cumulative. These counts are scoped to the
  // vessels THIS run sampled — that is the number §27 is asking about.
  const inSample = { mmsi: { $in: [...sampledMmsis] } };
  const [
    sampleObservations,
    sampleCanonical,
    samplePosition,
    sampleIdentity,
    sampleParticulars,
    sampleVoyage,
  ] = await Promise.all([
    VesselObservationModel.countDocuments(inSample),
    CurrentVesselModel.countDocuments(inSample),
    CurrentVesselModel.countDocuments({ ...inSample, position: { $ne: null } }),
    CurrentVesselModel.countDocuments({ ...inSample, identity: { $ne: null } }),
    CurrentVesselModel.countDocuments({ ...inSample, particulars: { $ne: null } }),
    CurrentVesselModel.countDocuments({ ...inSample, voyage: { $ne: null } }),
  ]);

  const bySource = await VesselObservationModel.aggregate([
    { $group: { _id: { source: "$source", type: "$type" }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);

  return {
    database: dbName,
    vessel_observations: observations,
    canonical_current_vessels: canonical,
    canonicalWithPosition: withPosition,
    canonicalWithIdentity: withIdentity,
    canonicalWithParticulars: withParticulars,
    canonicalWithVoyage: withVoyage,
    sampledVessels: {
      mmsiCount: sampledMmsis.length,
      vessel_observations: sampleObservations,
      canonical_current_vessels: sampleCanonical,
      canonicalWithPosition: samplePosition,
      canonicalWithIdentity: sampleIdentity,
      canonicalWithParticulars: sampleParticulars,
      canonicalWithVoyage: sampleVoyage,
    },
    observationsBySourceAndType: bySource.map((row: any) => ({
      source: row._id.source,
      type: row._id.type,
      count: row.n,
    })),
  };
}

// ---------------------------------------------------------------------------
//  Report assembly
// ---------------------------------------------------------------------------

function reportsDir(): string {
  const dir = path.join(process.cwd(), "docs", "reports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(name: string, payload: unknown): string {
  const file = path.join(reportsDir(), name);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

function writeText(name: string, lines: readonly string[]): string {
  const file = path.join(reportsDir(), name);
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stage = (flag(args, "stage") ?? "A").toUpperCase();
  if (stage !== "A" && stage !== "B") throw new Error("--stage must be A or B");

  const perRegion = flagInt(args, "n", stage === "B" ? 100 : 30);
  const maxSubRegions = flagInt(args, "max-subregions", PROOF_SUB_REGIONS.length);
  const resetCheckpoint = args.includes("--reset-checkpoint");
  const discoveryOnly = args.includes("--discovery-only");
  const resolveConcurrency = flagInt(args, "resolve-concurrency", 4);
  const vesselFinderTimestampProbe = flagBool(args, "vf-timestamp-probe", true);
  const maxCooldownWaits = flagInt(args, "max-cooldown-waits", 2);
  const providers = (flag(args, "providers") ?? PROVIDER_KEYS.join(","))
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ProviderKey => (PROVIDER_KEYS as readonly string[]).includes(s));

  // ---- safety gates ------------------------------------------------------
  if (!isProofModeEnabled()) {
    throw new Error("Set BOT_DATA_PROOF_MODE=true to run this proof.");
  }
  if (!loadedConfig.mongoUri) throw new Error("MONGODB_URI is required.");
  const { dbName } = assertSafeBotDatabase({ mongoUri: loadedConfig.mongoUri, proofMode: true });
  if (loadedConfig.botAisEnabled) throw new Error("BOT_AIS_ENABLED must be false for this proof.");
  if (loadedConfig.paidFallbackEnabled) {
    throw new Error("PAID_FALLBACK_ENABLED must be false for this proof.");
  }

  const resources = new ResourceTracker();
  const startedAt = new Date();
  const t0 = Date.now();

  const container = await buildContainer({ connectMongo: true });
  if (container.providerRegistry.get(VesselSource.MYSHIPTRACKING) !== undefined) {
    throw new Error("MyShipTracking provider is registered — paid lane must be absent in proof mode.");
  }

  console.log("\n========== REGIONAL DATA PROOF 1 ==========");
  console.log(`stage=${stage} perRegion=${perRegion} providers=${providers.join(",")}`);
  console.log(`database=${dbName} ais=false paid=false myShipTrackingProvider=absent`);
  console.log(`subRegions=${PROOF_SUB_REGIONS.length} vfTimestampProbe=${vesselFinderTimestampProbe}`);
  console.log("===========================================\n");

  const discoveryCooldown = new CooldownBudget(maxCooldownWaits);
  const discovery = await runDiscovery(container, {
    perRegion,
    resetCheckpoint,
    maxSubRegions,
    cooldown: discoveryCooldown,
    resources,
  });

  if (discoveryOnly) {
    console.log(
      `\n[discovery-only] resumedFrom=${discovery.resumedFromIndex} completed=${discovery.completedIndex}/${PROOF_SUB_REGIONS.length}`
    );
    console.log(JSON.stringify(discovery.subRegions, null, 2));
    await mongoose.disconnect().catch(() => undefined);
    return;
  }

  // A run with no sample cannot measure anything. Fail loudly instead of
  // writing a report full of zeros that reads like "the sources have no data".
  if (discovery.vessels.length === 0) {
    throw new Error(
      "Discovery produced no vessels — every sub-region failed. " +
        `Outcomes: ${discovery.subRegions.map((s) => `${s.subRegion}=${s.outcome}`).join(" ")}`
    );
  }

  const probe = await runProbe(container, discovery.vessels, {
    providers,
    vesselFinderTimestampProbe,
    maxCooldownWaits,
    resources,
  });

  const resolution = await resolveAll(container, discovery.vessels, resolveConcurrency);
  const measured = await measure(container, discovery.vessels, probe.vesselFinderRelativeAge);
  const database = await databaseProof(dbName, discovery.vessels.map((v) => v.mmsi));
  const durationMs = Date.now() - t0;

  // ---- matrices ----------------------------------------------------------
  const regionalMatrix: Record<string, CoverageBlock> = {};
  for (const region of PROOF_REGIONS) {
    const subset = measured.filter((m) => m.vessel.region === region).map((m) => m.canonical);
    regionalMatrix[region] = coverageBlock(subset);
  }
  regionalMatrix.ALL = coverageBlock(measured.map((m) => m.canonical));

  const providerMatrix: Record<string, CoverageBlock> = {};
  for (const provider of PROVIDER_KEYS) {
    providerMatrix[provider] = coverageBlock(measured.map((m) => m.byProvider[provider]));
  }
  providerMatrix.combined = regionalMatrix.ALL;

  const providerMatrixByRegion: Record<string, Record<string, CoverageBlock>> = {};
  for (const region of PROOF_REGIONS) {
    const subset = measured.filter((m) => m.vessel.region === region);
    providerMatrixByRegion[region] = {};
    for (const provider of PROVIDER_KEYS) {
      providerMatrixByRegion[region][provider] = coverageBlock(
        subset.map((m) => m.byProvider[provider])
      );
    }
    providerMatrixByRegion[region].combined = coverageBlock(subset.map((m) => m.canonical));
  }

  // ---- timestamp derivation (§21) ---------------------------------------
  const derivationByProvider: Record<string, Record<TimestampDerivation, number>> = {};
  for (const provider of PROVIDER_KEYS) {
    const counts = {
      ABSOLUTE_SOURCE_TIME: 0,
      RELATIVE_SOURCE_AGE: 0,
      NO_SOURCE_TIME: 0,
    } as Record<TimestampDerivation, number>;
    for (const m of measured) counts[m.byProvider[provider].timestampDerivation] += 1;
    derivationByProvider[provider] = counts;
  }
  derivationByProvider.canonical = measured.reduce(
    (acc, m) => {
      acc[m.canonical.timestampDerivation] += 1;
      return acc;
    },
    {
      ABSOLUTE_SOURCE_TIME: 0,
      RELATIVE_SOURCE_AGE: 0,
      NO_SOURCE_TIME: 0,
    } as Record<TimestampDerivation, number>
  );

  // ---- request metrics (§25) --------------------------------------------
  const requestRows: { scope: string; summary: RequestMetricsSummary }[] = [];
  for (const region of PROOF_REGIONS) {
    requestRows.push({
      scope: `discovery/${region}`,
      summary: summarizeRequests(discovery.metricsByRegion[region]),
    });
  }
  for (const provider of PROVIDER_KEYS) {
    for (const region of PROOF_REGIONS) {
      const metrics = probe.metricsByRegionProvider[`${region}/${provider}`];
      if (metrics) {
        requestRows.push({ scope: `${region}/${provider}`, summary: summarizeRequests(metrics) });
      }
    }
    requestRows.push({
      scope: `ALL/${provider}`,
      summary: summarizeRequests(probe.metricsByProvider[provider]),
    });
  }
  if (vesselFinderTimestampProbe) {
    requestRows.push({
      scope: "ALL/vesselfinder-timestamp-probe",
      summary: summarizeRequests(probe.vesselFinderProbeMetrics),
    });
  }

  // ---- operational (§32) -------------------------------------------------
  const totalRequests = requestRows.reduce((n, r) => n + r.summary.requests, 0);
  const usage = resources.snapshot();
  const minutes = durationMs / 60_000;
  const operational = {
    durationMs,
    totalRequests,
    vessels: discovery.vessels.length,
    requestsPerVessel:
      discovery.vessels.length > 0
        ? Math.round((totalRequests / discovery.vessels.length) * 100) / 100
        : 0,
    vesselsPerMinute: minutes > 0 ? Math.round((discovery.vessels.length / minutes) * 10) / 10 : 0,
    ...usage,
  };

  // ---- source health, straight from the crawl runtime --------------------
  // The runtime counts every FAILED ATTEMPT, including the retried attempts that
  // never surface as a caller-visible error. Without this a source can enter
  // cooldown while the per-request table shows zero failures.
  const sourceHealth: Record<string, unknown> = {};
  for (const provider of PROVIDER_KEYS) {
    sourceHealth[provider] = container.crawlRuntime.getHealth(PROVIDER_SOURCE[provider]);
  }

  // ---- Stage B gate (§15) ------------------------------------------------
  const severeByProvider: Record<string, number> = {};
  let severeTotal = 0;
  for (const provider of PROVIDER_KEYS) {
    const n = severeBlockCount(summarizeRequests(probe.metricsByProvider[provider]));
    severeByProvider[provider] = n;
    severeTotal += n;
  }
  const cooldownTotal =
    PROVIDER_KEYS.reduce((n, p) => n + probe.cooldownWaitsByProvider[p], 0) +
    discoveryCooldown.spent;
  const stageBEligible =
    severeTotal === 0 && probe.stoppedProviders.length === 0 && cooldownTotal === 0;

  // ---- samples (§28) + manifest (§26) -----------------------------------
  const canonicalSamples: Record<string, unknown[]> = {};
  for (const region of PROOF_REGIONS) {
    canonicalSamples[region] = measured
      .filter((m) => m.vessel.region === region && m.canonicalGroups.position)
      .slice(0, 5)
      .map((m) => m.canonicalSample);
  }

  const manifest = measured.map((m) => ({
    region: m.vessel.region,
    subRegion: m.vessel.subRegion,
    mmsi: m.vessel.mmsi,
    imo: m.canonical.imo,
    vesselName: m.canonical.vesselName,
    discoverySource: m.vessel.discoverySource,
  }));

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const report = {
    meta: {
      phase: "REGIONAL-DATA-PROOF-1",
      stage,
      baselineCommit: process.env.GIT_COMMIT ?? "e715ce6f06ffcb84677ffaf720e9b414096cb2ea",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs,
      database: dbName,
      aisEnabled: loadedConfig.botAisEnabled,
      paidFallbackEnabled: loadedConfig.paidFallbackEnabled,
      myShipTrackingProviderRegistered: false,
      myShipTrackingCalls: 0,
      canonicalWrittenViaResolver: true,
      providers,
      vesselFinderTimestampProbe,
    },
    regions: PROOF_SUB_REGIONS,
    discovery: {
      subRegions: discovery.subRegions,
      resumedFromIndex: discovery.resumedFromIndex,
      completedIndex: discovery.completedIndex,
      sampleSize: {
        US: discovery.vessels.filter((v) => v.region === "US").length,
        UK: discovery.vessels.filter((v) => v.region === "UK").length,
        NORWAY: discovery.vessels.filter((v) => v.region === "NORWAY").length,
        total: discovery.vessels.length,
        uniqueMmsi: new Set(discovery.vessels.map((v) => v.mmsi)).size,
      },
    },
    requestMetrics: Object.fromEntries(requestRows.map((r) => [r.scope, r.summary])),
    vesselBasicsRegionalMatrix: regionalMatrix,
    providerMatrix,
    providerMatrixByRegion,
    timestampDerivation: derivationByProvider,
    resolution,
    database,
    canonicalSamples,
    operational,
    sourceHealth,
    stageBGate: {
      eligible: stageBEligible,
      severeByProvider,
      stopped: probe.stoppedProviders,
      cooldownWaitsByProvider: probe.cooldownWaitsByProvider,
      cooldownWaitsDiscovery: discoveryCooldown.spent,
    },
    probeRows: probe.rows,
  };

  const jsonPath = writeJson(`regional-data-proof-${stage}-${stamp}.json`, report);
  const manifestPath = writeJson(`regional-data-proof-${stage}-${stamp}-manifest.json`, manifest);

  // ---- markdown ----------------------------------------------------------
  const md: string[] = [];
  md.push(`# REGIONAL-DATA-PROOF-1 — Stage ${stage}`);
  md.push("");
  md.push(`- Database: \`${dbName}\` · AIS **off** · paid fallback **off** · MyShipTracking calls **0**`);
  md.push(`- Duration: ${durationMs} ms · vessels: ${discovery.vessels.length}`);
  md.push(
    `- Sample: US=${report.discovery.sampleSize.US} UK=${report.discovery.sampleSize.UK} ` +
      `NORWAY=${report.discovery.sampleSize.NORWAY} (unique MMSI ${report.discovery.sampleSize.uniqueMmsi})`
  );
  md.push(
    `- Stage B eligible: **${stageBEligible ? "yes" : "no"}** ` +
      `(severe blocks: ${severeTotal}, cooldown waits: ${cooldownTotal}, ` +
      `stopped lanes: ${probe.stoppedProviders.join(",") || "none"})`
  );
  md.push("");
  md.push("## VESSELBASICS COVERAGE — canonical, by region (§29)");
  md.push("");
  md.push(...renderRegionalMatrix(regionalMatrix, [...PROOF_REGIONS, "ALL"]));
  md.push("");
  md.push("## PROVIDER MATRIX — observations per source (§30)");
  md.push("");
  md.push(...renderProviderMatrix(providerMatrix, [...PROVIDER_KEYS, "combined"]));
  md.push("");
  for (const region of PROOF_REGIONS) {
    md.push(`### ${region}`);
    md.push("");
    md.push(...renderProviderMatrix(providerMatrixByRegion[region], [...PROVIDER_KEYS, "combined"]));
    md.push("");
  }
  md.push("## Classification — canonical, all regions (§31)");
  md.push("");
  md.push(...renderClassificationTable(regionalMatrix.ALL));
  md.push("");
  md.push("## Request metrics (§25)");
  md.push("");
  md.push(...renderRequestMetricsTable(requestRows));
  md.push("");
  md.push("> HTTP 404 is folded into `notFound` by the shared crawl runtime, which classifies");
  md.push("> both a 404 and a provider-returned `null` as `NOT_FOUND`.");
  md.push("");
  md.push("## Source health — crawl runtime counters");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(sourceHealth, null, 2));
  md.push("```");
  md.push("");
  md.push("## Timestamp derivation (§21)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(derivationByProvider, null, 2));
  md.push("```");
  md.push("");
  md.push("## Database proof (§27)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(database, null, 2));
  md.push("```");
  md.push("");
  md.push("## Operational (§32)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(operational, null, 2));
  md.push("```");
  md.push("");
  md.push("## Canonical samples (§28)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(canonicalSamples, null, 2));
  md.push("```");
  const mdPath = writeText(`regional-data-proof-${stage}-${stamp}.md`, md);

  console.log("\n" + md.join("\n"));
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${manifestPath}`);
  console.log(`Wrote ${mdPath}`);

  await mongoose.disconnect().catch(() => undefined);
}

void main().catch(async (err) => {
  console.error(`\nFATAL: ${(err as Error).message}`);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
