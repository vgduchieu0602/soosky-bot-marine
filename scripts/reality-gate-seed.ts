/**
 * REALITY-GATE-1: Bot observation -> resolver -> canonical_current_vessels
 * Uses real Mongo repositories. No mocked repos.
 */
import mongoose from "mongoose";
import { IngestAisBatch } from "../src/application/use-cases/ingestion/IngestAisBatch";
import { ResolveAndStoreCurrentVessel } from "../src/application/use-cases/resolution/ResolveAndStoreCurrentVessel";
import { ResolveCurrentVessel } from "../src/application/use-cases/resolution/ResolveCurrentVessel";
import { VesselSource } from "../src/domain/enums/VesselSource";
import { createSourceMetadata } from "../src/domain/value-objects/SourceMetadata";
import { MongoCurrentVesselRepository } from "../src/infrastructure/persistence/mongo/MongoCurrentVesselRepository";
import { MongoVesselObservationRepository } from "../src/infrastructure/persistence/mongo/MongoVesselObservationRepository";
import { CurrentVesselModel } from "../src/infrastructure/persistence/mongo/currentVesselModel";

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/soosky_marine_reality_gate";
const NOW = new Date(process.env.REALITY_NOW || "2026-08-17T12:00:00.000Z");

function entry(opts: {
  mmsi: string;
  name: string;
  lat: number;
  lng: number;
  course: number;
  speed: number;
  ageMs: number;
  imo?: string | null;
  partial?: boolean;
}) {
  const observedAt = new Date(NOW.getTime() - opts.ageMs);
  const metadata = createSourceMetadata({
    source: VesselSource.SHIPINFO,
    fetchedAt: NOW,
    sourceReceivedAt: observedAt,
  });
  return {
    mmsi: opts.mmsi,
    identity: {
      mmsi: opts.mmsi,
      imo: opts.imo ?? null,
      name: opts.partial ? null : opts.name,
      callsign: null,
      vesselType: opts.partial ? null : "Cargo",
      vesselTypeCode: opts.partial ? null : 70,
      flag: null,
      metadata,
    },
    position: {
      mmsi: opts.mmsi,
      imo: opts.imo ?? null,
      lat: opts.lat,
      lng: opts.lng,
      speed: opts.speed,
      course: opts.course,
      heading: null,
      navStatus: { code: 0, text: "Under way using engine" },
      latLngApproximate: false,
      receivedAt: observedAt,
      metadata,
    },
  };
}

async function main() {
  await mongoose.connect(URI);
  console.log("connected", mongoose.connection.name);
  await mongoose.connection.db!.dropDatabase();
  await CurrentVesselModel.createIndexes();
  const indexes = await mongoose.connection.db!.collection("canonical_current_vessels").indexes();
  console.log("indexes", JSON.stringify(indexes, null, 2));

  const observationRepository = new MongoVesselObservationRepository();
  const currentVesselRepository = new MongoCurrentVesselRepository();
  const resolveAndStore = new ResolveAndStoreCurrentVessel({
    resolve: new ResolveCurrentVessel({ repository: observationRepository }),
    repository: currentVesselRepository,
  });
  const ingest = new IngestAisBatch({
    repository: observationRepository,
    resolveAndStore,
    parserVersion: "reality-gate-1",
    resolveConcurrency: 4,
  });

  const vessels = [
    entry({ mmsi: "111000001", name: "FRESH CRAWL", lat: 10.1, lng: 106.7, course: 10, speed: 8, ageMs: 2 * 60_000, imo: "9110001" }),
    entry({ mmsi: "111000002", name: "STALE CRAWL", lat: 10.2, lng: 106.8, course: 20, speed: 9, ageMs: 2 * 60 * 60_000, imo: "9110002" }),
    entry({ mmsi: "111000003", name: "CRAWL ONLY", lat: 10.3, lng: 106.9, course: 30, speed: 5, ageMs: 5 * 60_000, imo: "9110003" }),
    entry({ mmsi: "111000004", name: "PARTIAL", lat: 10.4, lng: 107.0, course: 40, speed: 6, ageMs: 3 * 60_000, imo: null, partial: true }),
    entry({ mmsi: "222000001", name: "CRAWL WIN", lat: 11.0, lng: 108.0, course: 111, speed: 11, ageMs: 60_000, imo: "9220001" }),
    entry({ mmsi: "222000002", name: "CRAWL LOSE", lat: 12.0, lng: 109.0, course: 122, speed: 12, ageMs: 3 * 60 * 60_000, imo: "9220002" }),
  ];

  for (let i = 0; i < 20; i++) {
    vessels.push(
      entry({
        mmsi: String(300000000 + i),
        name: `GRID ${i}`,
        lat: 9.5 + (i % 5) * 0.4,
        lng: 105.5 + Math.floor(i / 5) * 0.4,
        course: i * 10,
        speed: 1 + (i % 7),
        ageMs: 4 * 60_000,
      })
    );
  }

  const result = await ingest.execute({
    entries: vessels as any,
    createdAt: NOW,
    remaining: 0,
  });
  console.log("ingest", result);

  const sample = await mongoose.connection.db!.collection("canonical_current_vessels").findOne({ mmsi: "111000001" });
  const redacted = JSON.parse(JSON.stringify(sample, (_k, v) => (v instanceof Date ? v.toISOString() : v)));
  console.log("SAMPLE_DOC", JSON.stringify(redacted, null, 2));
  console.log("count", await mongoose.connection.db!.collection("canonical_current_vessels").countDocuments());

  const explain = await mongoose.connection.db!
    .collection("canonical_current_vessels")
    .find({
      location: {
        $geoWithin: {
          $geometry: {
            type: "Polygon",
            coordinates: [[[100, 0], [120, 0], [120, 20], [100, 20], [100, 0]]],
          },
        },
      },
    })
    .limit(5)
    .explain("executionStats");
  const wp = explain.queryPlanner?.winningPlan || explain;
  console.log("EXPLAIN_WINNING", JSON.stringify(wp, null, 2).slice(0, 4000));
  console.log(
    "EXPLAIN_STATS",
    JSON.stringify(
      {
        nReturned: explain.executionStats?.nReturned,
        totalKeysExamined: explain.executionStats?.totalKeysExamined,
        totalDocsExamined: explain.executionStats?.totalDocsExamined,
        executionTimeMillis: explain.executionStats?.executionTimeMillis,
        stage: explain.executionStats?.executionStages?.stage,
        indexName:
          explain.executionStats?.executionStages?.indexName ||
          explain.executionStats?.executionStages?.inputStage?.indexName,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
