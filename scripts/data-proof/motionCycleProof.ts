/**
 * PHASE 3.1 — MOTION CYCLE PROOF (real Mongo, real pipeline).
 *
 * Proves the thing a unit test cannot: that motion SURVIVES in the database
 * across crawl cycles and across a process restart.
 *
 *   cycle=1  map scan -> observations -> detail -> observations -> resolve -> canonical
 *   cycle=2  map scan ONLY -> observations -> resolve -> canonical
 *   report   read canonical back and print the coordinate/motion matrix
 *
 * Every stage below the HTTP fetch is the production class:
 *   VesselFinderHtmlMapper · VesselFinderProvider · ObservationRecorder
 *   · MongoVesselObservationRepository · ResolveAndStoreCurrentVessel
 *   · MongoCurrentVesselRepository
 *
 * Canonical is NEVER written by hand — only ResolveAndStoreCurrentVessel writes it.
 *
 * ⚠️ TRANSPORT ONLY IS SIMULATED. VesselFinder is currently refusing this host,
 * so the detail HTML and the map rows come from a local fixture instead of the
 * network. Nothing else is stubbed. Values are therefore representative, not a
 * live sample — see the report header, which states this in its output.
 *
 * Usage (each cycle is a SEPARATE process — that is the restart proof):
 *   ts-node scripts/data-proof/motionCycleProof.ts --cycle=1
 *   ts-node scripts/data-proof/motionCycleProof.ts --cycle=2
 *   ts-node scripts/data-proof/motionCycleProof.ts --mode=report
 */
import mongoose from "mongoose";

import { ObservationRecorder } from "../../src/application/services/observation/ObservationRecorder";
import { ResolveAndStoreCurrentVessel } from "../../src/application/use-cases/resolution/ResolveAndStoreCurrentVessel";
import { ResolveCurrentVessel } from "../../src/application/use-cases/resolution/ResolveCurrentVessel";
import { IAreaScanner, ScannedShip } from "../../src/application/contracts/geo/IAreaScanner";
import { IVesselDetailsSource } from "../../src/application/contracts/providers/IVesselDetailsSource";
import { assertSafeBotDatabase, isProofModeEnabled } from "../../src/config/databaseSafety";
import { config as loadedConfig } from "../../src/config";
import { mmsiIdentifier } from "../../src/domain/value-objects/VesselIdentifier";
import { connectMongo } from "../../src/infrastructure/persistence/mongo/connection";
import { CurrentVesselModel } from "../../src/infrastructure/persistence/mongo/currentVesselModel";
import { VesselObservationModel } from "../../src/infrastructure/persistence/mongo/observationModels";
import { MongoCurrentVesselRepository } from "../../src/infrastructure/persistence/mongo/MongoCurrentVesselRepository";
import { MongoVesselObservationRepository } from "../../src/infrastructure/persistence/mongo/MongoVesselObservationRepository";
import { VesselFinderHtmlMapper } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderHtmlMapper";
import { VesselFinderProvider } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderProvider";

const BOX = { minLat: 50, minLon: 0, maxLat: 52, maxLon: 2 };

/** Ba con tàu: đang chạy, buộc bến (giá trị 0), và một bản không có mốc nguồn. */
const FLEET = [
  { mmsi: "232007487", sog: 9.4, cog: 187, lrpd: "3 min ago", nav: "Under way using engine", lat: 51.234567, lon: 1.234567 },
  { mmsi: "235018306", sog: 0, cog: 0, lrpd: "0 min ago", nav: "Moored", lat: 51.311111, lon: 1.088888 },
  { mmsi: "210649000", sog: 4.2, cog: 275, lrpd: null, nav: "-", lat: 50.987654, lon: 0.456789 },
] as const;

type Ship = (typeof FLEET)[number];

function detailHtml(ship: Ship): string {
  const djson: Record<string, unknown> = {
    mmsi: Number(ship.mmsi),
    // Trang chi tiết VesselFinder LÀM TRÒN toạ độ về số nguyên.
    ship_lat: Math.round(ship.lat),
    ship_lon: Math.round(ship.lon),
    ship_sog: ship.sog,
    ship_cog: ship.cog,
  };
  if (ship.lrpd !== null) djson.lrpd = ship.lrpd;
  return (
    `<h1 class="title">CYCLE PROOF ${ship.mmsi}</h1>` +
    `<div id="djson" data-json='${JSON.stringify(djson)}'></div>` +
    `<table><td class="n3">IMO / MMSI</td><td class="v3"> / ${ship.mmsi}</td>` +
    `<td class="n3">Navigation Status</td><td class="v3">${ship.nav}</td></table>`
  );
}

/**
 * Ô map: toạ độ CHÍNH XÁC, không có chuyển động, không có mốc nguồn.
 *
 * Chu kỳ sau cho tàu dịch đi một chút — nếu để y nguyên toạ độ thì observation
 * trùng vân tay và bị cửa sổ dedupe bỏ qua, tức là chu kỳ 2 sẽ KHÔNG ghi gì cả
 * và phép thử "ô map mới có che mất chuyển động không" trở nên vô nghĩa.
 */
function mapRows(cycle: number): ScannedShip[] {
  const drift = (cycle - 1) * 0.002;
  return FLEET.map((s) => ({
    mmsi: s.mmsi,
    name: `CYCLE PROOF ${s.mmsi}`,
    lat: s.lat + drift,
    lon: s.lon + drift,
  }));
}

