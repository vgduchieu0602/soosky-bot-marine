// ============================================================================
//  INTERFACE (CLI) · Đo truy vấn viewport trên Mongo — CHỈ ĐỌC, chạy tay
// ----------------------------------------------------------------------------
//  Chạy:  npm run map:query-poc
//         npm run map:query-poc -- --bbox=5,100,15,110 --limit=1000
//         npm run map:query-poc -- --seed=10000        (nạp dữ liệu tổng hợp)
//
//  Trả lời ĐÚNG MỘT câu hỏi mà unit test không trả lời được:
//      truy vấn viewport có THẬT SỰ dùng `location_2dsphere` không?
//
//  MAP-1 đã đo `$box` rơi vào COLLSCAN. Script này là hàng rào để điều đó không
//  lặng lẽ quay lại.
//
//  ⚠️ CHỈ ĐỌC — trừ khi có `--seed`, và `--seed` chỉ ghi vào database mang dấu
//     hiệu thử nghiệm.
// ============================================================================

import { config } from "../../config";
import { MAP_QUERY_LIMITS } from "../../application/use-cases/map/GetMapVessels";
import { GetMapVessels } from "../../application/use-cases/map/GetMapVessels";
import { resolveViewport, WORLD_BOUNDING_BOX } from "../../application/services/map/MapBoundingBox";
import { BoundingBox } from "../../application/contracts/geo/Geo";
import { connectMongo } from "../../infrastructure/persistence/mongo/connection";
import { CurrentVesselModel } from "../../infrastructure/persistence/mongo/currentVesselModel";
import {
  MongoMapVesselRepository,
  buildMapFilter,
} from "../../infrastructure/persistence/mongo/MongoMapVesselRepository";

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
    const database = parsed.pathname.replace(/^\//, "") || "";
    return { safe: `${parsed.protocol}//${parsed.host}/${database}`, database };
  } catch {
    return { safe: "(không phân tích được URI)", database: "" };
  }
}

