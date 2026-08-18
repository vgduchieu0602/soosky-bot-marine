/**
 * BOT-DATA-PROOF-1 CLI — standalone free-source crawl proof.
 *
 * Modes:
 *   discovery     VesselFinder map tiles as discovery "pages" → observations + resolve
 *   map           same path, position-focused metrics
 *   detail        free detail sample for discovered MMSIs (ShipInfo/ShipFinder/VF HTML)
 *   report        Mongo coverage / provider health snapshot
 *   continuous    bounded multi-cycle discovery+map (no paid, no AIS)
 *
 * Hard rules:
 *   BOT_DATA_PROOF_MODE=true required
 *   isolated Mongo DB name
 *   BOT_AIS_ENABLED must be false
 *   PAID_FALLBACK_ENABLED must be false
 *   MyShipTracking call count stays 0
 *
 * Pipeline (never bypass):
 *   Provider → ProviderResult → ObservationRecorder → vessel_observations
 *   → ResolveAndStoreCurrentVessel → canonical_current_vessels
 */
import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";
import { buildContainer } from "../../bootstrap/container";
import { ObservationSaveStatus } from "../../application/contracts/repositories/IVesselObservationRepository";
import { BoundingBox } from "../../application/contracts/geo/Geo";
import { DataNeedType } from "../../application/services/acquisition/DataNeed";
import { VesselSource } from "../../domain/enums/VesselSource";
import { assertSafeBotDatabase, isProofModeEnabled } from "../../config/databaseSafety";
import { CrawlCheckpointModel } from "../../infrastructure/persistence/mongo/crawlCheckpointModel";
import { CurrentVesselModel } from "../../infrastructure/persistence/mongo/currentVesselModel";
import { VesselObservationModel } from "../../infrastructure/persistence/mongo/observationModels";
import { config as loadedConfig } from "../../config";

type Mode = "discovery" | "map" | "detail" | "report" | "continuous";

type TileCursor = {
  tileIndex: number;
  tilesTotal: number;
  region: string;
};

type RunStats = {
  mode: Mode;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  database: string;
  aisEnabled: boolean;
  paidEnabled: boolean;
  pagesRequested: number;
  pagesOk: number;
  pagesError: number;
  rawRows: number;
  validRows: number;
  uniqueMmsi: number;
  duplicates: number;
  invalidIdentifiers: number;
  observationsSaved: number;
  observationsDuplicate: number;
  vesselsResolved: number;
  vesselsResolveFailed: number;
  statusCodes: Record<string, number>;
  errors: string[];
  peakRssMb: number;
  peakHeapMb: number;
  detailSample?: number;
  detailFieldCoverage?: Record<string, number>;
  provider?: string;
};

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mem(): { rssMb: number; heapMb: number } {
  const m = process.memoryUsage();
  return { rssMb: Math.round(m.rss / 1024 / 1024), heapMb: Math.round(m.heapUsed / 1024 / 1024) };
}

function trackMem(stats: RunStats): void {
  const m = mem();
  stats.peakRssMb = Math.max(stats.peakRssMb, m.rssMb);
  stats.peakHeapMb = Math.max(stats.peakHeapMb, m.heapMb);
}

/** Busy free-source tiles first (Singapore / Malacca / SCS lanes). */
function buildDiscoveryTiles(): BoundingBox[] {
  const tiles: BoundingBox[] = [];
  const pushGrid = (
    minLat: number,
    minLon: number,
    maxLat: number,
    maxLon: number,
    step: number
  ) => {
    for (let lat = minLat; lat < maxLat - 1e-9; lat += step) {
      for (let lon = minLon; lon < maxLon - 1e-9; lon += step) {
        tiles.push({
          minLat: lat,
          minLon: lon,
          maxLat: Math.min(lat + step, maxLat),
          maxLon: Math.min(lon + step, maxLon),
        });
      }
    }
  };

  // 1) Singapore Strait + approaches (highest density)
  pushGrid(0.8, 103.2, 1.6, 104.2, 0.2);
  // 2) Malacca Strait
  pushGrid(1.5, 101.5, 4.0, 103.5, 0.5);
  // 3) Southern Vietnam approaches
  pushGrid(9.5, 106.0, 11.5, 108.5, 0.5);
  // 4) South China Sea lanes
  pushGrid(8.0, 108.0, 14.0, 114.0, 1.0);
  // 5) Hong Kong / Pearl River approaches
  pushGrid(21.5, 113.0, 23.0, 115.0, 0.5);
  return tiles;
}