function providerFor(ship: Ship | null, cycle = 1): VesselFinderProvider {
  const detailsSource: IVesselDetailsSource = {
    async getDetails() {
      if (ship === null) throw new Error("detail not requested in this cycle");
      return VesselFinderHtmlMapper.toDomain(detailHtml(ship));
    },
  };
  const areaScanner: IAreaScanner = {
    async fetchArea() {
      return mapRows(cycle);
    },
  };
  return new VesselFinderProvider({ detailsSource, areaScanner });
}

function buildPipeline() {
  const observationRepository = new MongoVesselObservationRepository();
  const recorder = new ObservationRecorder({
    repository: observationRepository,
    parserVersion: "vesselfinder-html-v1",
  });
  const resolveAndStore = new ResolveAndStoreCurrentVessel({
    resolve: new ResolveCurrentVessel({ repository: observationRepository }),
    repository: new MongoCurrentVesselRepository(),
  });
  return { recorder, resolveAndStore };
}

async function runCycle(cycle: 1 | 2): Promise<void> {
  const { recorder, resolveAndStore } = buildPipeline();

  // --- discovery: ô map (cả hai chu kỳ đều chạy) ---
  const scanned = await providerFor(null, cycle).scanArea(BOX);
  const savedMap = await recorder.recordPositions(scanned);
  console.log(`[cycle ${cycle}] map rows=${scanned.length} observations saved=${savedMap.filter((r) => r.status === "SAVED").length}`);

  // --- enrichment: trang chi tiết (CHỈ chu kỳ 1) ---
  if (cycle === 1) {
    for (const ship of FLEET) {
      const details = await providerFor(ship).getDetails(mmsiIdentifier(ship.mmsi));
      if (details === null) continue;
      await recorder.recordDetails(details);
    }
    console.log(`[cycle ${cycle}] detail pages recorded=${FLEET.length}`);
  } else {
    console.log(`[cycle ${cycle}] NO detail pass — this is the cycle that used to erase motion`);
  }

  // --- resolve: canonical chỉ được ghi qua use case ---
  for (const ship of FLEET) {
    await resolveAndStore.execute({ mmsi: ship.mmsi });
  }
  console.log(`[cycle ${cycle}] resolved ${FLEET.length} vessels into canonical`);
}

async function report(): Promise<void> {
  const observations = await VesselObservationModel.countDocuments();
  const canonical = await CurrentVesselModel.countDocuments();
  const collections = (await mongoose.connection.db!.listCollections().toArray())
    .map((c) => c.name)
    .sort();

  console.log(`\nobservations=${observations} canonical=${canonical}`);
  console.log(`collections: ${collections.join(", ")}`);

  const LEGACY = ["latestpositions", "vesselpositions", "vessels", "watchlistitems"];
  const resurrected = LEGACY.filter((name) => collections.includes(name));
  console.log(`legacy collections present: ${resurrected.length ? resurrected.join(", ") : "NONE"}`);

  console.log("\n| mmsi | lat/lon | precise | coord observedAt | speed | course | navStatus | motion observedAt | motion freshness |");
  console.log("|---|---|---|---|---:|---:|---:|---|---|");
  for (const ship of FLEET) {
    const doc = (await CurrentVesselModel.findOne({ mmsi: ship.mmsi }).lean()) as any;
    const p = doc?.position;
    const m = p?.motion;
    console.log(
      `| ${ship.mmsi} | ${p ? `${p.position.lat}/${p.position.lng}` : "—"} | ${p ? p.position.latLngApproximate !== true : "—"} | ` +
        `${p?.observedAt ? new Date(p.observedAt).toISOString() : "null"} | ` +
        `${m?.speed ?? "—"} | ${m?.course ?? "—"} | ${m?.navStatus?.code ?? "—"} | ` +
        `${m?.observedAt ? new Date(m.observedAt).toISOString() : "null"} | ${m?.freshness ?? "—"} |`
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cycleRaw = args.find((a) => a.startsWith("--cycle="))?.slice(8);
  const mode = args.find((a) => a.startsWith("--mode="))?.slice(7);

  if (!isProofModeEnabled()) throw new Error("Set BOT_DATA_PROOF_MODE=true to run this proof.");
  const { dbName } = assertSafeBotDatabase({ mongoUri: loadedConfig.mongoUri, proofMode: true });
  if (loadedConfig.botAisEnabled) throw new Error("BOT_AIS_ENABLED must be false");
  if (loadedConfig.paidFallbackEnabled) throw new Error("PAID_FALLBACK_ENABLED must be false");

  // Kết nối Mongo TRỰC TIẾP, không qua buildContainer: container còn dựng cả các
  // repository legacy, và chính việc dựng chúng làm hồi sinh những collection cũ
  // (xem báo cáo §38). Proof này phải chứng minh được collection nào là do
  // đường ống hiện tại tạo ra.
  await connectMongo(loadedConfig.mongoUri);
  console.log(`db=${dbName} ais=false paid=false | transport=FIXTURE (VesselFinder blocking this host)`);

  if (mode === "report") await report();
  else if (cycleRaw === "1" || cycleRaw === "2") await runCycle(Number(cycleRaw) as 1 | 2);
  else throw new Error("Usage: --cycle=1 | --cycle=2 | --mode=report");

  await mongoose.disconnect();
}

void main().catch(async (err) => {
  console.error(`FATAL: ${(err as Error).message}`);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
