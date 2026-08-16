// ============================================================================
//  INTERFACE (CLI) · Đo tải THẬT trên MongoDB — CHẠY TAY, PHẢI XÁC NHẬN
// ----------------------------------------------------------------------------
//  Chạy:  npm run marine-ais:mongo-load-poc -- --confirm
//         npm run marine-ais:mongo-load-poc -- --confirm --vessels=2000 --events=20000
//
//  ⛔ KHÔNG BAO GIỜ tự chạy. Không service nào, không test nào gọi file này.
//  ⛔ Nó GHI THẬT vào `vessel_observations` và `canonical_current_vessels` của
//     MONGODB_URI đang trỏ tới. Bắt buộc `--confirm`, và mặc định TỪ CHỐI mọi
//     URI không mang dấu hiệu là database thử nghiệm.
//
//  Đường chạy giống hệt production: buffer -> IngestAisBatch -> Mongo repository.
//  Khác duy nhất: sự kiện AIS là tổng hợp, không phải từ WebSocket.
// ============================================================================

import { config } from "../../config";
import { AisCoalescingBuffer } from "../../application/services/ingestion/AisCoalescingBuffer";
import { IngestAisBatch } from "../../application/use-cases/ingestion/IngestAisBatch";
import { ResolveAndStoreCurrentVessel } from "../../application/use-cases/resolution/ResolveAndStoreCurrentVessel";
import { ResolveCurrentVessel } from "../../application/use-cases/resolution/ResolveCurrentVessel";
import { VesselSource } from "../../domain/enums/VesselSource";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { connectMongo } from "../../infrastructure/persistence/mongo/connection";
import { MongoCurrentVesselRepository } from "../../infrastructure/persistence/mongo/MongoCurrentVesselRepository";
import { MongoVesselObservationRepository } from "../../infrastructure/persistence/mongo/MongoVesselObservationRepository";

const DEFAULTS = { vessels: 1_000, events: 10_000, batchSize: 500, drainEvery: 5_000, maxSeconds: 120 };
/** Dấu hiệu "đây là DB thử nghiệm". Không khớp -> từ chối chạy. */
const TEST_DB_HINTS = ["test", "sim", "load", "sandbox", "dev", "local", "staging"];

function readNumberFlag(args: string[], name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim();
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`❌ --${name} phải là số dương, nhận "${raw}".`);
    process.exit(1);
  }
  return Math.floor(value);
}

