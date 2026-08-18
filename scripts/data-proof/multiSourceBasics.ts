/**
 * PHASE 3.3 — MULTI-SOURCE RESILIENCE / REAL VESSELBASICS MATRIX.
 *
 *   --mode=manifest   build a real 30-per-region sample from observations already
 *                     collected by live VesselFinder map scans (§9 prefers the
 *                     database over new traffic)
 *   --mode=probe      probe each provider IN ISOLATION through the existing
 *                     per-source crawl runtime, persisting via the real pipeline
 *   --mode=report     compute every matrix and write docs/reports/*.md + .json
 *
 * Providers are measured independently (§14) — nothing is merged before the
 * per-provider numbers exist. All coverage is computed from what actually landed
 * in `vessel_observations`, never from a diagnostic parser.
 *
 * §10 — `--without=vesselfinder` marks a source unavailable for PROOF purposes
 * only. The provider is never removed and the capability matrix is never faked.
 *
 * This script ORCHESTRATES and REPORTS. Parsing, validation, resolution and
 * persistence are production code.
 */
import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";

import { ObservationRecorder } from "../../src/application/services/observation/ObservationRecorder";
import { SourceRuntimeManager } from "../../src/application/services/crawl-runtime/SourceRuntimeManager";
import { ProviderRegistry } from "../../src/application/services/acquisition/ProviderRegistry";
import { getProviderOperations, ProviderOperation } from "../../src/application/contracts/providers/VesselDataProvider";
import { ProviderDetailsResult } from "../../src/application/contracts/providers/ProviderResults";
import {
  SourceErrorCategory,
  SourceRequestError,
  SourceUnavailableError,
} from "../../src/application/services/crawl-runtime/SourceError";
import { SHIPFINDER_PARSER_VERSION } from "../../src/infrastructure/integrations/shipfinder/ShipFinderParser";
import { SHIPINFO_PARSER_VERSION } from "../../src/infrastructure/integrations/shipinfo/ShipInfoParser";
import { assertSafeBotDatabase, isProofModeEnabled } from "../../src/config/databaseSafety";
import { config as loadedConfig } from "../../src/config";
import { mmsiIdentifier } from "../../src/domain/value-objects/VesselIdentifier";
import { isValidImo, isValidMmsi } from "../../src/domain/validators/identifiers";
import { isValidCoordinates } from "../../src/domain/validators/geo";
import { isValidCourse, isValidSpeed } from "../../src/domain/validators/motion";
import { VesselObservationType } from "../../src/domain/entities/VesselObservation";
import { VesselSource } from "../../src/domain/enums/VesselSource";
import { connectMongo } from "../../src/infrastructure/persistence/mongo/connection";
import { MongoVesselObservationRepository } from "../../src/infrastructure/persistence/mongo/MongoVesselObservationRepository";
import { HttpClient } from "../../src/infrastructure/http/HttpClient";
import { ShipFinderClient } from "../../src/infrastructure/integrations/shipfinder/ShipFinderClient";
import { ShipFinderProvider } from "../../src/infrastructure/integrations/shipfinder/ShipFinderProvider";
import { ShipInfoClient } from "../../src/infrastructure/integrations/shipinfo/ShipInfoClient";
import { ShipInfoProvider } from "../../src/infrastructure/integrations/shipinfo/ShipInfoProvider";
import { VesselFinderHtmlSource } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderHtmlSource";
import { VesselFinderMapSource } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderMapSource";
import { VesselFinderProvider } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderProvider";

import { PROOF_REGIONS, PROOF_SUB_REGIONS, ProofRegion } from "./regions";

const SAMPLE_COLLECTION = "multi-source-sample";
type ProviderKey = "vesselfinder" | "shipfinder" | "shipinfo";
const PROVIDERS: readonly ProviderKey[] = ["vesselfinder", "shipfinder", "shipinfo"];
const SOURCE_OF: Record<ProviderKey, VesselSource> = {
  vesselfinder: VesselSource.VESSELFINDER,
  shipfinder: VesselSource.SHIPFINDER,
  shipinfo: VesselSource.SHIPINFO,
};

