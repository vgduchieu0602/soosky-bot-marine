/**
 * PHASE 6 — ADAPTIVE REGION SCHEDULER + MONGODB ATLAS PERSISTENCE PROOF.
 *
 *   --mode=connect   connect, assert safe DB, print sanitized Atlas info + collections
 *   --mode=cycle     run ONE real region scan through the full pipeline
 *   --mode=soak      run the scheduler for --minutes=N (bounded live soak)
 *   --mode=report    read Atlas back and write docs/reports/*.md + .json
 *
 * Everything below the HTTP call is production code: VesselFinder provider,
 * ObservationRecorder, resolver, Mongo repositories, AdaptiveRegionScheduler.
 * Canonical documents are NEVER inserted by hand (§32).
 *
 * ⚠️ Secrets: the Mongo URI is read from the environment and NEVER printed.
 * Only the database name and a redacted host are shown (§31).
 */
import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";

import { ObservationRecorder } from "../../src/application/services/observation/ObservationRecorder";
import { SourceRuntimeManager } from "../../src/application/services/crawl-runtime/SourceRuntimeManager";
import { ProviderRegistry } from "../../src/application/services/acquisition/ProviderRegistry";
import { CollectVesselObservations } from "../../src/application/use-cases/observation/CollectVesselObservations";
import { ResolveAndStoreCurrentVessel } from "../../src/application/use-cases/resolution/ResolveAndStoreCurrentVessel";
import { ResolveCurrentVessel } from "../../src/application/use-cases/resolution/ResolveCurrentVessel";
import { CompleteVesselBasics } from "../../src/application/use-cases/vessel/CompleteVesselBasics";
import { AdaptiveRegionScheduler, RegionCycleMetrics } from "../../src/infrastructure/scheduler/AdaptiveRegionScheduler";
import { MARITIME_REGIONS, findMaritimeRegion } from "../../src/config/maritimeRegions";
import { assertSafeBotDatabase, extractMongoDatabaseName, isProofModeEnabled } from "../../src/config/databaseSafety";
import { config as loadedConfig } from "../../src/config";
import { VesselSource } from "../../src/domain/enums/VesselSource";
import { connectMongo } from "../../src/infrastructure/persistence/mongo/connection";
import { CurrentVesselModel } from "../../src/infrastructure/persistence/mongo/currentVesselModel";
import { VesselObservationModel } from "../../src/infrastructure/persistence/mongo/observationModels";
import { CrawlRegionStateModel } from "../../src/infrastructure/persistence/mongo/crawlRegionStateModel";
import { MongoCrawlRegionStateRepository } from "../../src/infrastructure/persistence/mongo/MongoCrawlRegionStateRepository";
import { MongoCurrentVesselRepository } from "../../src/infrastructure/persistence/mongo/MongoCurrentVesselRepository";
import { MongoVesselObservationRepository } from "../../src/infrastructure/persistence/mongo/MongoVesselObservationRepository";
import { HttpClient } from "../../src/infrastructure/http/HttpClient";
import { ShipFinderClient } from "../../src/infrastructure/integrations/shipfinder/ShipFinderClient";
import { ShipFinderProvider } from "../../src/infrastructure/integrations/shipfinder/ShipFinderProvider";
import { ShipInfoClient } from "../../src/infrastructure/integrations/shipinfo/ShipInfoClient";
import { ShipInfoProvider } from "../../src/infrastructure/integrations/shipinfo/ShipInfoProvider";
import { VesselFinderHtmlSource } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderHtmlSource";
import { VesselFinderMapSource } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderMapSource";
import { VesselFinderProvider } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderProvider";

const LEGACY = ["latestPositions", "latestpositions", "vesselpositions", "vesselPositions", "vessels", "watchlistitems"];

