// ============================================================================
//  INTERFACE (CLI) · Đo truy vấn gộp cụm trên Mongo — CHỈ ĐỌC, chạy tay
// ----------------------------------------------------------------------------
//  Chạy:  npm run map:cluster-poc
//         npm run map:cluster-poc -- --zoom=2 --limit=500
//         npm run map:cluster-poc -- --seed=10000
//
//  Trả lời hai câu unit test không trả lời được:
//    1. Pipeline gộp cụm có DÙNG `location_2dsphere` không, hay quét cả bảng?
//    2. Công thức lưới trong pipeline có KHỚP bản JS không?
//
//  Câu 2 quan trọng ngang câu 1: lệch nhau nghĩa là khoá cụm đổi giữa hai đường
//  đọc và marker trên FE nhảy chỗ.
// ============================================================================

import { config } from "../../config";
import { BoundingBox } from "../../application/contracts/geo/Geo";
import { resolveViewport, WORLD_BOUNDING_BOX } from "../../application/services/map/MapBoundingBox";
import { gridCellId, toGridCell } from "../../application/services/map/MapGrid";
import { planMapQuery, MapQueryMode } from "../../application/services/map/MapQueryStrategy";
import { DEFAULT_MAP_READINESS_POLICY } from "../../application/services/map/MapVesselReadiness";
import { GetMapVessels } from "../../application/use-cases/map/GetMapVessels";
import { QueryMap } from "../../application/use-cases/map/QueryMap";
import { connectMongo } from "../../infrastructure/persistence/mongo/connection";
import { CurrentVesselModel } from "../../infrastructure/persistence/mongo/currentVesselModel";
import {
  MongoMapClusterRepository,
  buildClusterPipeline,
} from "../../infrastructure/persistence/mongo/MongoMapClusterRepository";
import { MongoMapVesselRepository } from "../../infrastructure/persistence/mongo/MongoMapVesselRepository";

const TEST_DB_HINTS = ["test", "sim", "load", "map", "sandbox", "dev", "local", "staging"];

function readFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim();
}

function readBbox(args: string[]): BoundingBox {
  const raw = readFlag(args, "bbox");
  if (raw === undefined) return { ...WORLD_BOUNDING_BOX };
  const parts = raw.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    console.error("❌ --bbox=minLat,minLon,maxLat,maxLon");
    process.exit(1);
  }
  return { minLat: parts[0], minLon: parts[1], maxLat: parts[2], maxLon: parts[3] };
}