function parseMode(args: string[]): Mode {
  const mode = (flag(args, "mode") ?? args.find((a) => !a.startsWith("--")) ?? "").toLowerCase();
  if (
    mode === "discovery" ||
    mode === "map" ||
    mode === "detail" ||
    mode === "report" ||
    mode === "continuous"
  ) {
    return mode;
  }
  throw new Error(
    "Usage: bot:data-proof --mode=discovery|map|detail|report|continuous [--pages=N] [--sample=N] [--reset-checkpoint]"
  );
}

function printStartup(summary: Record<string, unknown>): void {
  console.log("\n========== BOT DATA PROOF STARTUP ==========");
  for (const [k, v] of Object.entries(summary)) {
    console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  console.log("===========================================\n");
}

async function loadCheckpoint(job: string): Promise<TileCursor | null> {
  const doc = await CrawlCheckpointModel.findOne({ job }).lean();
  if (!doc) return null;
  return doc.cursor as TileCursor;
}

async function saveCheckpoint(job: string, provider: string, cursor: TileCursor, stats: object): Promise<void> {
  await CrawlCheckpointModel.findOneAndUpdate(
    { job },
    { job, provider, cursor, stats, updatedAt: new Date() },
    { upsert: true, new: true }
  );
}

async function resolveBatch(
  resolveAndStore: { execute(key: { mmsi: string }): Promise<unknown> },
  mmsis: string[],
  concurrency: number,
  stats: RunStats
): Promise<void> {
  let i = 0;
  async function worker(): Promise<void> {
    while (i < mmsis.length) {
      const idx = i++;
      const mmsi = mmsis[idx];
      try {
        await resolveAndStore.execute({ mmsi });
        stats.vesselsResolved += 1;
      } catch (err) {
        stats.vesselsResolveFailed += 1;
        stats.errors.push(`resolve ${mmsi}: ${(err as Error).message}`);
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, mmsis.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
}

async function runTileCrawl(options: {
  mode: Mode;
  pages: number;
  resetCheckpoint: boolean;
  tileDelayMs: number;
  resolveConcurrency: number;
}): Promise<RunStats> {
  const container = await buildContainer({ connectMongo: true });
  const cfg = container.config;
  const { dbName } = assertSafeBotDatabase({ mongoUri: cfg.mongoUri, proofMode: true });

  if (cfg.botAisEnabled) throw new Error("BOT_AIS_ENABLED must be false for data proof");
  if (cfg.paidFallbackEnabled) throw new Error("PAID_FALLBACK_ENABLED must be false for data proof");

  const provider = container.providerRegistry.get(VesselSource.VESSELFINDER);
  if (!provider?.scanArea) throw new Error("VesselFinderProvider.scanArea is not available");

  const tiles = buildDiscoveryTiles();
  const job = `data-proof-${options.mode}`;
  let startIndex = 0;
  if (options.resetCheckpoint) {
    await CrawlCheckpointModel.deleteOne({ job });
  } else {
    const cp = await loadCheckpoint(job);
    if (cp && cp.tileIndex > 0 && cp.tileIndex < tiles.length) {
      startIndex = cp.tileIndex;
      console.log(`Resuming checkpoint at tile ${startIndex}/${tiles.length}`);
    }
  }

  const endIndex = Math.min(tiles.length, startIndex + options.pages);
  printStartup({
    mode: options.mode,
    database: dbName,
    aisEnabled: false,
    paidEnabled: false,
    provider: "vesselfinder",
    scheduler: "none (one-shot CLI)",
    concurrency: 1,
    tileDelayMs: options.tileDelayMs,
    resolveConcurrency: options.resolveConcurrency,
    checkpoint: `${startIndex} -> ${endIndex} / ${tiles.length}`,
    mongoUriHost: "local-override-not-logged",
  });

  const stats: RunStats = {
    mode: options.mode,
    startedAt: new Date().toISOString(),
    database: dbName,
    aisEnabled: false,
    paidEnabled: false,
    pagesRequested: 0,
    pagesOk: 0,
    pagesError: 0,
    rawRows: 0,
    validRows: 0,
    uniqueMmsi: 0,
    duplicates: 0,
    invalidIdentifiers: 0,
    observationsSaved: 0,
    observationsDuplicate: 0,
    vesselsResolved: 0,
    vesselsResolveFailed: 0,
    statusCodes: {},
    errors: [],
    peakRssMb: 0,
    peakHeapMb: 0,
    provider: "vesselfinder",
  };

  const seen = new Set<string>();
  let stopping = false;
  const onStop = () => {
    if (stopping) return;
    stopping = true;
    console.log("\n[proof] graceful stop requested — finishing current tile and flushing checkpoint");
  };
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);

  const t0 = Date.now();
  for (let i = startIndex; i < endIndex && !stopping; i++) {
    const box = tiles[i];
    stats.pagesRequested += 1;
    const pageT0 = Date.now();
    try {
      const results = await provider.scanArea(box);
      stats.pagesOk += 1;
      stats.statusCodes["200"] = (stats.statusCodes["200"] ?? 0) + 1;
      stats.rawRows += results.length;

      const pageMmsis: string[] = [];
      for (const row of results) {
        const mmsi = row.position?.mmsi ?? row.identity?.mmsi ?? null;
        if (!mmsi || !/^\d{9}$/.test(mmsi)) {
          stats.invalidIdentifiers += 1;
          continue;
        }
        stats.validRows += 1;
        if (seen.has(mmsi)) stats.duplicates += 1;
        else seen.add(mmsi);
        pageMmsis.push(mmsi);
      }
      // unique within page for resolve
      const pageUnique = Array.from(new Set(pageMmsis));

      const saved = await container.observationRecorder.recordPositions(results, {
        parserVersion: "bot-data-proof-vf-map-v1",
      });
      for (const s of saved) {
        if (s.status === ObservationSaveStatus.SAVED) stats.observationsSaved += 1;
        if (s.status === ObservationSaveStatus.SKIPPED_DUPLICATE) stats.observationsDuplicate += 1;
      }

      // Resolve vessels seen on this page (canonical path).
      await resolveBatch(
        container.resolveAndStoreCurrentVessel,
        pageUnique,
        options.resolveConcurrency,
        stats
      );

      await saveCheckpoint(
        job,
        "vesselfinder",
        { tileIndex: i + 1, tilesTotal: tiles.length, region: "vn-sg-grid" },
        {
          pagesOk: stats.pagesOk,
          uniqueMmsi: seen.size,
          observationsSaved: stats.observationsSaved,
        }
      );

      const pageMs = Date.now() - pageT0;
      console.log(
        `tile ${i + 1}/${tiles.length} ships=${results.length} uniquePage=${pageUnique.length} ` +
          `savedObs+=${saved.filter((s) => s.status === ObservationSaveStatus.SAVED).length} ` +
          `${pageMs}ms rss=${mem().rssMb}MB`
      );
    } catch (err) {
      stats.pagesError += 1;
      const msg = (err as Error).message || String(err);
      stats.errors.push(`tile ${i}: ${msg}`);
      const lower = msg.toLowerCase();
      if (lower.includes("403") || lower.includes("blocked")) {
        stats.statusCodes["403"] = (stats.statusCodes["403"] ?? 0) + 1;
        console.log("THROTTLED/BLOCKED — cooling down 60s");
        await sleep(60_000);
      } else if (lower.includes("429")) {
        stats.statusCodes["429"] = (stats.statusCodes["429"] ?? 0) + 1;
        console.log("429 — cooling down 60s");
        await sleep(60_000);
      } else if (lower.includes("timeout")) {
        stats.statusCodes["timeout"] = (stats.statusCodes["timeout"] ?? 0) + 1;
      } else {
        stats.statusCodes["error"] = (stats.statusCodes["error"] ?? 0) + 1;
      }
      console.log(`tile ${i + 1} ERROR: ${msg}`);
      await saveCheckpoint(
        job,
        "vesselfinder",
        { tileIndex: i, tilesTotal: tiles.length, region: "vn-sg-grid" },
        { lastError: msg }
      );
    }

    trackMem(stats);
    stats.uniqueMmsi = seen.size;
    if (i + 1 < endIndex && !stopping) await sleep(options.tileDelayMs);
  }

  stats.finishedAt = new Date().toISOString();
  stats.durationMs = Date.now() - t0;
  stats.uniqueMmsi = seen.size;
  return stats;
}

async function runDetailSample(sample: number, delayMs: number): Promise<RunStats> {
  const container = await buildContainer({ connectMongo: true });
  const cfg = container.config;
  const { dbName } = assertSafeBotDatabase({ mongoUri: cfg.mongoUri, proofMode: true });
  if (cfg.botAisEnabled) throw new Error("BOT_AIS_ENABLED must be false");
  if (cfg.paidFallbackEnabled) throw new Error("PAID_FALLBACK_ENABLED must be false");

  const docs = await CurrentVesselModel.find({ mmsi: { $ne: null } })
    .sort({ updatedAt: -1 })
    .limit(sample)
    .select({ mmsi: 1 })
    .lean();
  const mmsis = docs.map((d) => String(d.mmsi)).filter((m) => /^\d{9}$/.test(m));

  printStartup({
    mode: "detail",
    database: dbName,
    aisEnabled: false,
    paidEnabled: false,
    sample: mmsis.length,
    freeProviders: ["shipinfo", "shipfinder", "vesselfinder"],
    paidProviders: "disabled",
  });

  const stats: RunStats = {
    mode: "detail",
    startedAt: new Date().toISOString(),
    database: dbName,
    aisEnabled: false,
    paidEnabled: false,
    pagesRequested: 0,
    pagesOk: 0,
    pagesError: 0,
    rawRows: 0,
    validRows: 0,
    uniqueMmsi: mmsis.length,
    duplicates: 0,
    invalidIdentifiers: 0,
    observationsSaved: 0,
    observationsDuplicate: 0,
    vesselsResolved: 0,
    vesselsResolveFailed: 0,
    statusCodes: {},
    errors: [],
    peakRssMb: 0,
    peakHeapMb: 0,
    detailSample: mmsis.length,
    provider: "free-multi",
  };

  const t0 = Date.now();
  for (const mmsi of mmsis) {
    stats.pagesRequested += 1;
    try {
      const result = await container.acquireFreeVesselData.execute(
        { mmsi },
        { type: DataNeedType.FULL }
      );
      stats.pagesOk += 1;
      stats.statusCodes["200"] = (stats.statusCodes["200"] ?? 0) + 1;
      for (const attempt of result.attempts) {
        if (String(attempt.outcome) === "SUCCESS") {
          stats.observationsSaved += 1;
        }
      }
      if (result.vessel) stats.vesselsResolved += 1;
      console.log(
        `detail ${mmsi} satisfied=${result.satisfied} stop=${result.stopReason} attempts=${result.attempts.length}`
      );
    } catch (err) {
      stats.pagesError += 1;
      const msg = (err as Error).message;
      stats.errors.push(`${mmsi}: ${msg}`);
      console.log(`detail ${mmsi} ERROR: ${msg}`);
    }
    trackMem(stats);
    await sleep(delayMs);
  }

  // Field coverage on the sample set after enrichment.
  const enriched = await CurrentVesselModel.find({ mmsi: { $in: mmsis } }).lean();
  const n = enriched.length || 1;
  const cov = (pred: (d: any) => boolean) =>
    Math.round((1000 * enriched.filter(pred).length) / n) / 10;
  stats.detailFieldCoverage = {
    vesselType: cov((d) => d.identity?.vesselType?.value != null || d.particulars?.vesselType?.value != null),
    flag: cov((d) => d.identity?.flagName?.value != null || d.identity?.flagCode?.value != null),
    grossTonnage: cov((d) => d.particulars?.grossTonnage?.value != null),
    deadWeight: cov((d) => d.particulars?.deadWeight?.value != null || d.particulars?.dwt?.value != null),
    yearOfBuild: cov((d) => d.particulars?.yearOfBuild?.value != null || d.particulars?.builtYear?.value != null),
    currentPort: cov((d) => d.voyage?.current?.port?.value != null || d.voyage?.voyage?.current?.port != null),
    lastPort: cov((d) => d.voyage?.last?.port?.value != null || d.voyage?.voyage?.last?.port != null),
    nextPort: cov((d) => d.voyage?.next?.port?.value != null || d.voyage?.voyage?.next?.port != null),
  };

  stats.finishedAt = new Date().toISOString();
  stats.durationMs = Date.now() - t0;
  return stats;
}

async function runReport(): Promise<object> {
  const container = await buildContainer({ connectMongo: true });
  const { dbName } = assertSafeBotDatabase({ mongoUri: container.config.mongoUri, proofMode: true });

  const obsCount = await VesselObservationModel.countDocuments();
  const canCount = await CurrentVesselModel.countDocuments();
  const withPos = await CurrentVesselModel.countDocuments({
    "position.position.lat": { $type: "number" },
    "position.position.lng": { $type: "number" },
  });
  const withName = await CurrentVesselModel.countDocuments({ "identity.name.value": { $type: "string" } });
  const withImo = await CurrentVesselModel.countDocuments({ imo: { $type: "string" } });
  const withCourse = await CurrentVesselModel.countDocuments({ "position.position.course": { $type: "number" } });
  const withSpeed = await CurrentVesselModel.countDocuments({ "position.position.speed": { $type: "number" } });
  const withNav = await CurrentVesselModel.countDocuments({ "position.position.navStatus": { $ne: null } });
  const withSrcTs = await CurrentVesselModel.countDocuments({ "position.observedAt": { $type: "date" } });
  const withFlag = await CurrentVesselModel.countDocuments({
    $or: [{ "identity.flagName.value": { $type: "string" } }, { "identity.flagCode.value": { $type: "string" } }],
  });
  const withGt = await CurrentVesselModel.countDocuments({ "particulars.grossTonnage.value": { $type: "number" } });
  const withDwt = await CurrentVesselModel.countDocuments({
    $or: [
      { "particulars.deadWeight.value": { $type: "number" } },
      { "particulars.dwt.value": { $type: "number" } },
    ],
  });
  const withYob = await CurrentVesselModel.countDocuments({
    $or: [
      { "particulars.yearOfBuild.value": { $type: "number" } },
      { "particulars.builtYear.value": { $type: "number" } },
    ],
  });

  const pct = (part: number, whole: number) =>
    whole === 0 ? 0 : Math.round((1000 * part) / whole) / 10;

  const bySource = await VesselObservationModel.aggregate([
    { $group: { _id: "$source", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  const byType = await VesselObservationModel.aggregate([
    { $group: { _id: "$type", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);

  const samples = await CurrentVesselModel.find({})
    .sort({ updatedAt: -1 })
    .limit(5)
    .lean();
  const sanitized = samples.map((d: any) => ({
    mmsi: d.mmsi,
    imo: d.imo,
    name: d.identity?.name?.value ?? null,
    lat: d.position?.position?.lat ?? null,
    lng: d.position?.position?.lng ?? null,
    course: d.position?.position?.course ?? null,
    speed: d.position?.position?.speed ?? null,
    navStatus: d.position?.position?.navStatus ?? null,
    observedAt: d.position?.observedAt ?? null,
    source: d.position?.source ?? d.identity?.name?.source ?? null,
    flag: d.identity?.flagName?.value ?? d.identity?.flagCode?.value ?? null,
    gt: d.particulars?.grossTonnage?.value ?? null,
    dwt: d.particulars?.deadWeight?.value ?? d.particulars?.dwt?.value ?? null,
  }));

  const indexesObs = await mongoose.connection.db!.collection("vessel_observations").indexes();
  const indexesCan = await mongoose.connection.db!.collection("canonical_current_vessels").indexes();
  const statsDb = await mongoose.connection.db!.stats();
  const checkpoints = await CrawlCheckpointModel.find({}).lean();

  return {
    DATABASE: {
      name: dbName,
      observations: obsCount,
      canonical: canCount,
      canonicalWithPosition: withPos,
      storageBytes: statsDb.dataSize,
      storageMB: Math.round((statsDb.dataSize / 1024 / 1024) * 100) / 100,
      indexMB: Math.round((statsDb.indexSize / 1024 / 1024) * 100) / 100,
    },
    VESSEL_BASICS_COVERAGE: {
      total: canCount,
      vesselNamePct: pct(withName, canCount),
      mmsiPct: 100,
      imoPct: pct(withImo, canCount),
      latLonPct: pct(withPos, canCount),
      coursePct: pct(withCourse, canCount),
      speedPct: pct(withSpeed, canCount),
      navStatusPct: pct(withNav, canCount),
      sourceObservedAtPct: pct(withSrcTs, canCount),
      note:
        "VesselFinder mp2 map tiles do not provide course/speed/navStatus/sourceReceivedAt; those fields stay null until detail/AIS enrichment.",
    },
    VESSEL_DETAILS_COVERAGE: {
      total: canCount,
      flagPct: pct(withFlag, canCount),
      grossTonnagePct: pct(withGt, canCount),
      deadWeightPct: pct(withDwt, canCount),
      yearOfBuildPct: pct(withYob, canCount),
    },
    OBSERVATIONS_BY_SOURCE: bySource,
    OBSERVATIONS_BY_TYPE: byType,
    INDEXES: {
      vessel_observations: indexesObs.map((i) => i.name),
      canonical_current_vessels: indexesCan.map((i) => i.name),
    },
    CHECKPOINTS: checkpoints.map((c: any) => ({
      job: c.job,
      provider: c.provider,
      cursor: c.cursor,
      updatedAt: c.updatedAt,
    })),
    SAMPLES: sanitized,
    RUNTIME: {
      aisEnabled: container.config.botAisEnabled,
      paidEnabled: container.config.paidFallbackEnabled,
      myShipTrackingKeyPresent: Boolean(container.config.myShipTrackingApiKey),
      rssMb: mem().rssMb,
      heapMb: mem().heapMb,
    },
  };
}

function writeReport(name: string, payload: unknown): string {
  const dir = path.join(process.cwd(), "docs", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

async function main(): Promise<void> {
  if (!isProofModeEnabled()) {
    throw new Error("Set BOT_DATA_PROOF_MODE=true to run this CLI.");
  }
  if (!loadedConfig.mongoUri) {
    throw new Error("MONGODB_URI is required.");
  }
  assertSafeBotDatabase({ mongoUri: loadedConfig.mongoUri, proofMode: true });

  const args = process.argv.slice(2);
  const mode = parseMode(args);
  const pages = flagInt(args, "pages", mode === "discovery" || mode === "map" ? 10 : 0);
  const sample = flagInt(args, "sample", 20);
  const resetCheckpoint = args.includes("--reset-checkpoint");
  const tileDelayMs = flagInt(args, "delay-ms", 4000);
  const detailDelayMs = flagInt(args, "detail-delay-ms", 2500);
  const resolveConcurrency = flagInt(args, "resolve-concurrency", 3);

  let payload: unknown;
  if (mode === "report") {
    payload = await runReport();
  } else if (mode === "detail") {
    payload = await runDetailSample(sample, detailDelayMs);
  } else if (mode === "continuous") {
    const a = await runTileCrawl({
      mode: "discovery",
      pages: Math.max(pages, 10),
      resetCheckpoint,
      tileDelayMs,
      resolveConcurrency,
    });
    const b = await runTileCrawl({
      mode: "map",
      pages: Math.min(5, pages || 5),
      resetCheckpoint: false,
      tileDelayMs,
      resolveConcurrency,
    });
    payload = { cycles: [a, b], report: await runReport() };
  } else {
    payload = await runTileCrawl({
      mode,
      pages: Math.max(1, pages),
      resetCheckpoint,
      tileDelayMs,
      resolveConcurrency,
    });
  }

  console.log("\n" + JSON.stringify(payload, null, 2));
  const out = writeReport(
    `bot-data-proof-${mode}-${new Date().toISOString().replace(/[:.]/g, "")}.json`,
    payload
  );
  console.log(`\nWrote ${out}`);
  await mongoose.disconnect().catch(() => undefined);
}

void main().catch(async (err) => {
  console.error(`\nFATAL: ${(err as Error).message}`);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