/** §31 — host only, cluster identity redacted. Never the user, password or URI. */
function sanitizedMongoInfo(uri: string): { kind: string; database: string | null; host: string } {
  const afterScheme = uri.split("://")[1] ?? "";
  const hostPart = (afterScheme.split("@")[1] ?? afterScheme).split("/")[0].split(",")[0];
  const atlas = /mongodb\.net/i.test(uri) || uri.startsWith("mongodb+srv://");
  return {
    kind: atlas ? "ATLAS" : "LOCAL",
    database: extractMongoDatabaseName(uri),
    host: hostPart.replace(/^[^.]+/, "***"),
  };
}

function buildScheduler(regionIds?: readonly string[], completionBudget?: number) {
  const runtime = new SourceRuntimeManager();
  const vfHttp = new HttpClient({ timeoutMs: runtime.getConfig(VesselSource.VESSELFINDER).timeoutMs });
  const vesselFinder = new VesselFinderProvider({
    detailsSource: new VesselFinderHtmlSource(vfHttp),
    areaScanner: new VesselFinderMapSource(vfHttp),
  });

  const registry = new ProviderRegistry();
  registry.register(vesselFinder);
  registry.register(new ShipFinderProvider({
    client: new ShipFinderClient({ http: new HttpClient({ timeoutMs: runtime.getConfig(VesselSource.SHIPFINDER).timeoutMs }) }),
    sourceUtcOffsetMinutes: loadedConfig.shipFinderSourceUtcOffsetMinutes,
  }));
  registry.register(new ShipInfoProvider({
    client: new ShipInfoClient({ http: new HttpClient({ timeoutMs: runtime.getConfig(VesselSource.SHIPINFO).timeoutMs }) }),
  }));

  const observationRepository = new MongoVesselObservationRepository();
  const recorder = new ObservationRecorder({ repository: observationRepository });
  const resolveAndStore = new ResolveAndStoreCurrentVessel({
    resolve: new ResolveCurrentVessel({ repository: observationRepository }),
    repository: new MongoCurrentVesselRepository(),
  });

  const scheduler = new AdaptiveRegionScheduler({
    provider: vesselFinder,
    runtime,
    recorder,
    resolveAndStore,
    regionStates: new MongoCrawlRegionStateRepository(),
    currentVesselRepository: new MongoCurrentVesselRepository(),
    completionBudget,
    regions: regionIds
      ? MARITIME_REGIONS.filter((r) => regionIds.includes(r.id))
      : MARITIME_REGIONS,
    completeBasics: new CompleteVesselBasics({
      currentVesselRepository: new MongoCurrentVesselRepository(),
      observationRepository,
      collect: new CollectVesselObservations({ registry, runtime, recorder }),
      resolveAndStore,
    }),
  });
  return { scheduler, runtime };
}

async function collections(): Promise<string[]> {
  return (await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name).sort();
}

async function atlasCounts() {
  const [observations, canonical, regionStates] = await Promise.all([
    VesselObservationModel.countDocuments(),
    CurrentVesselModel.countDocuments(),
    CrawlRegionStateModel.countDocuments(),
  ]);
  const q = (filter: Record<string, unknown>) => CurrentVesselModel.countDocuments(filter);
  return {
    vessel_observations: observations,
    canonical_current_vessels: canonical,
    crawl_region_states: regionStates,
    canonicalWith: {
      name: await q({ "identity.name.value": { $type: "string" } }),
      mmsi: await q({ mmsi: { $type: "string" } }),
      latLon: await q({ "position.position.lat": { $type: "number" } }),
      speed: await q({ "position.motion.speed": { $type: "number" } }),
      course: await q({ "position.motion.course": { $type: "number" } }),
      navStatus: await q({ "position.motion.navStatus": { $ne: null } }),
      vType: await q({ "identity.vesselTypeCode.value": { $type: "number" } }),
      motionObservedAt: await q({ "position.motion.observedAt": { $type: "date" } }),
    },
  };
}

