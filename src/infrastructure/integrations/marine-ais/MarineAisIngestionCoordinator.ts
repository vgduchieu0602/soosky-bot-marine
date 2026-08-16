// ============================================================================
//  INFRASTRUCTURE · MarineAisIngestionCoordinator — dây nối client ↔ buffer
// ----------------------------------------------------------------------------
//      MarineAisWebSocketClient  --normalizedData-->  AisCoalescingBuffer
//                                                          |
//                                     mỗi `windowMs`  -->  emit("batch", ...)
//
//  Cố ý mỏng. Toàn bộ logic gộp nằm ở `AisCoalescingBuffer` (thuần, không
//  timer, test được bằng lời gọi trực tiếp); ở đây CHỈ có đăng ký listener và
//  MỘT `setInterval`. Tách như vậy để test buffer không phải chờ đồng hồ.
//
//  ⛔ KHÔNG Mongo · KHÔNG observation · KHÔNG resolver. Ai nghe `batch` thì tự
//     quyết làm gì với nó — AIS-4 sẽ là người đầu tiên.
//  ⛔ KHÔNG có ai tự dựng class này. `container.ts` không đụng tới; chỉ script
//     gọi tay mới tạo ra nó.
// ============================================================================

import { EventEmitter } from "node:events";
import { AisCoalescedBatch, AisCoalescingBuffer } from "../../../application/services/ingestion/AisCoalescingBuffer";
import {
  MarineAisClientEvent,
  MarineAisNormalizedEvent,
  MarineAisWebSocketClient,
} from "./MarineAisWebSocketClient";

export const AisIngestionEvent = {
  /** Một mẻ đã gộp. Payload: `AisCoalescedBatch`. */
  BATCH: "batch",
} as const;

export type AisIngestionEvent = (typeof AisIngestionEvent)[keyof typeof AisIngestionEvent];

export interface MarineAisIngestionCoordinatorOptions {
  client: MarineAisWebSocketClient;
  buffer: AisCoalescingBuffer;
  /** AIS-4 consumer. Omit only for the existing buffer-only manual POC. */
  ingest?: { execute(batch: AisCoalescedBatch): Promise<unknown> };
  logger?: { info(message: string): void; warn(message: string): void };
  /** Chu kỳ rút, ms. Ngắn quá thì mất tác dụng gộp; dài quá thì map trễ. */
  windowMs: number;
  /**
   * Trần số mẻ được rút trong MỘT chu kỳ.
   *
   * ⚠️ Có trần vì `drainAll()` không giới hạn sẽ khoá vòng lặp sự kiện khi
   * buffer đang phình (50.000 tàu / mẻ 500 = 100 mẻ liên tiếp). Phần dư ở lại
   * cho chu kỳ sau — buffer vẫn chỉ giữ trạng thái MỚI NHẤT nên chờ không làm
   * dữ liệu cũ đi, chỉ làm nó được gộp thêm.
   */
  maxBatchesPerCycle?: number;
}

const DEFAULT_MAX_BATCHES_PER_CYCLE = 20;

export class MarineAisIngestionCoordinator extends EventEmitter {
  private readonly client: MarineAisWebSocketClient;
  private readonly buffer: AisCoalescingBuffer;
  private readonly windowMs: number;
  private readonly maxBatchesPerCycle: number;
  private readonly ingest?: { execute(batch: AisCoalescedBatch): Promise<unknown> };
  private readonly logger: { info(message: string): void; warn(message: string): void };

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private flushInProgress: Promise<AisCoalescedBatch[]> | null = null;
  private readonly persistenceStats = {
    persistBatches: 0,
    persistFailures: 0,
    persistedObservations: 0,
    duplicateObservations: 0,
    resolvedVessels: 0,
    resolveFailures: 0,
  };

  /** Giữ tham chiếu để `stop()` gỡ ĐÚNG listener này, không gỡ của người khác. */
  private readonly onNormalized = (event: MarineAisNormalizedEvent): void => {
    // Hot path: đồng bộ, O(1) trung bình, không I/O. Xem AisCoalescingBuffer.
    this.buffer.accept(event);
  };

