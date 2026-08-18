/**
 * PHASE 3.2 — LIVE MOTION STABILITY GATE.
 *
 * Proves the motion carry-forward implementation against REAL free-source
 * traffic, REAL Mongo, multiple crawl cycles and a REAL process restart.
 *
 *   --cycle=1   live map discovery -> observations
 *               -> live VesselFinder detail enrichment -> observations
 *               -> ResolveAndStoreCurrentVessel -> canonical
 *   --cycle=2   live map discovery ONLY -> observations -> resolve
 *               (deliberately recreates the old bug condition)
 *   --mode=persist-check   read canonical WITHOUT crawling (run after restart,
 *                          before cycle 2) to prove nothing lived in memory
 *   --mode=report          cycle comparison + regional matrix
 *
 * Each invocation is a SEPARATE OS process. That is the restart proof — no
 * resolver state may survive between cycles except through Mongo.
 *
 * Every network call goes through the existing per-source crawl runtime
 * (timeout / delay / retry / cooldown). Nothing here retries harder than the
 * runtime allows, and nothing bypasses a block (§9).
 *
 * This script ORCHESTRATES and REPORTS only. All parsing, validation,
 * resolution and persistence is production code.
 *
 * ⚠️ It deliberately does NOT call `buildContainer`: that also wires the legacy
 * compatibility repositories, and merely constructing them recreates the legacy
 * collections this gate must prove absent (§6). Here the canonical pipeline is
 * composed directly from its own production classes.
 */
import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";

import { ObservationRecorder } from "../../src/application/services/observation/ObservationRecorder";
import { SourceRuntimeManager } from "../../src/application/services/crawl-runtime/SourceRuntimeManager";
import { ResolveAndStoreCurrentVessel } from "../../src/application/use-cases/resolution/ResolveAndStoreCurrentVessel";
import { ResolveCurrentVessel } from "../../src/application/use-cases/resolution/ResolveCurrentVessel";
import { DEFAULT_POSITION_CANDIDATES_PER_SOURCE } from "../../src/application/use-cases/resolution/ResolveCurrentPosition";
import { ProviderOperation } from "../../src/application/contracts/providers/VesselDataProvider";
import { ProviderPositionResult } from "../../src/application/contracts/providers/ProviderResults";
import { SourceErrorCategory, SourceRequestError, SourceUnavailableError } from "../../src/application/services/crawl-runtime/SourceError";
import { assertSafeBotDatabase, isProofModeEnabled } from "../../src/config/databaseSafety";
import { config as loadedConfig } from "../../src/config";
import { mmsiIdentifier } from "../../src/domain/value-objects/VesselIdentifier";
import { isValidMmsi } from "../../src/domain/validators/identifiers";
import { VesselSource } from "../../src/domain/enums/VesselSource";
import { VesselObservationType } from "../../src/domain/entities/VesselObservation";
import { connectMongo } from "../../src/infrastructure/persistence/mongo/connection";
import { CurrentVesselModel } from "../../src/infrastructure/persistence/mongo/currentVesselModel";
import { VesselObservationModel } from "../../src/infrastructure/persistence/mongo/observationModels";
import { MongoCurrentVesselRepository } from "../../src/infrastructure/persistence/mongo/MongoCurrentVesselRepository";
import { MongoVesselObservationRepository } from "../../src/infrastructure/persistence/mongo/MongoVesselObservationRepository";
import { HttpClient } from "../../src/infrastructure/http/HttpClient";
import { VesselFinderHtmlSource } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderHtmlSource";
import { VesselFinderMapSource } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderMapSource";
import { VesselFinderProvider } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderProvider";

import { PROOF_REGIONS, PROOF_SUB_REGIONS, ProofRegion } from "./regions";

/** §10 — small but real. Not 100/region yet. */
const PER_REGION = 10;
/** §11 — spread across sub-regions, never one tile. */
const SUB_REGIONS_PER_REGION = 2;

const SAMPLE_JOB = "live-motion-gate-sample";