async function samples(limit = 5) {
  const docs = await CurrentVesselModel.find({ "position.position.lat": { $type: "number" } })
    .sort({ updatedAt: -1 }).limit(limit).lean();
  return docs.map((d: any) => ({
    mmsi: d.mmsi,
    name: d.identity?.name?.value ?? null,
    vType: d.identity?.vesselTypeCode?.value ?? null,
    lat: d.position?.position?.lat ?? null,
    lon: d.position?.position?.lng ?? null,
    speed: d.position?.motion?.speed ?? null,
    course: d.position?.motion?.course ?? null,
    navStatus: d.position?.motion?.navStatus?.code ?? d.position?.motion?.navStatus?.text ?? null,
    observedAt: d.position?.motion?.observedAt ? new Date(d.position.motion.observedAt).toISOString() : null,
  }));
}

const usage = () => {
  const m = process.memoryUsage();
  return { rssMb: Math.round(m.rss / 1048576), heapUsedMb: Math.round(m.heapUsed / 1048576) };
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.find((a) => a.startsWith("--mode="))?.slice(7) ?? "connect";
  const minutes = Number(args.find((a) => a.startsWith("--minutes="))?.slice(10) ?? 15);
  const regionArg = args.find((a) => a.startsWith("--regions="))?.slice(10);
  const regionIds = regionArg ? regionArg.split(",").map((s) => s.trim()) : undefined;
  const budget = Number(args.find((a) => a.startsWith("--budget="))?.slice(9) ?? 10);

  if (!isProofModeEnabled()) throw new Error("Set BOT_DATA_PROOF_MODE=true");
  const { dbName } = assertSafeBotDatabase({ mongoUri: loadedConfig.mongoUri, proofMode: true });
  if (loadedConfig.botAisEnabled) throw new Error("BOT_AIS_ENABLED must be false");
  if (loadedConfig.paidFallbackEnabled) throw new Error("PAID_FALLBACK_ENABLED must be false");

  await connectMongo(loadedConfig.mongoUri);
  const info = sanitizedMongoInfo(loadedConfig.mongoUri);

  console.log("\n========== ADAPTIVE CRAWLER ==========");
  console.log(`Mongo      : ${info.kind} / ${info.database}`);
  console.log(`Host       : ${info.host}`);
  console.log(`Regions    : ${(regionIds ? regionIds.length : MARITIME_REGIONS.length)}`);
  console.log(`AIS        : OFF`);
  console.log(`Paid       : OFF`);
  console.log(`ShipFinder UTC offset: ${loadedConfig.shipFinderSourceUtcOffsetMinutes === undefined ? "NOT_SET (position group suppressed)" : "SET"}`);
  console.log("======================================\n");

  if (mode === "connect") {
    const cols = await collections();
    console.log(`collections: ${cols.join(", ") || "(empty)"}`);
    console.log(`legacy present: ${LEGACY.filter((n) => cols.includes(n)).join(", ") || "NONE"}`);
    console.log(JSON.stringify(await atlasCounts(), null, 2));
    await mongoose.disconnect();
    return;
  }

  if (mode === "cycle" || mode === "soak") {
    const before = await atlasCounts();
    console.log(`BEFORE      : observations=${before.vessel_observations} canonical=${before.canonical_current_vessels} regionStates=${before.crawl_region_states}`);
    const { scheduler, runtime } = buildScheduler(regionIds, budget);
    const due = await scheduler.dueRegions();
    console.log(`Due now    : ${due.length} (${due.map((d) => d.region.id).join(", ") || "none"})`);

    const all: RegionCycleMetrics[] = [];
    const startedAt = Date.now();
    const deadline = startedAt + (mode === "cycle" ? 0 : minutes * 60_000);

    do {
      const metrics = await scheduler.tick();
      all.push(...metrics);
      for (const m of metrics) {
        console.log(`[region] ${m.regionId} ${m.outcome} vessels=${m.vesselCount} new=${m.newVesselCount} ` +
          `scanCalls=${m.scanAreaCalls} httpReq=${m.httpRequests} complReq=${m.completionRequests} ${m.durationMs}ms${m.error ? " err=" + m.error : ""}`);
      }
      if (Date.now() >= deadline) break;
      // Không có vùng nào tới hạn -> ngủ ngắn rồi hỏi lại. Không quét ép.
      if (metrics.length === 0) await new Promise((r) => setTimeout(r, 30_000));
    } while (Date.now() < deadline);

    const after = await atlasCounts();
    console.log(`AFTER       : observations=${after.vessel_observations} canonical=${after.canonical_current_vessels} regionStates=${after.crawl_region_states}`);
    console.log(`DELTA       : observations=+${after.vessel_observations - before.vessel_observations} canonical=+${after.canonical_current_vessels - before.canonical_current_vessels}`);
    const health = runtime.getHealth(VesselSource.VESSELFINDER);
    const payload = {
      before, after,
      mode, durationMs: Date.now() - startedAt, cycles: all,
      health, resources: usage(),
      regionStates: await CrawlRegionStateModel.find({}).lean(),
      counts: await atlasCounts(),
    };
    fs.writeFileSync(path.join(reportsDir(), `.adaptive-run-${Date.now()}.json`), JSON.stringify(payload, null, 2), "utf8");
    console.log(`\nhealth: ${JSON.stringify(health)}`);
    console.log(`resources: ${JSON.stringify(usage())}`);
    await mongoose.disconnect();
    return;
  }

  // ---- report ----
  const cols = await collections();
  const counts = await atlasCounts();
  const states = await CrawlRegionStateModel.find({}).sort({ regionId: 1 }).lean();
  const sample = await samples();

  const md: string[] = [];
  md.push("# PHASE 6 — ADAPTIVE REGION SCHEDULER + ATLAS PROOF", "");
  md.push(`- Mongo: **${info.kind}** / \`${info.database}\` · host \`${info.host}\``);
  md.push(`- AIS **OFF** · paid **OFF** · region scan concurrency **1** · VesselFinder request concurrency **1**`, "");
  md.push("## Atlas collections (§34)", "");
  md.push("```", cols.join(", ") || "(empty)", "```");
  md.push(`Legacy collections present: **${LEGACY.filter((n) => cols.includes(n)).join(", ") || "NONE"}**`, "");
  md.push("## Atlas counts (§35)", "", "```json", JSON.stringify(counts, null, 2), "```", "");
  md.push("## Region table (§56)", "");
  md.push("| REGION | TIER | LAST COUNT | AVG COUNT | EMPTY STREAK | LAST SCAN | NEXT SCAN | INTERVAL |");
  md.push("|---|---|---:|---:|---:|---|---|---:|");
  for (const s of states as any[]) {
    md.push(`| ${s.regionId} | ${s.tier} | ${s.lastVesselCount ?? "—"} | ${s.averageVesselCount ?? "—"} | ` +
      `${s.consecutiveEmptyScans} | ${s.lastScanAt ? new Date(s.lastScanAt).toISOString() : "—"} | ` +
      `${new Date(s.nextScanAt).toISOString()} | ${Math.round(s.intervalMs / 60000)}m |`);
  }
  md.push("", "## Canonical samples (§36)", "", "```json", JSON.stringify(sample, null, 2), "```");

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  fs.writeFileSync(path.join(reportsDir(), `adaptive-region-atlas-proof-${stamp}.md`), md.join("\n"), "utf8");
  fs.writeFileSync(path.join(reportsDir(), `adaptive-region-atlas-proof-${stamp}.json`),
    JSON.stringify({ mongo: info, collections: cols, counts, regionStates: states, samples: sample }, null, 2), "utf8");
  console.log(md.join("\n"));
  console.log(`\nWrote docs/reports/adaptive-region-atlas-proof-${stamp}.{md,json}`);
  await mongoose.disconnect();
}

function reportsDir(): string {
  const dir = path.join(process.cwd(), "docs", "reports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

void main().catch(async (err) => {
  console.error(`FATAL: ${(err as Error).message}`);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
