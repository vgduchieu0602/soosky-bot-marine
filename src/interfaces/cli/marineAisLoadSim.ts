// ============================================================================
//  INTERFACE (CLI) · Mô phỏng tải TOÀN ĐƯỜNG ỐNG AIS — không mạng, không Mongo
// ----------------------------------------------------------------------------
//  Chạy:  npm run marine-ais:load-sim
//         npm run marine-ais:load-sim -- --vessels=10000 --events=100000
//         node --expose-gc -r ts-node/register src/interfaces/cli/marineAisLoadSim.ts
//
//  Đường chạy (code THẬT, chỉ kho là in-memory):
//      sự kiện AIS tổng hợp
//        -> AisCoalescingBuffer          (gộp)
//        -> IngestAisBatch               (ghi + phân xử)
//        -> InMemory observation/current repository
//
//  Trả lời BA câu hỏi của AIS-5:
//    1. Hệ số khuếch đại GHI : frame -> entry gộp -> observation -> canonical.
//    2. Hệ số khuếch đại ĐỌC : bao nhiêu lượt đọc kho cho mỗi tàu được resolve.
//    3. Bộ nhớ có bị chặn không.
//
//  ⚠️ KHÔNG phải benchmark để đặt ngưỡng: số sự kiện/giây phụ thuộc máy, và
//     KHÔNG được đưa vào assertion của test nào (yêu cầu §42 của AIS-3).
// ============================================================================

import {
  IVesselObservationRepository,
  ObservationQueryOptions,
  ObservationSaveResult,
} from "../../application/contracts/repositories/IVesselObservationRepository";
import { AisCoalescingBuffer } from "../../application/services/ingestion/AisCoalescingBuffer";
import { observationExpiresAt } from "../../application/services/observation/ObservationRetentionPolicy";
import { detailsResultToObservations } from "../../application/services/observation/providerResultToObservation";
import { IngestAisBatch } from "../../application/use-cases/ingestion/IngestAisBatch";
import { ResolveAndStoreCurrentVessel } from "../../application/use-cases/resolution/ResolveAndStoreCurrentVessel";
import { ResolveCurrentVessel } from "../../application/use-cases/resolution/ResolveCurrentVessel";
import {
  VesselObservationKey,
  VesselObservationType,
  VesselSourceObservation,
} from "../../domain/entities/VesselObservation";
import { VesselSource } from "../../domain/enums/VesselSource";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { InMemoryCurrentVesselRepository } from "../../infrastructure/persistence/memory/InMemoryCurrentVesselRepository";
import { InMemoryVesselObservationRepository } from "../../infrastructure/persistence/memory/InMemoryVesselObservationRepository";

