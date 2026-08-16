// ============================================================================
//  INTERFACE (CLI) · Mô phỏng tải cho AisCoalescingBuffer — KHÔNG mạng, KHÔNG DB
// ----------------------------------------------------------------------------
//  Chạy:  npm run marine-ais:buffer-sim
//         npm run marine-ais:buffer-sim -- --vessels=10000 --events=100000
//         npm run marine-ais:buffer-sim -- --vessels=80000 --max-vessels=50000
//
//  Trả lời đúng hai câu hỏi mà unit test không trả lời được:
//    1. Buffer có thực sự BỊ CHẶN ở `--max-vessels` không?
//    2. Nó ăn bao nhiêu RAM ở mức trần đó?
//
//  ⚠️ ĐÂY KHÔNG PHẢI BENCHMARK ĐỂ ĐẶT NGƯỠNG TRONG TEST. Số events/sec phụ
//     thuộc máy; đừng biến nó thành assertion ở đâu cả (yêu cầu §42).
//  ⚠️ Sự kiện là TỔNG HỢP, không chạm WebSocket, không chạm Mongo.
// ============================================================================

import { AisCoalescingBuffer } from "../../application/services/ingestion/AisCoalescingBuffer";
import { MarineAisNormalizedEvent } from "../../infrastructure/integrations/marine-ais/MarineAisWebSocketClient";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../domain/enums/VesselSource";

const DEFAULTS = {
  vessels: 10_000,
  events: 100_000,
  batchSize: 500,
  maxVessels: 50_000,
  /** Cứ ngần này sự kiện thì "consumer" rút một lần — giả lập chu kỳ flush. */
  drainEvery: 10_000,
  /** Tỉ lệ frame static trong tổng số (AIS thật: message 5 thưa hơn nhiều). */
  staticEveryNth: 40,
};

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

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const FETCHED_AT = new Date("2026-08-16T12:00:00.000Z");
const BASE_SOURCE_MS = Date.UTC(2026, 7, 16, 12, 0, 0);

/** MMSI 9 chữ số, chữ số đầu khác 0 — giống dữ liệu thật đủ để đo bộ nhớ. */
function mmsiOf(index: number): string {
  return String(200_000_000 + (index % 700_000_000));
}

