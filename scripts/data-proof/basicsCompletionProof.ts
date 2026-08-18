/**
 * PHASE 5 — VESSELBASICS COMPLETION PROOF.
 *
 *   --mode=before   measure VesselBasics from canonical BEFORE completion
 *   --mode=complete run CompleteVesselBasics over the sample (cycle 1 or 2)
 *   --mode=after    measure again + write docs/reports/*.md/.json
 *
 * Cycle 2 exists to prove §12: vessels completed a moment ago must NOT trigger
 * another round of lookups. The lookup count is the headline number.
 *
 * Orchestration + reporting only. All completion logic is the production
 * use-case `CompleteVesselBasics`.
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
import { SHIPFINDER_PARSER_VERSION } from "../../src/infrastructure/integrations/shipfinder/ShipFinderParser";
import { SHIPINFO_PARSER_VERSION } from "../../src/infrastructure/integrations/shipinfo/ShipInfoParser";
import { assertSafeBotDatabase, isProofModeEnabled } from "../../src/config/databaseSafety";
import { config as loadedConfig } from "../../src/config";
import { VesselSource } from "../../src/domain/enums/VesselSource";
import { connectMongo } from "../../src/infrastructure/persistence/mongo/connection";
import { CurrentVesselModel } from "../../src/infrastructure/persistence/mongo/currentVesselModel";
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
import { PROOF_REGIONS, ProofRegion } from "./regions";

const SAMPLE = "multi-source-sample";
const SNAPSHOT = "basics-proof-snapshot";

const FIELDS = ["vesselName", "mmsi", "imo", "vType", "latLon", "course", "speed", "navStatus", "received"] as const;
type Field = (typeof FIELDS)[number];

const PLACEHOLDER = new Set(["", "-", "--", "---", "n/a", "unknown"]);
const usable = (v: unknown) => typeof v === "string" && !PLACEHOLDER.has(v.trim().toLowerCase());

function basicsOf(doc: any): Record<Field, boolean> {
  const p = doc?.position;
  const m = p?.motion;
  const nav = m?.navStatus;
  return {
    vesselName: usable(doc?.identity?.name?.value),
    mmsi: typeof doc?.mmsi === "string" && doc.mmsi.length === 9,
    imo: typeof doc?.identity?.imo?.value === "string",
    // §16 — numeric AIS code ONLY. Text type is not vType.
    vType: typeof doc?.identity?.vesselTypeCode?.value === "number",
    latLon: typeof p?.position?.lat === "number" && typeof p?.position?.lng === "number",
    course: typeof m?.course === "number",
    speed: typeof m?.speed === "number",
    navStatus: typeof nav?.code === "number" || usable(nav?.text),
    received: m?.observedAt != null,
  };
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((1000 * n) / d) / 10);

async function loadSample(): Promise<{ mmsi: string; region: ProofRegion }[]> {
  return (await mongoose.connection.db!.collection(SAMPLE).find({}).toArray()) as never;
}

async function measure(sample: { mmsi: string; region: ProofRegion }[]) {
  const rows: { mmsi: string; region: ProofRegion; basics: Record<Field, boolean> }[] = [];
  for (const s of sample) {
    const doc = await CurrentVesselModel.findOne({ mmsi: s.mmsi }).lean();
    rows.push({ mmsi: s.mmsi, region: s.region, basics: basicsOf(doc) });
  }
  return rows;
}

const coverage = (rows: { basics: Record<Field, boolean> }[]) =>
  Object.fromEntries(FIELDS.map((f) => [f, pct(rows.filter((r) => r.basics[f]).length, rows.length)])) as Record<Field, number>;

function buildUseCase() {
  const runtime = new SourceRuntimeManager();
  const registry = new ProviderRegistry();
  const vfHttp = new HttpClient({ timeoutMs: runtime.getConfig(VesselSource.VESSELFINDER).timeoutMs });
  registry.register(new VesselFinderProvider({
    detailsSource: new VesselFinderHtmlSource(vfHttp),
    areaScanner: new VesselFinderMapSource(vfHttp),
  }));
  registry.register(new ShipFinderProvider({
    client: new ShipFinderClient({ http: new HttpClient({ timeoutMs: runtime.getConfig(VesselSource.SHIPFINDER).timeoutMs }) }),
    sourceUtcOffsetMinutes: loadedConfig.shipFinderSourceUtcOffsetMinutes,
  }));
  registry.register(new ShipInfoProvider({
    client: new ShipInfoClient({ http: new HttpClient({ timeoutMs: runtime.getConfig(VesselSource.SHIPINFO).timeoutMs }) }),
  }));

  const observationRepository = new MongoVesselObservationRepository();
  const collect = new CollectVesselObservations({
    registry,
    runtime,
    recorder: new ObservationRecorder({ repository: observationRepository }),
    parserVersionBySource: {
      [VesselSource.SHIPFINDER]: SHIPFINDER_PARSER_VERSION,
      [VesselSource.SHIPINFO]: SHIPINFO_PARSER_VERSION,
    },
  });
  return new CompleteVesselBasics({
    currentVesselRepository: new MongoCurrentVesselRepository(),
    collect,
    resolveAndStore: new ResolveAndStoreCurrentVessel({
      resolve: new ResolveCurrentVessel({ repository: observationRepository }),
      repository: new MongoCurrentVesselRepository(),
    }),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.find((a) => a.startsWith("--mode="))?.slice(7) ?? "after";
  const cycle = args.find((a) => a.startsWith("--cycle="))?.slice(8) ?? "1";

  if (!isProofModeEnabled()) throw new Error("Set BOT_DATA_PROOF_MODE=true");
  const { dbName } = assertSafeBotDatabase({ mongoUri: loadedConfig.mongoUri, proofMode: true });
  if (loadedConfig.botAisEnabled || loadedConfig.paidFallbackEnabled) throw new Error("AIS/paid must be off");
  await connectMongo(loadedConfig.mongoUri);

  const sample = await loadSample();
  console.log(`db=${dbName} sample=${sample.length} mode=${mode} shipFinderOffset=${loadedConfig.shipFinderSourceUtcOffsetMinutes ?? "UNSET"}`);

  if (mode === "before") {
    const rows = await measure(sample);
    await mongoose.connection.db!.collection(SNAPSHOT).deleteMany({ tag: "before" });
    await mongoose.connection.db!.collection(SNAPSHOT).insertOne({ tag: "before", coverage: coverage(rows), rows });
    console.log("BEFORE coverage:", JSON.stringify(coverage(rows), null, 2));
    await mongoose.disconnect();
    return;
  }

  if (mode === "complete") {
    const useCase = buildUseCase();
    let requests = 0;
    const statuses: Record<string, number> = {};
    const sourceCalls: Record<string, number> = {};
    const t0 = Date.now();
    for (const vessel of sample) {
      const r = await useCase.execute(vessel.mmsi);
      requests += r.requests;
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      for (const a of r.attempts) sourceCalls[a.source] = (sourceCalls[a.source] ?? 0) + 1;
    }
    const summary = {
      cycle: Number(cycle),
      vessels: sample.length,
      lookupRequests: requests,
      lookupRequestsPer100Vessels: Math.round((requests / sample.length) * 100),
      statuses,
      sourceCalls,
      durationMs: Date.now() - t0,
    };
    await mongoose.connection.db!.collection(SNAPSHOT).insertOne({ tag: `cycle${cycle}`, ...summary });
    console.log(JSON.stringify(summary, null, 2));
    await mongoose.disconnect();
    return;
  }

  // ---- after / report ----
  const rows = await measure(sample);
  const before = await mongoose.connection.db!.collection(SNAPSHOT).findOne({ tag: "before" });
  const cycles = await mongoose.connection.db!.collection(SNAPSHOT).find({ tag: /^cycle/ }).toArray();
  const after = coverage(rows);
  const byRegion = Object.fromEntries(
    PROOF_REGIONS.map((r) => [r, coverage(rows.filter((x) => x.region === r))])
  );

  const md: string[] = [];
  md.push("# PHASE 5 — VESSELBASICS COMPLETION", "");
  md.push(`- Database: \`${dbName}\` · AIS off · paid off`);
  md.push(`- Sample: ${sample.length} known vessels · ` + PROOF_REGIONS.map((r) => `${r}=${rows.filter((x) => x.region === r).length}`).join(" "));
  md.push(`- ShipFinder UTC offset: ${loadedConfig.shipFinderSourceUtcOffsetMinutes ?? "UNSET"}`, "");
  md.push("## MAP-only vs AFTER BasicCompletion (§10)", "");
  md.push("| FIELD | BEFORE | AFTER |", "|---|---:|---:|");
  for (const f of FIELDS) md.push(`| ${f} | ${(before?.coverage?.[f] ?? 0)}% | ${after[f]}% |`);
  md.push("", "## Regional (§9)", "");
  md.push(`| FIELD | ${PROOF_REGIONS.join(" | ")} | ALL |`, `|---|${PROOF_REGIONS.map(() => "---:").join("|")}|---:|`);
  for (const f of FIELDS) md.push(`| ${f} | ${PROOF_REGIONS.map((r) => (byRegion as any)[r][f] + "%").join(" | ")} | ${after[f]}% |`);
  md.push("", "## Request amplification (§11/§12)", "");
  md.push("| cycle | vessels | lookup requests | per 100 vessels | statuses |", "|---|---:|---:|---:|---|");
  for (const c of cycles.sort((a: any, b: any) => a.cycle - b.cycle)) {
    md.push(`| ${(c as any).cycle} | ${(c as any).vessels} | **${(c as any).lookupRequests}** | ${(c as any).lookupRequestsPer100Vessels} | ${JSON.stringify((c as any).statuses)} |`);
  }
  md.push("", "## Source contribution", "");
  for (const c of cycles.sort((a: any, b: any) => a.cycle - b.cycle)) {
    md.push(`- cycle ${(c as any).cycle}: ${JSON.stringify((c as any).sourceCalls)}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const dir = path.join(process.cwd(), "docs", "reports");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `vessel-basics-completion-${stamp}.md`), md.join("\n"), "utf8");
  fs.writeFileSync(path.join(dir, `vessel-basics-completion-${stamp}.json`),
    JSON.stringify({ database: dbName, sample: sample.length, before: before?.coverage ?? null, after, byRegion, cycles }, null, 2), "utf8");
  console.log(md.join("\n"));
  console.log(`\nWrote docs/reports/vessel-basics-completion-${stamp}.{md,json}`);
  await mongoose.disconnect();
}

void main().catch(async (err) => {
  console.error(`FATAL: ${(err as Error).message}`);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