interface SampleVessel {
  mmsi: string;
  region: ProofRegion;
  subRegion: string;
}

// ---------------------------------------------------------------------------
//  metrics
// ---------------------------------------------------------------------------

interface Metrics {
  requests: number;
  outcomes: Record<string, number>;
  latenciesMs: number[];
}
const newMetrics = (): Metrics => ({ requests: 0, outcomes: {}, latenciesMs: [] });

function record(m: Metrics, outcome: string, latencyMs: number): void {
  m.outcomes[outcome] = (m.outcomes[outcome] ?? 0) + 1;
  if (outcome !== "cooldown") {
    m.requests += 1;
    if (latencyMs > 0) m.latenciesMs.push(latencyMs);
  }
}

function classify(err: unknown): string {
  if (err instanceof SourceUnavailableError) return "cooldown";
  if (err instanceof SourceRequestError) {
    switch (err.category) {
      case SourceErrorCategory.BLOCKED: return "403";
      case SourceErrorCategory.RATE_LIMITED: return "429";
      case SourceErrorCategory.TIMEOUT: return "timeout";
      case SourceErrorCategory.SERVER_ERROR: return "5xx";
      case SourceErrorCategory.NETWORK_ERROR: return "networkError";
      case SourceErrorCategory.NOT_FOUND: return "notFound";
      case SourceErrorCategory.PARSE_ERROR: return "parseError";
      default: return "unknown";
    }
  }
  return "unknown";
}