type Metrics = {
  mapRequests: number;
  detailRequests: number;
  status: Record<string, number>;
  latenciesMs: number[];
};

function newMetrics(): Metrics {
  return { mapRequests: 0, detailRequests: 0, status: {}, latenciesMs: [] };
}

function bump(metrics: Metrics, key: string, latencyMs: number): void {
  metrics.status[key] = (metrics.status[key] ?? 0) + 1;
  if (latencyMs > 0) metrics.latenciesMs.push(latencyMs);
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

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function usage(label: string): Record<string, unknown> {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    label,
    pid: process.pid,
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
  };
}

function buildPipeline() {
  const runtime = new SourceRuntimeManager();
  const timeoutMs = runtime.getConfig(VesselSource.VESSELFINDER).timeoutMs;
  const http = new HttpClient({ timeoutMs });
  const provider = new VesselFinderProvider({
    detailsSource: new VesselFinderHtmlSource(http),
    areaScanner: new VesselFinderMapSource(http),
  });
  const observationRepository = new MongoVesselObservationRepository();
  return {
    runtime,
    provider,
    observationRepository,
    recorder: new ObservationRecorder({
      repository: observationRepository,
      parserVersion: "vesselfinder-html-v1",
    }),
    resolveAndStore: new ResolveAndStoreCurrentVessel({
      resolve: new ResolveCurrentVessel({ repository: observationRepository }),
      repository: new MongoCurrentVesselRepository(),
    }),
  };
}

/** Sample manifest lives in Mongo so cycle 2 (a new process) uses the SAME vessels. */
async function saveSample(vessels: readonly { mmsi: string; region: ProofRegion; subRegion: string }[]): Promise<void> {
  await mongoose.connection.db!.collection(SAMPLE_JOB).deleteMany({});
  if (vessels.length > 0) {
    await mongoose.connection.db!.collection(SAMPLE_JOB).insertMany(vessels.map((v) => ({ ...v })));
  }
}

async function loadSample(): Promise<{ mmsi: string; region: ProofRegion; subRegion: string }[]> {
  return (await mongoose.connection.db!.collection(SAMPLE_JOB).find({}).toArray()) as never;
}

async function discover(
  pipeline: ReturnType<typeof buildPipeline>,
  metrics: Metrics
): Promise<{ mmsi: string; region: ProofRegion; subRegion: string }[]> {
  const executor = pipeline.runtime.getExecutor(VesselSource.VESSELFINDER);
  const picked: { mmsi: string; region: ProofRegion; subRegion: string }[] = [];

  for (const region of PROOF_REGIONS) {
    const subs = PROOF_SUB_REGIONS.filter((s) => s.region === region).slice(0, SUB_REGIONS_PER_REGION);
    const perSub = Math.ceil(PER_REGION / Math.max(1, subs.length));
    const seen = new Set<string>();

    for (const sub of subs) {
      const startedAt = Date.now();
      try {
        const rows = await executor.execute<readonly ProviderPositionResult[]>(
          () => pipeline.provider.scanArea!(sub.box),
          { operation: ProviderOperation.SCAN_AREA }
        );
        metrics.mapRequests += 1;
        bump(metrics, "200", Date.now() - startedAt);
        await pipeline.recorder.recordPositions(rows);

        let taken = 0;
        for (const row of rows) {
          const mmsi = row.position?.mmsi ?? null;
          if (!isValidMmsi(mmsi) || seen.has(mmsi!)) continue;
          seen.add(mmsi!);
          picked.push({ mmsi: mmsi!, region, subRegion: sub.name });
          if (++taken >= perSub) break;
        }
        console.log(`[discover] ${sub.name} rows=${rows.length} sampled=${taken}`);
      } catch (err) {
        metrics.mapRequests += 1;
        const kind = classify(err);
        bump(metrics, kind, Date.now() - startedAt);
        console.log(`[discover] ${sub.name} ${kind}: ${(err as Error).message?.slice(0, 160)}`);
      }
    }
  }
  return picked.slice(0, PER_REGION * PROOF_REGIONS.length);
}