  constructor(options: MarineAisIngestionCoordinatorOptions) {
    super();
    if (!Number.isFinite(options.windowMs) || options.windowMs < 1) {
      throw new Error(`windowMs phải > 0, nhận ${options.windowMs}`);
    }
    this.client = options.client;
    this.buffer = options.buffer;
    this.ingest = options.ingest;
    this.logger = options.logger ?? { info: (message) => console.log(message), warn: (message) => console.warn(message) };
    this.windowMs = options.windowMs;
    this.maxBatchesPerCycle = options.maxBatchesPerCycle ?? DEFAULT_MAX_BATCHES_PER_CYCLE;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.client.on(MarineAisClientEvent.NORMALIZED_DATA, this.onNormalized);
    this.timer = setInterval(() => { void this.flushNow(); }, this.windowMs);
    this.timer.unref?.();
    this.client.start();
  }

  /**
   * Dừng sạch: ngắt nguồn TRƯỚC, rút nốt phần còn lại SAU. Đảo thứ tự sẽ để lọt
   * frame vào buffer sau lần rút cuối rồi mất luôn.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.client.off(MarineAisClientEvent.NORMALIZED_DATA, this.onNormalized);
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.client.stop();
    await this.flushNow();
  }

  /** Rút ngay, không chờ hết chu kỳ. Persistent flush luôn single-flight. */
  flushNow(): Promise<AisCoalescedBatch[]> {
    // Backward-compatible buffer-only coordinator used by the AIS-3 POC.
    if (this.ingest === undefined) {
      const batches = this.buffer.drainAll(this.maxBatchesPerCycle);
      for (const batch of batches) this.emit(AisIngestionEvent.BATCH, batch);
      return Promise.resolve(batches);
    }
    if (this.flushInProgress !== null) return this.flushInProgress;

    const flush = this.persistDrainedBatches();
    this.flushInProgress = flush;
    void flush.finally(() => {
      if (this.flushInProgress === flush) this.flushInProgress = null;
    });
    return flush;
  }

  getPersistenceStats(): Readonly<typeof this.persistenceStats> {
    return { ...this.persistenceStats };
  }

  isRunning(): boolean {
    return this.running;
  }

  private async persistDrainedBatches(): Promise<AisCoalescedBatch[]> {
    const batches: AisCoalescedBatch[] = [];
    for (let index = 0; index < this.maxBatchesPerCycle; index += 1) {
      const batch = this.buffer.drainBatch();
      if (batch === null) break;
      batches.push(batch);
      this.emit(AisIngestionEvent.BATCH, batch);
      try {
        const result = await this.ingest!.execute(batch) as {
          observationsSaved?: number;
          observationsSkippedDuplicate?: number;
          vesselsResolved?: number;
          vesselsResolveFailed?: number;
        };
        this.persistenceStats.persistBatches += 1;
        this.persistenceStats.persistedObservations += result.observationsSaved ?? 0;
        this.persistenceStats.duplicateObservations += result.observationsSkippedDuplicate ?? 0;
        this.persistenceStats.resolvedVessels += result.vesselsResolved ?? 0;
        this.persistenceStats.resolveFailures += result.vesselsResolveFailed ?? 0;
        this.logger.info(
          `[marine-ais] batch persisted entries=${batch.entries.length} ` +
          `saved=${result.observationsSaved ?? 0} duplicates=${result.observationsSkippedDuplicate ?? 0} ` +
          `resolved=${result.vesselsResolved ?? 0} resolveFailed=${result.vesselsResolveFailed ?? 0}`
        );
      } catch (error) {
        this.persistenceStats.persistFailures += 1;
        this.requeue(batch);
        this.logger.warn(
          `[marine-ais] batch persistence failed entries=${batch.entries.length}; requeued latest state: ` +
          `${error instanceof Error ? error.message : String(error)}`
        );
        break;
      }
    }
    return batches;
  }

  /** Re-enter through the buffer so a newer frame already received always wins. */
  private requeue(batch: AisCoalescedBatch): void {
    for (const entry of batch.entries) {
      this.buffer.accept({
        mmsi: entry.mmsi,
        result: { identity: entry.identity, position: entry.position },
      });
    }
  }
}