const percentile = (v: readonly number[], p: number): number | null => {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

const summarize = (m: Metrics) => ({
  requests: m.requests,
  outcomes: m.outcomes,
  avgLatencyMs: m.latenciesMs.length
    ? Math.round(m.latenciesMs.reduce((a, b) => a + b, 0) / m.latenciesMs.length)
    : null,
  p95LatencyMs: percentile(m.latenciesMs, 95),
});

// ---------------------------------------------------------------------------
//  field measurement — computed from PERSISTED observations only
// ---------------------------------------------------------------------------

/** §17 — a placeholder label is NOT coverage. */
const PLACEHOLDER = new Set(["", "-", "--", "---", "n/a", "na", "unknown", "undefined"]);
const usableText = (v: unknown): boolean =>
  typeof v === "string" && !PLACEHOLDER.has(v.trim().toLowerCase());

interface Basics {
  vesselName: boolean;
  mmsi: boolean;
  imo: boolean;
  /** §16 — numeric AIS type only. Text does NOT count. */
  vTypeNumeric: boolean;
  vesselTypeText: boolean;
  lat: boolean;
  lon: boolean;
  latLon: boolean;
  course: boolean;
  speed: boolean;
  navStatusText: boolean;
  navStatusCode: boolean;
  /** §18 — source observation time. `fetchedAt` alone never counts. */
  received: boolean;
  observedAt: Date | null;
  ageMinutes: number | null;
}

const emptyBasics = (): Basics => ({
  vesselName: false, mmsi: false, imo: false, vTypeNumeric: false, vesselTypeText: false,
  lat: false, lon: false, latLon: false, course: false, speed: false,
  navStatusText: false, navStatusCode: false, received: false, observedAt: null, ageMinutes: null,
});

const BASICS_ROWS: readonly (keyof Basics)[] = [
  "vesselName", "mmsi", "imo", "vTypeNumeric", "vesselTypeText",
  "lat", "lon", "latLon", "course", "speed", "navStatusText", "navStatusCode", "received",
];

/** §19 freshness buckets. */
const BUCKETS = ["<=5m", "5-15m", "15-30m", "30-60m", "1-6h", "6-24h", ">24h", "unknown"] as const;
function bucketOf(ageMinutes: number | null): (typeof BUCKETS)[number] {
  if (ageMinutes === null) return "unknown";
  if (ageMinutes <= 5) return "<=5m";
  if (ageMinutes <= 15) return "5-15m";
  if (ageMinutes <= 30) return "15-30m";
  if (ageMinutes <= 60) return "30-60m";
  if (ageMinutes <= 360) return "1-6h";
  if (ageMinutes <= 1440) return "6-24h";
  return ">24h";
}

async function measure(
  repo: MongoVesselObservationRepository,
  vessels: readonly SampleVessel[],
  now: Date
): Promise<Map<ProviderKey, Map<string, Basics>>> {
  const out = new Map<ProviderKey, Map<string, Basics>>(
    PROVIDERS.map((p) => [p, new Map<string, Basics>()])
  );

  for (const vessel of vessels) {
    const key = { mmsi: vessel.mmsi };
    const [identity, position] = await Promise.all([
      repo.findLatestPerSourceByVesselAndType(key, VesselObservationType.IDENTITY, { maxPerSource: 1 }),
      repo.findLatestPerSourceByVesselAndType(key, VesselObservationType.POSITION, { maxPerSource: 4 }),
    ]);

    for (const provider of PROVIDERS) out.get(provider)!.set(vessel.mmsi, emptyBasics());

    for (const observation of identity) {
      const provider = PROVIDERS.find((p) => SOURCE_OF[p] === observation.source);
      if (!provider || observation.type !== VesselObservationType.IDENTITY) continue;
      const b = out.get(provider)!.get(vessel.mmsi)!;
      const d = observation.data;
      b.mmsi = b.mmsi || isValidMmsi(d.mmsi);
      b.vesselName = b.vesselName || usableText(d.name);
      b.imo = b.imo || isValidImo(d.imo);
      b.vesselTypeText = b.vesselTypeText || usableText(d.vesselType);
      b.vTypeNumeric = b.vTypeNumeric || Number.isFinite(d.vesselTypeCode);
    }

    for (const observation of position) {
      const provider = PROVIDERS.find((p) => SOURCE_OF[p] === observation.source);
      if (!provider || observation.type !== VesselObservationType.POSITION) continue;
      const b = out.get(provider)!.get(vessel.mmsi)!;
      const d = observation.data;
      b.mmsi = b.mmsi || isValidMmsi(d.mmsi);
      b.lat = b.lat || Number.isFinite(d.lat);
      b.lon = b.lon || Number.isFinite(d.lng);
      b.latLon = b.latLon || isValidCoordinates(d.lat, d.lng);
      b.course = b.course || isValidCourse(d.course);
      b.speed = b.speed || isValidSpeed(d.speed);
      b.navStatusText = b.navStatusText || usableText(d.navStatus?.text);
      b.navStatusCode =
        b.navStatusCode ||
        (typeof d.navStatus?.code === "number" && d.navStatus.code >= 0 && d.navStatus.code <= 15);
      const src = observation.sourceReceivedAt;
      if (src instanceof Date && Number.isFinite(src.getTime())) {
        const age = Math.round((now.getTime() - src.getTime()) / 60_000);
        if (b.observedAt === null || src > b.observedAt) {
          b.observedAt = src;
          b.ageMinutes = age;
        }
        b.received = true;
      }
    }
  }
  return out;
}

const pct = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((1000 * part) / whole) / 10;

function coverage(rows: readonly Basics[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const field of BASICS_ROWS) {
    out[field] = pct(rows.filter((r) => r[field] === true).length, rows.length);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  providers
// ---------------------------------------------------------------------------

function buildRegistry(runtime: SourceRuntimeManager) {
  const registry = new ProviderRegistry();
  const vfHttp = new HttpClient({ timeoutMs: runtime.getConfig(VesselSource.VESSELFINDER).timeoutMs });
  registry.register(
    new VesselFinderProvider({
      detailsSource: new VesselFinderHtmlSource(vfHttp),
      areaScanner: new VesselFinderMapSource(vfHttp),
    })
  );
  registry.register(
    new ShipFinderProvider({
      client: new ShipFinderClient({
        http: new HttpClient({ timeoutMs: runtime.getConfig(VesselSource.SHIPFINDER).timeoutMs }),
      }),
      // Deliberately passes whatever the operator configured — unset means the
      // provider suppresses its position group (§12). Not overridden here.
      sourceUtcOffsetMinutes: loadedConfig.shipFinderSourceUtcOffsetMinutes,
    })
  );
  registry.register(
    new ShipInfoProvider({
      client: new ShipInfoClient({
        http: new HttpClient({ timeoutMs: runtime.getConfig(VesselSource.SHIPINFO).timeoutMs }),
      }),
    })
  );
  return registry;
}

// ---------------------------------------------------------------------------
//  modes
// ---------------------------------------------------------------------------

function regionOf(lat: number, lon: number): { region: ProofRegion; subRegion: string } | null {
  for (const sub of PROOF_SUB_REGIONS) {
    const b = sub.box;
    if (lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon) {
      return { region: sub.region, subRegion: sub.name };
    }
  }
  return null;
}

async function buildManifest(perRegion: number): Promise<SampleVessel[]> {
  const rows = await mongoose.connection.db!
    .collection("vessel_observations")
    .aggregate<{ _id: string; lat: number; lng: number }>([
      { $match: { type: "POSITION", source: VesselSource.VESSELFINDER, validationStatus: { $ne: "INVALID" } } },
      { $sort: { fetchedAt: -1 } },
      { $group: { _id: "$mmsi", lat: { $first: "$data.lat" }, lng: { $first: "$data.lng" } } },
    ])
    .toArray();

  const byRegion = new Map<ProofRegion, SampleVessel[]>(PROOF_REGIONS.map((r) => [r, []]));
  for (const row of rows) {
    if (!isValidMmsi(row._id)) continue;
    const hit = regionOf(row.lat, row.lng);
    if (hit === null) continue;
    const bucket = byRegion.get(hit.region)!;
    if (bucket.length >= perRegion) continue;
    bucket.push({ mmsi: row._id, region: hit.region, subRegion: hit.subRegion });
  }

  const sample = PROOF_REGIONS.flatMap((r) => byRegion.get(r)!);
  await mongoose.connection.db!.collection(SAMPLE_COLLECTION).deleteMany({});
  if (sample.length > 0) {
    await mongoose.connection.db!.collection(SAMPLE_COLLECTION).insertMany(sample.map((s) => ({ ...s })));
  }
  return sample;
}

const loadManifest = async (): Promise<SampleVessel[]> =>
  (await mongoose.connection.db!.collection(SAMPLE_COLLECTION).find({}).toArray()) as never;

interface ProbeOutcome {
  metrics: Record<ProviderKey, ReturnType<typeof summarize>>;
  /** §12 — how often ShipFinder produced NO position group at all. */
  positionGroupMissing: Record<ProviderKey, number>;
  recorded: Record<ProviderKey, number>;
}

async function probe(
  vessels: readonly SampleVessel[],
  providers: readonly ProviderKey[],
  disabled: ReadonlySet<ProviderKey>
): Promise<ProbeOutcome> {
  const runtime = new SourceRuntimeManager();
  const registry = buildRegistry(runtime);
  const repository = new MongoVesselObservationRepository();
  const recorder = new ObservationRecorder({ repository });
  // ObservationRecorder carries ONE default parser version; the per-source table
  // belongs to CollectVesselObservations. Pass the right version per call instead.
  const parserVersionOf: Record<ProviderKey, string | undefined> = {
    vesselfinder: "vesselfinder-html-v1",
    shipfinder: SHIPFINDER_PARSER_VERSION,
    shipinfo: SHIPINFO_PARSER_VERSION,
  };

  const metrics = {} as Record<ProviderKey, Metrics>;
  const positionGroupMissing = {} as Record<ProviderKey, number>;
  const recorded = {} as Record<ProviderKey, number>;
  for (const p of PROVIDERS) {
    metrics[p] = newMetrics();
    positionGroupMissing[p] = 0;
    recorded[p] = 0;
  }

  async function lane(provider: ProviderKey): Promise<void> {
    if (disabled.has(provider)) {
      console.log(`[probe] ${provider} SKIPPED — marked unavailable for this proof run (§10)`);
      return;
    }
    const source = SOURCE_OF[provider];
    const impl = registry.get(source);
    if (impl === undefined || impl.getDetails === undefined) return;
    const executor = runtime.getExecutor(source);

    for (const vessel of vessels) {
      const startedAt = Date.now();
      try {
        const result = await executor.execute<ProviderDetailsResult | null>(
          () => impl.getDetails!(mmsiIdentifier(vessel.mmsi)),
          { operation: ProviderOperation.GET_DETAILS }
        );
        const latency = Date.now() - startedAt;
        if (result === null) {
          record(metrics[provider], "notFound", latency);
          continue;
        }
        record(metrics[provider], "200", latency);
        if (result.position === undefined) positionGroupMissing[provider] += 1;
        await recorder.recordDetails(result, { parserVersion: parserVersionOf[provider] });
        recorded[provider] += 1;
      } catch (err) {
        record(metrics[provider], classify(err), Date.now() - startedAt);
      }
    }
    console.log(
      `[probe] ${provider} done: ${JSON.stringify(summarize(metrics[provider]).outcomes)}`
    );
  }

  await Promise.all(providers.map((p) => lane(p)));

  const summarized = {} as Record<ProviderKey, ReturnType<typeof summarize>>;
  for (const p of PROVIDERS) summarized[p] = summarize(metrics[p]);
  return { metrics: summarized, positionGroupMissing, recorded };
}

// ---------------------------------------------------------------------------
//  report
// ---------------------------------------------------------------------------

function table(header: string, cols: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const out = [`### ${header}`, "", `| ${cols.join(" | ")} |`, `|${cols.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`];
  for (const r of rows) out.push(`| ${r.join(" | ")} |`);
  out.push("");
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.find((a) => a.startsWith("--mode="))?.slice(7) ?? "report";
  const perRegion = Number(args.find((a) => a.startsWith("--per-region="))?.slice(13) ?? 30);
  const without = new Set(
    (args.find((a) => a.startsWith("--without="))?.slice(10) ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean) as ProviderKey[]
  );
  const only = (args.find((a) => a.startsWith("--providers="))?.slice(12) ?? PROVIDERS.join(","))
    .split(",").map((s) => s.trim()).filter((s): s is ProviderKey => (PROVIDERS as readonly string[]).includes(s));

  if (!isProofModeEnabled()) throw new Error("Set BOT_DATA_PROOF_MODE=true");
  const { dbName } = assertSafeBotDatabase({ mongoUri: loadedConfig.mongoUri, proofMode: true });
  if (loadedConfig.botAisEnabled) throw new Error("BOT_AIS_ENABLED must be false");
  if (loadedConfig.paidFallbackEnabled) throw new Error("PAID_FALLBACK_ENABLED must be false");
  await connectMongo(loadedConfig.mongoUri);
  console.log(`db=${dbName} mode=${mode} ais=false paid=false`);

  if (mode === "manifest") {
    const sample = await buildManifest(perRegion);
    const dist: Record<string, number> = {};
    const subs: Record<string, number> = {};
    for (const s of sample) {
      dist[s.region] = (dist[s.region] ?? 0) + 1;
      subs[s.subRegion] = (subs[s.subRegion] ?? 0) + 1;
    }
    console.log(`manifest size=${sample.length} ${JSON.stringify(dist)}`);
    console.log(`sub-regions: ${JSON.stringify(subs)}`);
    await mongoose.disconnect();
    return;
  }

  const sample = await loadManifest();
  if (sample.length === 0) throw new Error("manifest empty — run --mode=manifest first");

  if (mode === "probe") {
    const outcome = await probe(sample, only, without);
    fs.writeFileSync(
      path.join(reportsDir(), `multi-source-probe-${stamp()}.json`),
      JSON.stringify({ sample: sample.length, disabled: [...without], ...outcome }, null, 2),
      "utf8"
    );
    console.log(JSON.stringify(outcome, null, 2));
    await mongoose.disconnect();
    return;
  }

  // ---- report --------------------------------------------------------------
  const now = new Date();
  const repo = new MongoVesselObservationRepository();
  const measured = await measure(repo, sample, now);
  const runtime = new SourceRuntimeManager();
  const registry = buildRegistry(runtime);

  const all = (p: ProviderKey) => sample.map((v) => measured.get(p)!.get(v.mmsi)!);
  const byRegion = (p: ProviderKey, r: ProofRegion) =>
    sample.filter((v) => v.region === r).map((v) => measured.get(p)!.get(v.mmsi)!);

  const md: string[] = [];
  md.push(`# PHASE 3.3 — MULTI-SOURCE VESSELBASICS MATRIX`, "");
  md.push(`- Database: \`${dbName}\` · AIS **off** · paid **off**`);
  md.push(`- Sample: **${sample.length}** vessels · ` +
    PROOF_REGIONS.map((r) => `${r}=${sample.filter((v) => v.region === r).length}`).join(" "));
  md.push(`- Measured at: ${now.toISOString()}`);
  md.push(`- All coverage computed from persisted \`vessel_observations\` (real pipeline), not from a diagnostic parser.`, "");

  // §6 runtime settings
  md.push(...table("Runtime settings per provider (§6)",
    ["provider", "timeout ms", "concurrency", "delay ms", "retries", "cooldown ms"],
    PROVIDERS.map((p) => {
      const c = runtime.getConfig(SOURCE_OF[p]);
      return [p, String(c.timeoutMs), String(c.maxConcurrency), `${c.minDelayMs}-${c.maxDelayMs}`, String(c.maxRetries), String(c.cooldownMs)];
    })));

  // §26 discovery capability
  md.push(...table("Discovery capability — CURRENT implementation (§26)",
    ["provider", "AREA SCAN", "MMSI lookup", "IMO lookup"],
    PROVIDERS.map((p) => {
      const impl = registry.get(SOURCE_OF[p])!;
      const ops = new Set(getProviderOperations(impl));
      const imo = p === "shipinfo" ? "yes" : "no";
      return [p, ops.has(ProviderOperation.SCAN_AREA) ? "**yes**" : "no",
        ops.has(ProviderOperation.GET_DETAILS) ? "yes" : "no", imo];
    })));

  // §20 raw coverage
  const cov = Object.fromEntries(PROVIDERS.map((p) => [p, coverage(all(p))]));
  md.push(...table("MATRIX 1 — raw VesselBasics field coverage (§20)",
    ["FIELD", "VesselFinder", "ShipFinder", "ShipInfo"],
    BASICS_ROWS.map((f) => [String(f), ...PROVIDERS.map((p) => `${cov[p][f]}%`)])));

  // §21 regional
  for (const p of PROVIDERS) {
    md.push(...table(`MATRIX 2 — ${p} regional coverage (§21)`,
      ["FIELD", ...PROOF_REGIONS, "ALL"],
      BASICS_ROWS.map((f) => [String(f),
        ...PROOF_REGIONS.map((r) => `${coverage(byRegion(p, r))[f]}%`),
        `${cov[p][f]}%`])));
  }

  // §19 freshness + §22 fresh usable
  md.push(...table("MATRIX 3a — position freshness distribution (§19)",
    ["provider", ...BUCKETS],
    PROVIDERS.map((p) => {
      const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<string, number>;
      for (const b of all(p)) counts[bucketOf(b.ageMinutes)] += 1;
      return [p, ...BUCKETS.map((b) => String(counts[b]))];
    })));

  md.push(...table("MATRIX 3b — fresh usable coverage, counts not percentages (§22)",
    ["provider", "window", "lat/lon", "speed", "course", "navStatus"],
    PROVIDERS.flatMap((p) =>
      [15, 30, 60].map((w) => {
        const fresh = all(p).filter((b) => b.ageMinutes !== null && b.ageMinutes <= w);
        return [p, `<=${w}m`,
          String(fresh.filter((b) => b.latLon).length),
          String(fresh.filter((b) => b.speed).length),
          String(fresh.filter((b) => b.course).length),
          String(fresh.filter((b) => b.navStatusText).length)];
      }))));

  // §23 fallback without VesselFinder — union of the two remaining sources,
  // per field, honouring that each field comes from its own honest observation.
  const fallback: Record<string, number> = {};
  for (const field of BASICS_ROWS) {
    const n = sample.filter((v) =>
      (["shipfinder", "shipinfo"] as ProviderKey[]).some((p) => measured.get(p)!.get(v.mmsi)![field] === true)
    ).length;
    fallback[field] = pct(n, sample.length);
  }
  const vfOnly: Record<string, number> = {};
  for (const field of BASICS_ROWS) {
    vfOnly[field] = cov.vesselfinder[field];
  }
  md.push(...table("MATRIX 4 — fallback with VesselFinder OFF (§23)",
    ["FIELD", "VF only (case A component)", "ShipFinder+ShipInfo (case B)"],
    BASICS_ROWS.map((f) => [String(f), `${vfOnly[f]}%`, `${fallback[f]}%`])));

  // §29 cases
  const caseCoverage = (allowed: readonly ProviderKey[]) => {
    const out: Record<string, number> = {};
    for (const field of BASICS_ROWS) {
      out[field] = pct(
        sample.filter((v) => allowed.some((p) => measured.get(p)!.get(v.mmsi)![field] === true)).length,
        sample.length
      );
    }
    return out;
  };
  const caseA = caseCoverage(PROVIDERS);
  const caseB = caseCoverage(["shipfinder", "shipinfo"]);
  const caseC = caseCoverage(["shipinfo"]);
  md.push(...table("Source failure simulation (§29)",
    ["FIELD", "A: all free", "B: no VesselFinder", "C: no VF + no ShipFinder"],
    BASICS_ROWS.map((f) => [String(f), `${caseA[f]}%`, `${caseB[f]}%`, `${caseC[f]}%`])));

  const json = {
    phase: "PHASE-3.3-MULTI-SOURCE",
    database: dbName,
    measuredAt: now.toISOString(),
    ais: false,
    paid: false,
    sample: { total: sample.length, byRegion: Object.fromEntries(PROOF_REGIONS.map((r) => [r, sample.filter((v) => v.region === r).length])) },
    shipFinderUtcOffsetConfigured: loadedConfig.shipFinderSourceUtcOffsetMinutes ?? null,
    runtime: Object.fromEntries(PROVIDERS.map((p) => [p, runtime.getConfig(SOURCE_OF[p])])),
    coverage: cov,
    fallbackWithoutVesselFinder: fallback,
    cases: { A_all: caseA, B_noVesselFinder: caseB, C_shipInfoOnly: caseC },
  };

  const s = stamp();
  fs.writeFileSync(path.join(reportsDir(), `multi-source-vessel-basics-${s}.json`), JSON.stringify(json, null, 2), "utf8");
  fs.writeFileSync(path.join(reportsDir(), `multi-source-vessel-basics-${s}.md`), md.join("\n"), "utf8");
  console.log(md.join("\n"));
  console.log(`\nWrote docs/reports/multi-source-vessel-basics-${s}.{md,json}`);
  await mongoose.disconnect();
}

function reportsDir(): string {
  const dir = path.join(process.cwd(), "docs", "reports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, "");

void main().catch(async (err) => {
  console.error(`FATAL: ${(err as Error).message}`);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