const DEFAULTS = {
  vessels: 10_000,
  events: 100_000,
  batchSize: 500,
  maxVessels: 50_000,
  /** Bao nhiêu sự kiện thì rút một lần — thay cho đồng hồ cửa sổ 10 giây. */
  drainEvery: 10_000,
  /** AIS thật: message 5 thưa hơn message 1/2/3 rất nhiều. */
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

function ratio(a: number, b: number): string {
  return b === 0 ? "—" : (a / b).toFixed(2);
}

const FETCHED_AT = new Date("2026-08-16T12:00:00.000Z");
const BASE_SOURCE_MS = FETCHED_AT.getTime();

function mmsiOf(index: number): string {
  return String(200_000_000 + (index % 700_000_000));
}

function positionEvent(index: number, tick: number) {
  const mmsi = mmsiOf(index);
  const sourceReceivedAt = new Date(BASE_SOURCE_MS + tick * 1000);
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

function identityEvent(index: number) {
  const mmsi = mmsiOf(index);
  return {
    mmsi,
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

/**
 * Bọc kho để ĐẾM lượt đọc/ghi thật.
 *
 * Đây là cách duy nhất trả lời §22 bằng SỐ ĐO thay vì đọc code rồi đoán.
 */
class CountingObservationRepository implements IVesselObservationRepository {
  reads = 0;
  writes = 0;
  constructor(private readonly inner: IVesselObservationRepository) {}

  async save(observation: VesselSourceObservation): Promise<ObservationSaveResult> {
    this.writes += 1;
    return this.inner.save(observation);
  }
  async saveMany(
    observations: readonly VesselSourceObservation[]
  ): Promise<readonly ObservationSaveResult[]> {
    this.writes += 1;
    return this.inner.saveMany(observations);
  }
  async findRecentByVessel(key: VesselObservationKey, options?: ObservationQueryOptions) {
    this.reads += 1;
    return this.inner.findRecentByVessel(key, options);
  }
  async findRecentBySource(source: VesselSource, options?: ObservationQueryOptions) {
    this.reads += 1;
    return this.inner.findRecentBySource(source, options);
  }
  async findLatestByVesselAndType(
    key: VesselObservationKey,
    type: VesselObservationType,
    options?: ObservationQueryOptions
  ) {
    this.reads += 1;
    return this.inner.findLatestByVesselAndType(key, type, options);
  }
  async findLatestPerSourceByVesselAndType(
    key: VesselObservationKey,
    type: VesselObservationType,
    options?: ObservationQueryOptions
  ) {
    this.reads += 1;
    return this.inner.findLatestPerSourceByVesselAndType(key, type, options);
  }
}

/** Kích thước xấp xỉ của một observation khi serialize — để ước lượng dung lượng. */
function sampleObservationBytes(): { position: number; identity: number } {
  const [position] = detailsResultToObservations(positionEvent(1, 1).result, {
    parserVersion: "marine-ais-v1",
  });
  const [identity] = detailsResultToObservations(identityEvent(1).result, {
    parserVersion: "marine-ais-v1",
  });
  const size = (observation: VesselSourceObservation | undefined): number =>
    observation === undefined ? 0 : Buffer.byteLength(JSON.stringify(observation), "utf8");
  return { position: size(position), identity: size(identity) };
}

// ---------------------------------------------------------------------------
//  Chế độ BỘ NHỚ · nhiều kịch bản (AIS-5.1)
// ---------------------------------------------------------------------------

interface MemorySample {
  heapUsed: number;
  rss: number;
}

function sample(): MemorySample {
  const usage = process.memoryUsage();
  return { heapUsed: usage.heapUsed, rss: usage.rss };
}

/** Chạy GC nếu runtime cho phép. Không có thì thôi — số đo thành cận TRÊN. */
function collectGarbage(): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) return false;
  gc();
  return true;
}

interface ScenarioResult {
  vessels: number;
  events: number;
  coalescedEntries: number;
  evictions: number;
  evictedDirty: number;
  maxBuffered: number;
  before: MemorySample;
  peak: MemorySample;
  after: MemorySample;
}

/**
 * Đo BỘ NHỚ của buffer, KHÔNG chạy ingest/resolve.
 *
 * ⚠️ Cố ý bỏ đường persistence: kho in-memory quét TUYẾN TÍNH, nên ở 50.000 tàu
 * nó đo chính bộ giả lập chứ không đo Mongo, và mất hàng giờ. Tốc độ ghi thật
 * là việc của `marine-ais:mongo-load-poc`.
 */
function runMemoryScenario(
  vessels: number,
  events: number,
  drainEvery: number,
  maxVessels: number,
  batchSize: number
): ScenarioResult {
  collectGarbage();
  const before = sample();

  const buffer = new AisCoalescingBuffer({ maxVessels, batchSize, now: () => FETCHED_AT });
  let coalescedEntries = 0;
  const peak: MemorySample = { ...before };

  const observe = (): void => {
    const current = sample();
    if (current.heapUsed > peak.heapUsed) peak.heapUsed = current.heapUsed;
    if (current.rss > peak.rss) peak.rss = current.rss;
  };

  for (let i = 0; i < events; i += 1) {
    const vesselIndex = i % vessels;
    buffer.accept(
      i % DEFAULTS.staticEveryNth === 0
        ? identityEvent(vesselIndex)
        : positionEvent(vesselIndex, Math.floor(i / vessels))
    );

    if ((i + 1) % drainEvery === 0) {
      observe(); // đỉnh nằm NGAY TRƯỚC lúc rút: mọi ô còn ôm object chưa ai lấy
      for (;;) {
        const batch = buffer.drainBatch();
        if (batch === null) break;
        coalescedEntries += batch.entries.length;
      }
    }
    if (i % 25_000 === 0) observe();
  }

  observe();
  for (;;) {
    const batch = buffer.drainBatch();
    if (batch === null) break;
    coalescedEntries += batch.entries.length;
  }

  collectGarbage();
  const after = sample();
  const stats = buffer.getStats();

  return {
    vessels,
    events,
    coalescedEntries,
    evictions: stats.evictions,
    evictedDirty: stats.evictedDirty,
    maxBuffered: stats.maxObservedBufferedVessels,
    before,
    peak,
    after,
  };
}

function printScenario(result: ScenarioResult, maxVessels: number): void {
  const perVessel =
    result.maxBuffered === 0
      ? 0
      : Math.round((result.peak.heapUsed - result.before.heapUsed) / result.maxBuffered);

  console.log(`\n── ${result.vessels.toLocaleString("en-US")} tàu · ${result.events.toLocaleString("en-US")} sự kiện`);
  console.log(`   entry sau gộp      : ${result.coalescedEntries.toLocaleString("en-US")} (×${ratio(result.coalescedEntries, result.events)})`);
  console.log(`   đỉnh tàu trong buffer: ${result.maxBuffered.toLocaleString("en-US")} / trần ${maxVessels.toLocaleString("en-US")}`);
  console.log(`   đuổi               : ${result.evictions.toLocaleString("en-US")} (mất dữ liệu chờ: ${result.evictedDirty.toLocaleString("en-US")})`);
  console.log(`   heapUsed  trước/đỉnh/sau : ${mib(result.before.heapUsed)} / ${mib(result.peak.heapUsed)} / ${mib(result.after.heapUsed)}`);
  console.log(`   rss       trước/đỉnh/sau : ${mib(result.before.rss)} / ${mib(result.peak.rss)} / ${mib(result.after.rss)}`);
  console.log(`   ≈ heap/tàu ở đỉnh  : ${perVessel} B (ước lượng, KHÔNG phải hằng số)`);
}

async function runScenarios(args: string[]): Promise<void> {
  const raw = args.find((arg) => arg.startsWith("--scenarios="))!.slice("--scenarios=".length);
  const scenarios = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map(Math.floor);

  if (scenarios.length === 0) {
    console.error("❌ --scenarios cần danh sách số dương, VD --scenarios=10000,25000,50000");
    process.exit(1);
  }

  const maxVessels = readNumberFlag(args, "max-vessels", DEFAULTS.maxVessels);
  const batchSize = readNumberFlag(args, "batch-size", DEFAULTS.batchSize);
  const eventsPerVessel = readNumberFlag(args, "events-per-vessel", 4);
  const drainEvery = readNumberFlag(args, "drain-every", DEFAULTS.drainEvery);
  const gcAvailable = collectGarbage();

  console.log(
    `\n🧠 Đo bộ nhớ buffer AIS · kịch bản ${scenarios.join(", ")}\n` +
      `   trần=${maxVessels} mẻ=${batchSize} sự kiện/tàu=${eventsPerVessel} rút mỗi ${drainEvery}\n` +
      `   GC tường minh: ${gcAvailable ? "CÓ" : "KHÔNG (số đo là cận TRÊN — chạy với --expose-gc để sạch hơn)"}\n` +
      `   ⚠️ Chỉ đo buffer. Tốc độ ghi thật xem marine-ais:mongo-load-poc.`
  );

  const results: ScenarioResult[] = [];
  for (const vessels of scenarios) {
    results.push(
      runMemoryScenario(vessels, vessels * eventsPerVessel, drainEvery, maxVessels, batchSize)
    );
    printScenario(results[results.length - 1], maxVessels);
  }

  const bounded = results.every((result) => result.maxBuffered <= maxVessels);
  const peakRss = Math.max(...results.map((result) => result.peak.rss));
  console.log(`\n📌 RSS đỉnh trên mọi kịch bản: ${mib(peakRss)}`);
  console.log(`${bounded ? "✅" : "❌"} Buffer nằm trong trần ở MỌI kịch bản.`);
  process.exit(bounded ? 0 : 1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg.startsWith("--scenarios="))) {
    await runScenarios(args);
    return;
  }

  const vessels = readNumberFlag(args, "vessels", DEFAULTS.vessels);
  const events = readNumberFlag(args, "events", DEFAULTS.events);
  const batchSize = readNumberFlag(args, "batch-size", DEFAULTS.batchSize);
  const maxVessels = readNumberFlag(args, "max-vessels", DEFAULTS.maxVessels);
  const drainEvery = readNumberFlag(args, "drain-every", DEFAULTS.drainEvery);

  const buffer = new AisCoalescingBuffer({ maxVessels, batchSize, now: () => FETCHED_AT });
  const inner = new InMemoryVesselObservationRepository({ now: () => FETCHED_AT });
  const observations = new CountingObservationRepository(inner);
  const current = new InMemoryCurrentVesselRepository({ now: () => FETCHED_AT });

  const ingest = new IngestAisBatch({
    repository: observations,
    resolveAndStore: new ResolveAndStoreCurrentVessel({
      resolve: new ResolveCurrentVessel({ repository: observations, now: () => FETCHED_AT }),
      repository: current,
    }),
    parserVersion: "marine-ais-v1",
    resolveConcurrency: 10,
  });

  console.log(
    `\n🧪 Mô phỏng tải AIS toàn đường ống\n` +
      `   tàu=${vessels}  sự kiện=${events}  mẻ=${batchSize}  trần buffer=${maxVessels}\n` +
      `   rút mỗi ${drainEvery} sự kiện. KHÔNG mạng, KHÔNG Mongo.\n`
  );

  const heapBefore = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();

  let batches = 0;
  let coalescedEntries = 0;
  let observationsCreated = 0;
  let observationsSaved = 0;
  let observationsDuplicate = 0;
  let vesselsResolved = 0;
  let vesselsSkipped = 0;

  const drain = async (): Promise<void> => {
    for (;;) {
      const batch = buffer.drainBatch();
      if (batch === null) return;
      batches += 1;
      coalescedEntries += batch.entries.length;
      const result = await ingest.execute(batch);
      observationsCreated += result.observationsCreated;
      observationsSaved += result.observationsSaved;
      observationsDuplicate += result.observationsSkippedDuplicate;
      vesselsResolved += result.vesselsResolved;
      vesselsSkipped += result.vesselsSkippedUnchanged;
    }
  };

  for (let i = 0; i < events; i += 1) {
    const vesselIndex = i % vessels;
    buffer.accept(
      i % DEFAULTS.staticEveryNth === 0
        ? identityEvent(vesselIndex)
        : positionEvent(vesselIndex, Math.floor(i / vessels))
    );
    if ((i + 1) % drainEvery === 0) await drain();
  }
  await drain();

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc !== undefined) gc();
  const heapAfter = process.memoryUsage().heapUsed;

  const bufferStats = buffer.getStats();
  const bytes = sampleObservationBytes();
  const expires = observationExpiresAt({
    source: VesselSource.AISSTREAM,
    type: VesselObservationType.POSITION,
    validationStatus: "VALID" as never,
    fetchedAt: FETCHED_AT,
  });

  console.log("⏱️  Thông lượng");
  console.log(`   thời gian          : ${elapsedMs.toFixed(0)} ms`);
  console.log(`   sự kiện/giây       : ${Math.round(events / (elapsedMs / 1000)).toLocaleString("en-US")}`);
  console.log(`   (phụ thuộc máy — KHÔNG dùng làm ngưỡng trong test)`);

  console.log("\n📉 Khuếch đại GHI");
  console.log(`   frame AIS          : ${events.toLocaleString("en-US")}`);
  console.log(`   entry sau gộp      : ${coalescedEntries.toLocaleString("en-US")}  (×${ratio(coalescedEntries, events)})`);
  console.log(`   observation dựng   : ${observationsCreated.toLocaleString("en-US")}  (×${ratio(observationsCreated, events)})`);
  console.log(`   observation GHI    : ${observationsSaved.toLocaleString("en-US")}  (×${ratio(observationsSaved, events)})`);
  console.log(`   observation trùng  : ${observationsDuplicate.toLocaleString("en-US")}`);
  console.log(`   canonical resolve  : ${vesselsResolved.toLocaleString("en-US")}  (×${ratio(vesselsResolved, events)})`);
  console.log(`   tàu bỏ qua (không mới): ${vesselsSkipped.toLocaleString("en-US")}`);
  console.log(`   mẻ                 : ${batches.toLocaleString("en-US")}`);

  console.log("\n📖 Khuếch đại ĐỌC");
  console.log(`   lượt đọc kho       : ${observations.reads.toLocaleString("en-US")}`);
  console.log(`   lượt ghi kho       : ${observations.writes.toLocaleString("en-US")}`);
  console.log(`   đọc / tàu resolve  : ${ratio(observations.reads, vesselsResolved)}`);

  console.log("\n🧠 Bộ nhớ");
  console.log(`   heapUsed trước     : ${mib(heapBefore)}`);
  console.log(`   heapUsed sau       : ${mib(heapAfter)}`);
  console.log(`   chênh lệch         : ${mib(heapAfter - heapBefore)}`);
  console.log(`   đỉnh tàu trong buffer: ${bufferStats.maxObservedBufferedVessels.toLocaleString("en-US")} / trần ${maxVessels.toLocaleString("en-US")}`);
  console.log(`   đuổi khỏi buffer   : ${bufferStats.evictions.toLocaleString("en-US")} (mất dữ liệu chờ: ${bufferStats.evictedDirty.toLocaleString("en-US")})`);

  console.log("\n💾 Kích thước & retention");
  console.log(`   observation POSITION ≈ ${bytes.position} B (JSON, chưa tính overhead BSON/index)`);
  console.log(`   observation IDENTITY ≈ ${bytes.identity} B`);
  console.log(`   AIS POSITION expiresAt = fetchedAt + ${((expires!.getTime() - FETCHED_AT.getTime()) / 3_600_000).toFixed(0)}h`);

  const bounded = bufferStats.maxObservedBufferedVessels <= maxVessels;
  console.log(`\n${bounded ? "✅" : "❌"} Buffer nằm trong trần bộ nhớ.`);
  process.exit(bounded ? 0 : 1);
}

void main();