async function enrich(
  pipeline: ReturnType<typeof buildPipeline>,
  vessels: readonly { mmsi: string }[],
  metrics: Metrics
): Promise<void> {
  const executor = pipeline.runtime.getExecutor(VesselSource.VESSELFINDER);
  for (const vessel of vessels) {
    const startedAt = Date.now();
    try {
      const details = await executor.execute(
        () => pipeline.provider.getDetails!(mmsiIdentifier(vessel.mmsi)),
        { operation: ProviderOperation.GET_DETAILS }
      );
      metrics.detailRequests += 1;
      bump(metrics, "200", Date.now() - startedAt);
      if (details !== null) await pipeline.recorder.recordDetails(details);
    } catch (err) {
      metrics.detailRequests += 1;
      const kind = classify(err);
      bump(metrics, kind, Date.now() - startedAt);
      console.log(`[detail] ${vessel.mmsi} ${kind}`);
    }
  }
}

/** Sanitized canonical snapshot — §14/§27. No raw HTML, no headers. */
async function snapshot(vessels: readonly { mmsi: string; region: ProofRegion; subRegion: string }[]) {
  const rows = [];
  for (const vessel of vessels) {
    const doc = (await CurrentVesselModel.findOne({ mmsi: vessel.mmsi }).lean()) as any;
    const p = doc?.position;
    rows.push({
      mmsi: vessel.mmsi,
      region: vessel.region,
      subRegion: vessel.subRegion,
      vesselName: doc?.identity?.name?.value ?? null,
      vesselType: doc?.identity?.vesselType?.value ?? null,
      lat: p?.position?.lat ?? null,
      lon: p?.position?.lng ?? null,
      coordinatePrecise: p ? p.position?.latLngApproximate !== true : null,
      coordinateSource: p?.source ?? null,
      coordinateObservedAt: p?.observedAt ? new Date(p.observedAt).toISOString() : null,
      speed: p?.motion?.speed ?? null,
      course: p?.motion?.course ?? null,
      navStatus: p?.motion?.navStatus?.code ?? null,
      motionSource: p?.motion?.source ?? null,
      motionObservedAt: p?.motion?.observedAt ? new Date(p.motion.observedAt).toISOString() : null,
      motionFreshness: p?.motion?.freshness ?? null,
    });
  }
  return rows;
}