function describeUri(uri: string): { safe: string; database: string } {
  try {
    const parsed = new URL(uri);
    return {
      safe: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
      database: parsed.pathname.replace(/^\//, ""),
    };
  } catch {
    return { safe: "(không phân tích được URI)", database: "" };
  }
}

async function seed(count: number): Promise<void> {
  const now = Date.now();
  const docs = Array.from({ length: count }, (_, index) => {
    const lat = -70 + ((index * 37) % 1400) / 10;
    const lon = -180 + ((index * 71) % 3600) / 10;
    const observedAt = new Date(now - (index % 5 === 0 ? 3 * 24 * 3600_000 : 60_000));
    const mmsi = String(200_000_000 + index);
    return {
      mmsi,
      resolvedAt: new Date(now),
      contentHash: `h${index}`,
      identity: { mmsi },
      position: {
        position: {
          mmsi,
          lat,
          lng: lon,
          speed: index % 3 === 0 ? 0 : 12,
          course: 90,
          navStatus: { code: 0, text: "Under way using engine" },
          latLngApproximate: false,
          receivedAt: observedAt,
          metadata: { source: "aisstream", fetchedAt: new Date(now), sourceReceivedAt: observedAt },
        },
        source: "aisstream",
        observedAt,
        fetchedAt: new Date(now),
        freshness: "LIVE",
        reason: "ONLY_AVAILABLE_VALUE",
        rejected: [],
      },
      location: { type: "Point", coordinates: [lon, lat] },
    };
  });

  await CurrentVesselModel.deleteMany({});
  await CurrentVesselModel.syncIndexes();
  for (let i = 0; i < docs.length; i += 2000) {
    await CurrentVesselModel.insertMany(docs.slice(i, i + 2000));
  }
}

interface ExplainSummary {
  stages: string;
  indexName: string | null;
  docsExamined: number;
  keysExamined: number;
  millis: number;
}

async function explainPipeline(pipeline: Record<string, unknown>[]): Promise<ExplainSummary> {
  const plan = (await CurrentVesselModel.aggregate(pipeline as never[]).explain(
    "executionStats"
  )) as unknown as Record<string, unknown>;
  const serialized = JSON.stringify(plan);
  const stats = /"executionStats":\{[^}]*"totalDocsExamined":(\d+)/.exec(serialized);
  return {
    stages: (serialized.match(/"stage":"[A-Z_]+"/g) ?? [])
      .map((s) => s.split(":")[1].replace(/"/g, ""))
      .join(" <- "),
    indexName: /"indexName":"([^"]+)"/.exec(serialized)?.[1] ?? null,
    docsExamined: Number(stats?.[1] ?? /"totalDocsExamined":(\d+)/.exec(serialized)?.[1] ?? -1),
    keysExamined: Number(/"totalKeysExamined":(\d+)/.exec(serialized)?.[1] ?? -1),
    millis: Number(/"executionTimeMillis":(\d+)/.exec(serialized)?.[1] ?? -1),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (config.mongoUri === "") {
    console.error("❌ Chưa đặt MONGODB_URI.");
    process.exit(1);
  }
  const { safe, database } = describeUri(config.mongoUri);
  await connectMongo(config.mongoUri);

  const seedCount = readFlag(args, "seed");
  if (seedCount !== undefined) {
    if (!TEST_DB_HINTS.some((hint) => database.toLowerCase().includes(hint))) {
      console.error(`❌ --seed GHI THẬT; "${database}" không có dấu hiệu là DB thử nghiệm.`);
      process.exit(1);
    }
    console.log(`🌱 Nạp ${seedCount} tàu tổng hợp vào ${safe}…`);
    await seed(Number(seedCount));
  }

  const bbox = readBbox(args);
  const limit = Number(readFlag(args, "limit") ?? 500);
  const total = await CurrentVesselModel.estimatedDocumentCount();
  console.log(`\n🗺️  Map cluster POC\n   target=${safe}\n   document=${total.toLocaleString("en-US")}\n`);

  const useCase = new QueryMap({
    vessels: new GetMapVessels({ repository: new MongoMapVesselRepository() }),
    clusters: new MongoMapClusterRepository(),
  });

  const since = new Date(Date.now() - DEFAULT_MAP_READINESS_POLICY.maxPositionAgeMs);
  const scenarios = Number(readFlag(args, "zoom") ?? Number.NaN);
  const zooms = Number.isFinite(scenarios) ? [scenarios] : [2, 4, 6, 8];

  let allIndexed = true;
  let lastClusterBytes = 0;
  for (const zoom of zooms) {
    const plan = planMapQuery(zoom);
    const viewport = resolveViewport(bbox);
    if (!viewport.ok) {
      console.log(`zoom ${zoom}: bbox không hợp lệ (${viewport.reason})`);
      continue;
    }

    const started = Date.now();
    const result = await useCase.execute({ bbox, zoom, limit });
    const elapsed = Date.now() - started;

    if (result.mode === MapQueryMode.CLUSTERS) {
      const summary = await explainPipeline(
        buildClusterPipeline({
          boxes: viewport.boxes,
          gridZoom: plan.gridZoom,
          observedSince: since,
          observedBefore: new Date(Date.now() + DEFAULT_MAP_READINESS_POLICY.futureToleranceMs),
          limit,
        })
      );
      const usesIndex = summary.indexName === "location_2dsphere";
      allIndexed = allIndexed && usesIndex;

      const json = JSON.stringify(result.clusters);
      const bytes = result.clusters.length === 0 ? 0 : Math.round(Buffer.byteLength(json, "utf8") / result.clusters.length);
      if (bytes > 0) lastClusterBytes = bytes;
      console.log(
        `▸ zoom ${zoom} · CLUSTERS · lưới ${result.gridZoom}\n` +
          `   cụm=${result.clusters.length} tàu đại diện=${result.representedVessels} truncated=${result.truncated} ${elapsed}ms\n` +
          `   ${usesIndex ? "✅" : "❌"} ${summary.stages} | index=${summary.indexName ?? "—"}` +
          ` docsExamined=${summary.docsExamined} keysExamined=${summary.keysExamined} ${summary.millis}ms\n` +
          `   payload=${(Buffer.byteLength(json, "utf8") / 1024).toFixed(1)} KiB · ≈${bytes} B/cụm`
      );
      if (result.clusters.length > 0) {
        console.log(`   mẫu: ${JSON.stringify(result.clusters[0])}`);
        // Đối chiếu công thức lưới của pipeline với bản JS.
        const first = result.clusters[0];
        const recomputed = gridCellId(toGridCell(first.lat, first.lon, result.gridZoom));
        const match = recomputed === first.id;
        console.log(`   ${match ? "✅" : "⚠️"} lưới JS vs pipeline: ${first.id} ${match ? "==" : "!="} ${recomputed}`);
      }
    } else {
      const json = JSON.stringify(result.items);
      const bytes = result.items.length === 0 ? 0 : Math.round(Buffer.byteLength(json, "utf8") / result.items.length);
      console.log(
        `▸ zoom ${zoom} · VESSELS\n` +
          `   tàu=${result.items.length} truncated=${result.truncated} ${elapsed}ms · ≈${bytes} B/tàu`
      );
    }
  }

  if (lastClusterBytes > 0) {
    console.log("\n📦 Ước lượng payload theo số cụm");
    for (const count of [100, 500, 1000]) {
      console.log(
        `   ${count} cụm ≈ ${((count * lastClusterBytes) / 1024).toFixed(1)} KiB` +
          ` (${lastClusterBytes} B/cụm đo được)`
      );
    }
  }

  console.log(`\n${allIndexed ? "✅" : "❌"} Cổng index cụm: ${allIndexed ? "dùng" : "KHÔNG dùng"} location_2dsphere.`);
  process.exit(allIndexed ? 0 : 1);
}

void main().catch((error) => {
  console.error(`❌ ${(error as Error).message}`);
  process.exit(1);
});