/** Dữ liệu tổng hợp rải đều để đo — chỉ dùng cho DB thử nghiệm. */
async function seed(count: number): Promise<void> {
  const now = Date.now();
  const docs = Array.from({ length: count }, (_, index) => {
    // Rải đều TOÀN CẦU: hai bước nguyên tố cùng nhau với `count` để không dồn
    // cục vào một bán cầu (bản seed đầu tiên mắc đúng lỗi đó).
    const lat = -70 + ((index * 37) % 1400) / 10;
    const lon = -180 + ((index * 71) % 3600) / 10;
    // 1/5 số tàu cố ý để CŨ -> đo được cả tác dụng của bộ lọc độ tươi.
    const observedAt = new Date(now - (index % 5 === 0 ? 3 * 24 * 3600_000 : 60_000));
    return {
      mmsi: String(200_000_000 + index),
      resolvedAt: new Date(now),
      contentHash: `h${index}`,
      identity: { mmsi: String(200_000_000 + index) },
      position: {
        position: {
          mmsi: String(200_000_000 + index),
          lat,
          lng: lon,
          speed: 10,
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
  nReturned: number;
  docsExamined: number;
  keysExamined: number;
  millis: number;
}

async function explain(filter: Record<string, unknown>, limit: number): Promise<ExplainSummary> {
  const plan = (await CurrentVesselModel.find(filter).limit(limit).explain(
    "executionStats"
  )) as unknown as {
    queryPlanner: { winningPlan: unknown };
    executionStats: Record<string, number>;
  };
  const serialized = JSON.stringify(plan.queryPlanner.winningPlan);
  const stats = plan.executionStats;
  return {
    stages: (serialized.match(/"stage":"[A-Z_]+"/g) ?? []).map((s) => s.split(":")[1].replace(/"/g, "")).join(" <- "),
    indexName: /"indexName":"([^"]+)"/.exec(serialized)?.[1] ?? null,
    nReturned: stats.nReturned,
    docsExamined: stats.totalDocsExamined,
    keysExamined: stats.totalKeysExamined,
    millis: stats.executionTimeMillis,
  };
}

function printExplain(label: string, summary: ExplainSummary): boolean {
  const usesIndex = summary.indexName === "location_2dsphere";
  console.log(
    `   ${label.padEnd(22)} ${usesIndex ? "✅" : "❌"} ${summary.stages}` +
      ` | index=${summary.indexName ?? "—"}` +
      ` | nReturned=${summary.nReturned} docsExamined=${summary.docsExamined}` +
      ` keysExamined=${summary.keysExamined} ${summary.millis}ms`
  );
  return usesIndex;
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

  const limit = Number(readFlag(args, "limit") ?? MAP_QUERY_LIMITS.defaultLimit);
  const total = await CurrentVesselModel.estimatedDocumentCount();
  console.log(`\n🗺️  Map query POC\n   target=${safe}\n   document trong kho=${total.toLocaleString("en-US")}\n`);

  const since = new Date(Date.now() - 24 * 3600_000);
  const viewports: Array<[string, BoundingBox]> = [
    ["nhỏ (10°×10°)", { minLat: 5, minLon: 100, maxLat: 15, maxLon: 110 }],
    ["vừa (40°×60°)", { minLat: -20, minLon: 60, maxLat: 20, maxLon: 120 }],
    ["toàn cầu", { ...WORLD_BOUNDING_BOX }],
    ["cắt kinh tuyến ±180", { minLat: -10, minLon: 170, maxLat: 10, maxLon: -170 }],
  ];

  let allIndexed = true;
  for (const [label, bbox] of viewports) {
    const viewport = resolveViewport(bbox);
    if (!viewport.ok) {
      console.log(`   ${label}: bbox không hợp lệ (${viewport.reason})`);
      continue;
    }
    console.log(`\n▸ ${label}  ${viewport.boxes.length} hộp`);
    const geoOnly = buildMapFilter({ boxes: viewport.boxes, candidateLimit: limit });
    const withTime = buildMapFilter({
      boxes: viewport.boxes,
      candidateLimit: limit,
      observedSince: since,
    });
    const a = printExplain("chỉ không gian", await explain(geoOnly, limit));
    const b = printExplain("+ lọc observedAt", await explain(withTime, limit));
    // Viewport toàn cầu quét gần hết collection là chuyện bình thường — nó
    // trúng mọi tàu. Cổng index chỉ áp cho viewport thật sự bị giới hạn.
    if (label !== "toàn cầu") allIndexed = allIndexed && a && b;
  }

  // Chạy thật qua use case để đo payload.
  const useCase = new GetMapVessels({ repository: new MongoMapVesselRepository() });
  const started = Date.now();
  const result = await useCase.execute({ bbox: readBbox(args), limit });
  const elapsed = Date.now() - started;

  const json = JSON.stringify(result.items);
  const bytesPerItem = result.items.length === 0 ? 0 : Math.round(Buffer.byteLength(json, "utf8") / result.items.length);

  console.log(`\n📦 Chạy thật qua GetMapVessels`);
  console.log(`   items=${result.items.length} truncated=${result.truncated} candidates=${result.candidatesScanned} ${elapsed}ms`);
  console.log(`   JSON tổng=${(Buffer.byteLength(json, "utf8") / 1024).toFixed(1)} KiB · ≈${bytesPerItem} B/tàu`);
  if (result.items.length > 0) {
    console.log(`   mẫu: ${JSON.stringify(result.items[0])}`);
  }
  for (const count of [500, 1000, 5000]) {
    console.log(`   ước lượng ${count} tàu ≈ ${((bytesPerItem * count) / 1024).toFixed(0)} KiB`);
  }

  console.log(`\n${allIndexed ? "✅" : "❌"} Cổng index: viewport có giới hạn ${allIndexed ? "đều dùng" : "KHÔNG dùng"} location_2dsphere.`);
  process.exit(allIndexed ? 0 : 1);
}

void main().catch((error) => {
  console.error(`❌ ${(error as Error).message}`);
  process.exit(1);
});