function reportsDir(): string {
  const dir = path.join(process.cwd(), "docs", "reports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((1000 * part) / whole) / 10;
}

function coverage(rows: readonly any[]) {
  return {
    vessels: rows.length,
    latLon: pct(rows.filter((r) => r.lat !== null && r.lon !== null).length, rows.length),
    speed: pct(rows.filter((r) => r.speed !== null).length, rows.length),
    course: pct(rows.filter((r) => r.course !== null).length, rows.length),
    navStatus: pct(rows.filter((r) => r.navStatus !== null).length, rows.length),
    motionObservedAt: pct(rows.filter((r) => r.motionObservedAt !== null).length, rows.length),
    motionPresent: rows.filter((r) => r.speed !== null || r.course !== null || r.navStatus !== null).length,
  };
}

async function collections(): Promise<string[]> {
  return (await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name).sort();
}

const LEGACY = ["latestpositions", "latestPositions", "vesselpositions", "vesselPositions", "vessels", "watchlistitems"];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cycle = args.find((a) => a.startsWith("--cycle="))?.slice(8);
  const mode = args.find((a) => a.startsWith("--mode="))?.slice(7);

  if (!isProofModeEnabled()) throw new Error("Set BOT_DATA_PROOF_MODE=true");
  const { dbName } = assertSafeBotDatabase({ mongoUri: loadedConfig.mongoUri, proofMode: true });
  if (loadedConfig.botAisEnabled) throw new Error("BOT_AIS_ENABLED must be false");
  if (loadedConfig.paidFallbackEnabled) throw new Error("PAID_FALLBACK_ENABLED must be false");

  await connectMongo(loadedConfig.mongoUri);
  const before = await collections();
  console.log(JSON.stringify(usage("start")));
  console.log(`db=${dbName} ais=false paid=false | collections before: ${before.join(", ") || "(empty)"}`);

  if (mode === "persist-check") {
    // §24 — read canonical WITHOUT crawling. Proves nothing lived in memory.
    const sample = await loadSample();
    const rows = await snapshot(sample);
    console.log(`\n[persist-check] pid=${process.pid} vessels=${rows.length}`);
    console.log(JSON.stringify(coverage(rows), null, 2));
    await mongoose.disconnect();
    return;
  }

  if (mode === "report") {
    const sample = await loadSample();
    const rows = await snapshot(sample);
    const byRegion: Record<string, unknown> = {};
    for (const region of PROOF_REGIONS) byRegion[region] = coverage(rows.filter((r) => r.region === region));
    byRegion.ALL = coverage(rows);
    console.log(JSON.stringify({ collections: await collections(), byRegion }, null, 2));
    await mongoose.disconnect();
    return;
  }

  if (cycle !== "1" && cycle !== "2") throw new Error("Usage: --cycle=1 | --cycle=2 | --mode=persist-check | --mode=report");

  const metrics = newMetrics();
  const pipeline = buildPipeline();
  const startedAt = Date.now();

  let sample: { mmsi: string; region: ProofRegion; subRegion: string }[];
  if (cycle === "1") {
    sample = await discover(pipeline, metrics);
    await saveSample(sample);
    console.log(`[cycle 1] sample=${sample.length} unique=${new Set(sample.map((s) => s.mmsi)).size}`);
    await enrich(pipeline, sample, metrics);
  } else {
    // §16 — map discovery ONLY. No detail pass. This is the old bug condition.
    await discover(pipeline, metrics);
    sample = await loadSample();
    console.log(`[cycle 2] map-only refresh done; resolving the SAME ${sample.length} vessels`);
  }

  for (const vessel of sample) {
    await pipeline.resolveAndStore.execute({ mmsi: vessel.mmsi });
  }

  const rows = await snapshot(sample);
  const after = await collections();
  const report = {
    phase: "PHASE-3.2-LIVE-MOTION-GATE",
    cycle: Number(cycle),
    pid: process.pid,
    database: dbName,
    ais: false,
    paid: false,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    collectionsBefore: before,
    collectionsAfter: after,
    legacyCollectionsPresent: LEGACY.filter((name) => after.includes(name)),
    sampleSize: sample.length,
    requestMetrics: {
      mapRequests: metrics.mapRequests,
      detailRequests: metrics.detailRequests,
      requestsPerVessel: sample.length ? Math.round(((metrics.mapRequests + metrics.detailRequests) / sample.length) * 100) / 100 : 0,
      status: metrics.status,
      avgLatencyMs: metrics.latenciesMs.length ? Math.round(metrics.latenciesMs.reduce((a, b) => a + b, 0) / metrics.latenciesMs.length) : null,
      p95LatencyMs: percentile(metrics.latenciesMs, 95),
    },
    coverage: coverage(rows),
    maxPerSource: DEFAULT_POSITION_CANDIDATES_PER_SOURCE,
    observationCount: await VesselObservationModel.countDocuments(),
    canonicalCount: await CurrentVesselModel.countDocuments(),
    resources: usage(`after-cycle-${cycle}`),
    vessels: rows,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const file = path.join(reportsDir(), `live-motion-cycle${cycle}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");

  console.log(`\ncollections after: ${after.join(", ")}`);
  console.log(`legacy present: ${report.legacyCollectionsPresent.join(", ") || "NONE"}`);
  console.log(JSON.stringify(report.requestMetrics, null, 2));
  console.log(JSON.stringify(report.coverage, null, 2));
  console.log(`Wrote ${file}`);

  await mongoose.disconnect();
}

void main().catch(async (err) => {
  console.error(`FATAL: ${(err as Error).message}`);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