function positionEvent(index: number, tick: number): MarineAisNormalizedEvent {
  const mmsi = mmsiOf(index);
  // Mốc nguồn tăng dần -> mọi frame đều "mới hơn", ép buffer vào đường THAY THẾ
  // (đường tốn kém nhất), không phải đường bỏ qua.
  const sourceReceivedAt = new Date(BASE_SOURCE_MS + tick * 1000);
  return {
    mmsi,
    type: "PositionReport",
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

function identityEvent(index: number): MarineAisNormalizedEvent {
  const mmsi = mmsiOf(index);
  return {
    mmsi,
    type: "ShipStaticData",
    receivedAt: FETCHED_AT,
    result: {
      identity: {
        mmsi,
        imo: null,
        name: `VESSEL ${index}`,
        callsign: null,
        vesselType: null,
        vesselTypeCode: 70,
        flag: null,
        metadata: createSourceMetadata({
          source: VesselSource.AISSTREAM,
          fetchedAt: FETCHED_AT,
          sourceReceivedAt: null,
        }),
      },
    },
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const vessels = readNumberFlag(args, "vessels", DEFAULTS.vessels);
  const events = readNumberFlag(args, "events", DEFAULTS.events);
  const batchSize = readNumberFlag(args, "batch-size", DEFAULTS.batchSize);
  const maxVessels = readNumberFlag(args, "max-vessels", DEFAULTS.maxVessels);
  const drainEvery = readNumberFlag(args, "drain-every", DEFAULTS.drainEvery);

  const buffer = new AisCoalescingBuffer({ maxVessels, batchSize });

  console.log(
    `\n🧪 Mô phỏng tải AisCoalescingBuffer\n` +
      `   tàu=${vessels}  sự kiện=${events}  mẻ=${batchSize}  trần=${maxVessels}\n` +
      `   rút mỗi ${drainEvery} sự kiện. KHÔNG mạng, KHÔNG DB.\n`
  );

  const heapBefore = process.memoryUsage().heapUsed;
  let drainedEntries = 0;
  let drainedBatches = 0;
  let peakBufferedAfterDrain = 0;

  const started = process.hrtime.bigint();
  for (let i = 0; i < events; i += 1) {
    const vesselIndex = i % vessels;
    buffer.accept(
      i % DEFAULTS.staticEveryNth === 0
        ? identityEvent(vesselIndex)
        : positionEvent(vesselIndex, Math.floor(i / vessels))
    );

    if ((i + 1) % drainEvery === 0) {
      let batch = buffer.drainBatch();
      while (batch !== null) {
        drainedBatches += 1;
        drainedEntries += batch.entries.length;
        batch = buffer.drainBatch();
      }
      peakBufferedAfterDrain = Math.max(peakBufferedAfterDrain, buffer.size());
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  // Ảnh chụp TRƯỚC lần rút cuối: đây là lúc buffer nặng nhất — mỗi ô còn ôm
  // nguyên object vị trí chưa ai lấy. Con số AIS-4 phải lập kế hoạch theo.
  const gcPeak = (globalThis as { gc?: () => void }).gc;
  if (gcPeak !== undefined) gcPeak();
  const heapAtPeakPending = process.memoryUsage().heapUsed;
  const pendingAtPeak = buffer.pendingCount();

  // Rút nốt phần dư — chứng minh không mất entry ở cuối.
  let tail = buffer.drainBatch();
  while (tail !== null) {
    drainedBatches += 1;
    drainedEntries += tail.entries.length;
    tail = buffer.drainBatch();
  }

  // Chạy kèm `--expose-gc` thì con số dưới đây là bộ nhớ THẬT buffer đang giữ;
  // không có thì nó là cận TRÊN, vì rác chưa được thu vẫn tính vào heapUsed.
  //   node --expose-gc -r ts-node/register src/interfaces/cli/marineAisBufferSim.ts
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc !== undefined) gc();

  const heapAfter = process.memoryUsage().heapUsed;
  const stats = buffer.getStats();

  console.log("⏱️  Thông lượng");
  console.log(`   thời gian          : ${elapsedMs.toFixed(0)} ms`);
  console.log(`   sự kiện/giây       : ${Math.round(events / (elapsedMs / 1000)).toLocaleString("en-US")}`);
  console.log(`   (số này phụ thuộc máy — KHÔNG dùng làm ngưỡng trong test)`);

  console.log("\n🧠 Bộ nhớ");
  console.log(`   heapUsed trước     : ${mib(heapBefore)}`);
  console.log(`   heapUsed sau       : ${mib(heapAfter)}`);
  console.log(`   chênh lệch         : ${mib(heapAfter - heapBefore)}`);
  console.log(
    `   đỉnh (còn ${pendingAtPeak.toLocaleString("en-US")} chờ rút): ${mib(heapAtPeakPending - heapBefore)}`
  );
  console.log(`   tàu tối đa từng giữ: ${stats.maxObservedBufferedVessels.toLocaleString("en-US")}`);
  console.log(`   ≈ bytes/tàu ở đỉnh : ${
    stats.maxObservedBufferedVessels > 0
      ? Math.round((heapAfter - heapBefore) / stats.maxObservedBufferedVessels)
      : 0
  }`);

  console.log("\n📦 Rút mẻ");
  console.log(`   mẻ                 : ${drainedBatches.toLocaleString("en-US")}`);
  console.log(`   entry đã rút       : ${drainedEntries.toLocaleString("en-US")}`);
  console.log(`   còn chờ            : ${buffer.pendingCount()}`);
  console.log(`   tàu còn trong RAM  : ${buffer.size().toLocaleString("en-US")}`);

  console.log("\n📊 Bộ đếm");
  console.log(`   accepted           : ${stats.acceptedEvents.toLocaleString("en-US")}`);
  console.log(`   position / identity: ${stats.positionEvents.toLocaleString("en-US")} / ${stats.identityEvents.toLocaleString("en-US")}`);
  console.log(`   thay vị trí        : ${stats.positionReplaced.toLocaleString("en-US")}`);
  console.log(`   bỏ vì cũ hơn       : ${stats.olderPositionIgnored.toLocaleString("en-US")}`);
  console.log(`   vị trí trùng mốc   : ${stats.positionDuplicates.toLocaleString("en-US")}`);
  console.log(`   identity trùng     : ${stats.identityDuplicates.toLocaleString("en-US")}`);
  console.log(`   đuổi               : ${stats.evictions.toLocaleString("en-US")} (mất dữ liệu chờ: ${stats.evictedDirty.toLocaleString("en-US")})`);

  const bounded = stats.maxObservedBufferedVessels <= maxVessels;
  console.log(
    `\n${bounded ? "✅" : "❌"} Trần bộ nhớ: đỉnh ${stats.maxObservedBufferedVessels} ` +
      `${bounded ? "<=" : ">"} trần ${maxVessels}`
  );
  process.exit(bounded ? 0 : 1);
}

main();