/** Che credential trước khi in — URI có thể mang user/password. */
function describeUri(uri: string): { safe: string; database: string } {
  try {
    const parsed = new URL(uri);
    const database = parsed.pathname.replace(/^\//, "") || "(mặc định)";
    return { safe: `${parsed.protocol}//${parsed.host}/${database}`, database };
  } catch {
    return { safe: "(không phân tích được URI)", database: "" };
  }
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const FETCHED_AT = new Date();

function positionEvent(index: number, tick: number) {
  const mmsi = String(200_000_000 + index);
  const sourceReceivedAt = new Date(FETCHED_AT.getTime() - 60_000 + tick * 1000);
  return {
    mmsi,
    receivedAt: FETCHED_AT,
    result: {
      position: {
        mmsi,
        imo: null,
        lat: -60 + (index % 12_000) / 100,
        lng: -180 + (index % 36_000) / 100,
        speed: (index % 25) + 0.4,
        course: index % 360,
        heading: null,
        navStatus: { code: index % 9, text: "Under way using engine" },
        latLngApproximate: false,
        receivedAt: sourceReceivedAt,
        metadata: createSourceMetadata({
          source: VesselSource.AISSTREAM,
          fetchedAt: FETCHED_AT,
          sourceReceivedAt,
        }),
      },
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const uri = config.mongoUri;

  if (uri === "") {
    console.error("❌ Chưa đặt MONGODB_URI.");
    process.exit(1);
  }
  const { safe, database } = describeUri(uri);

  if (!args.includes("--confirm")) {
    console.error(
      `❌ POC này GHI THẬT vào ${safe}.\n` +
        "   Thêm --confirm nếu bạn thực sự muốn chạy, và hãy trỏ vào database thử nghiệm."
    );
    process.exit(1);
  }
  const looksLikeTest = TEST_DB_HINTS.some((hint) => database.toLowerCase().includes(hint));
  if (!looksLikeTest && !args.includes("--force")) {
    console.error(
      `❌ Database "${database}" không có dấu hiệu là DB thử nghiệm (${TEST_DB_HINTS.join("/")}).\n` +
        "   Từ chối để khỏi bơm dữ liệu tổng hợp vào kho thật. Thêm --force nếu bạn chắc chắn."
    );
    process.exit(1);
  }

  const vessels = readNumberFlag(args, "vessels", DEFAULTS.vessels);
  const events = readNumberFlag(args, "events", DEFAULTS.events);
  const drainEvery = readNumberFlag(args, "drain-every", DEFAULTS.drainEvery);
  const maxSeconds = readNumberFlag(args, "max-seconds", DEFAULTS.maxSeconds);

  await connectMongo(uri);
  console.log(
    `\n🧪 Mongo load POC\n   target=${safe}\n   tàu=${vessels} sự kiện=${events} trần ${maxSeconds}s\n`
  );

  const buffer = new AisCoalescingBuffer({
    maxVessels: config.aisMaxBufferedVessels,
    batchSize: config.aisFlushBatchSize,
  });
  const observations = new MongoVesselObservationRepository();
  const ingest = new IngestAisBatch({
    repository: observations,
    resolveAndStore: new ResolveAndStoreCurrentVessel({
      resolve: new ResolveCurrentVessel({ repository: observations }),
      repository: new MongoCurrentVesselRepository(),
    }),
    parserVersion: "marine-ais-v1",
    resolveConcurrency: config.aisResolveConcurrency,
  });

  const maxRssMb = readNumberFlag(args, "max-rss-mb", 0);
  const batchDurations: number[] = [];
  const resolveDurations: number[] = [];
  let saved = 0;
  let duplicates = 0;
  let resolvedVessels = 0;
  let coalescedEntries = 0;
  let peakRss = process.memoryUsage().rss;
  let peakHeap = process.memoryUsage().heapUsed;
  const deadline = Date.now() + maxSeconds * 1000;
  let stoppedEarly = false;
  let stopReason = "";

  /**
   * Điều kiện dừng SỚM. Cố ý là ba phép so đơn giản trong chính vòng lặp —
   * không daemon, không watchdog, không thư viện giám sát.
   */
  const shouldStop = (): string | null => {
    if (Date.now() > deadline) return `hết ${maxSeconds}s`;
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    if (maxRssMb > 0 && rssMb > maxRssMb) return `RSS ${rssMb.toFixed(0)}MB vượt --max-rss-mb=${maxRssMb}`;
    // Trễ mẻ TĂNG LIÊN TỤC: 5 mẻ gần nhất đều chậm hơn gấp 3 lần trung vị đầu
    // kỳ -> hệ thống đang không theo kịp, dừng thay vì cắm đầu chạy tiếp.
    if (batchDurations.length >= 15) {
      const baseline = percentile(batchDurations.slice(0, 10), 0.5);
      const recent = batchDurations.slice(-5);
      if (baseline > 0 && recent.every((duration) => duration > baseline * 3)) {
        return `trễ mẻ tăng liên tục (baseline p50 ${baseline}ms, 5 mẻ gần nhất ${recent.join("/")}ms)`;
      }
    }
    return null;
  };

  const drain = async (): Promise<void> => {
    for (;;) {
      const batch = buffer.drainBatch();
      if (batch === null) return;
      coalescedEntries += batch.entries.length;
      const started = Date.now();
      const result = await ingest.execute(batch);
      const elapsed = Date.now() - started;
      batchDurations.push(elapsed);
      if (result.vesselsResolved > 0) resolveDurations.push(elapsed / result.vesselsResolved);
      saved += result.observationsSaved;
      duplicates += result.observationsSkippedDuplicate;
      resolvedVessels += result.vesselsResolved;

      const usage = process.memoryUsage();
      peakRss = Math.max(peakRss, usage.rss);
      peakHeap = Math.max(peakHeap, usage.heapUsed);

      const reason = shouldStop();
      if (reason !== null) {
        stoppedEarly = true;
        stopReason = reason;
        return;
      }
    }
  };

  const started = Date.now();
  let eventsFed = 0;
  for (let i = 0; i < events && !stoppedEarly; i += 1) {
    buffer.accept(positionEvent(i % vessels, Math.floor(i / vessels)));
    eventsFed += 1;
    if ((i + 1) % drainEvery === 0) await drain();
  }
  if (!stoppedEarly) await drain();
  const elapsedMs = Date.now() - started;

  const seconds = elapsedMs / 1000;
  console.log("\n📊 Kết quả");
  console.log(`   thời gian          : ${seconds.toFixed(1)} s${stoppedEarly ? ` (DỪNG SỚM: ${stopReason})` : ""}`);
  console.log(`   frame tổng hợp     : ${eventsFed.toLocaleString("en-US")}`);
  console.log(`   entry sau gộp      : ${coalescedEntries.toLocaleString("en-US")}`);
  console.log(`   observation ghi    : ${saved.toLocaleString("en-US")}`);
  console.log(`   observation trùng  : ${duplicates.toLocaleString("en-US")}`);
  console.log(`   observation/giây   : ${Math.round(saved / seconds).toLocaleString("en-US")}`);
  console.log(`   tàu resolve        : ${resolvedVessels.toLocaleString("en-US")}  (${Math.round(resolvedVessels / seconds).toLocaleString("en-US")}/giây)`);
  console.log(`   mẻ                 : ${batchDurations.length}`);
  if (batchDurations.length > 0) {
    console.log(
      `   thời lượng mẻ      : min ${Math.min(...batchDurations)}ms · p50 ${percentile(batchDurations, 0.5)}ms · ` +
        `p95 ${percentile(batchDurations, 0.95)}ms · max ${Math.max(...batchDurations)}ms`
    );
    console.log(`   ≈ ms / tàu resolve : ${percentile(resolveDurations, 0.5).toFixed(1)}`);
  }

  console.log("\n📖 Khuếch đại (đếm theo hợp đồng của code, không phải profiler Mongo)");
  console.log(`   GHI  : ${eventsFed} frame -> ${coalescedEntries} entry -> ${saved} document`);
  console.log(`   ĐỌC  : ${resolvedVessels * 4} aggregate + ${resolvedVessels}–${resolvedVessels * 2} findOne canonical`);
  console.log(`   bulk insert: ${batchDurations.length} lệnh`);

  console.log("\n🧠 Bộ nhớ");
  console.log(`   RSS đỉnh           : ${(peakRss / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`   heapUsed đỉnh      : ${(peakHeap / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`   RSS cuối           : ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MiB`);

  const bufferStats = buffer.getStats();
  console.log(`   đỉnh tàu buffer    : ${bufferStats.maxObservedBufferedVessels.toLocaleString("en-US")}`);
  console.log(`   đuổi khỏi buffer   : ${bufferStats.evictions.toLocaleString("en-US")} (mất dữ liệu chờ: ${bufferStats.evictedDirty.toLocaleString("en-US")})`);

  process.exit(stoppedEarly && stopReason !== `hết ${maxSeconds}s` ? 1 : 0);
}

void main().catch((error) => {
  console.error(`❌ ${(error as Error).message}`);
  process.exit(1);
});
