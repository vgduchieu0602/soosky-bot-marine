import {
  IVesselObservationRepository,
  ObservationSaveStatus,
} from "../../contracts/repositories/IVesselObservationRepository";
import { AisCoalescedBatch } from "../../services/ingestion/AisCoalescingBuffer";
import { detailsResultToObservations } from "../../services/observation/providerResultToObservation";

export interface AisCurrentVesselResolver {
  execute(key: { mmsi: string }): Promise<unknown>;
}

export interface IngestAisBatchDeps {
  repository: IVesselObservationRepository;
  resolveAndStore: AisCurrentVesselResolver;
  /** Supplied by bootstrap so this use case never imports an infrastructure parser. */
  parserVersion?: string;
  resolveConcurrency: number;
}

export interface IngestAisBatchResult {
  readonly inputEntries: number;
  readonly observationsCreated: number;
  readonly observationsSaved: number;
  readonly observationsSkippedDuplicate: number;
  /**
   * Số tàu có ÍT NHẤT MỘT observation vừa được ghi mới.
   *
   * ⚠️ Đây KHÔNG phải "số MMSI trong mẻ" — tàu mà mọi observation đều trùng vân
   * tay thì không có gì mới để phân xử, nên không tính vào đây và cũng không
   * được resolve. Xem `execute`.
   */
  readonly vesselsAffected: number;
  readonly vesselsResolved: number;
  readonly vesselsResolveFailed: number;
  /** Tàu bị bỏ qua vì mẻ này không mang thông tin mới nào cho nó. */
  readonly vesselsSkippedUnchanged: number;
}

/** Persists one coalesced AIS batch, then refreshes each affected current vessel once. */
export class IngestAisBatch {
  private readonly repository: IVesselObservationRepository;
  private readonly resolveAndStore: AisCurrentVesselResolver;
  private readonly parserVersion?: string;
  private readonly resolveConcurrency: number;

  constructor(deps: IngestAisBatchDeps) {
    if (!Number.isInteger(deps.resolveConcurrency) || deps.resolveConcurrency < 1) {
      throw new Error(`resolveConcurrency must be a positive integer, received ${deps.resolveConcurrency}`);
    }
    this.repository = deps.repository;
    this.resolveAndStore = deps.resolveAndStore;
    this.parserVersion = deps.parserVersion;
    this.resolveConcurrency = deps.resolveConcurrency;
  }

  /**
   * ⚠️ CHỈ resolve tàu thực sự có dữ liệu MỚI.
   *
   * Trước AIS-5, mọi MMSI trong mẻ đều bị resolve — kể cả khi cả mẻ chỉ toàn
   * bản trùng vân tay. Mỗi lần resolve là 4 aggregate + 1–2 findOne trên Mongo,
   * nên một mẻ 500 tàu không mang tin gì mới vẫn ngốn ~2.500–3.000 lượt đọc để
   * ghi lại đúng thứ đã có.
   *
   * An toàn vì phân xử là hàm THUẦN của (observation trong kho, `now`): không
   * có bản ghi mới thì bốn nhóm cho ra đúng kết quả cũ, `currentVesselContentHash`
   * trùng, và kho trả `UNCHANGED` — tức là lượt resolve đó vốn đã không ghi gì.
   *
   * Hệ quả ĐÃ BIẾT và chấp nhận: bậc `freshness` lưu trong canonical không tự
   * già đi theo thời gian. Người đọc phải tính tuổi từ `position.observedAt`,
   * đừng tin bậc đã lưu — điều này vốn đã đúng với mọi tàu ngừng phát tín hiệu.
   */
  async execute(batch: AisCoalescedBatch): Promise<IngestAisBatchResult> {
    // Giữ observation THEO TỪNG entry để ánh xạ ngược kết quả ghi -> MMSI.
    // `saveMany` cam kết trả kết quả ĐÚNG THỨ TỰ đầu vào (xem contract).
    const perEntry = batch.entries.map((entry) =>
      detailsResultToObservations(entry, { parserVersion: this.parserVersion })
    );
    const observations = perEntry.flat();
    const persisted = await this.repository.saveMany(observations);

    const affected = new Set<string>();
    const seen = new Set<string>();
    let cursor = 0;
    for (const [index, entry] of batch.entries.entries()) {
      seen.add(entry.mmsi);
      for (const result of persisted.slice(cursor, cursor + perEntry[index].length)) {
        if (result.status === ObservationSaveStatus.SAVED) affected.add(entry.mmsi);
      }
      cursor += perEntry[index].length;
    }

    const resolution = await this.resolveAll([...affected]);

    return {
      inputEntries: batch.entries.length,
      observationsCreated: observations.length,
      observationsSaved: persisted.filter((result) => result.status === ObservationSaveStatus.SAVED).length,
      observationsSkippedDuplicate: persisted.filter(
        (result) => result.status === ObservationSaveStatus.SKIPPED_DUPLICATE
      ).length,
      vesselsAffected: affected.size,
      vesselsResolved: resolution.resolved,
      vesselsResolveFailed: resolution.failed,
      vesselsSkippedUnchanged: seen.size - affected.size,
    };
  }

  private async resolveAll(mmsi: readonly string[]): Promise<{ resolved: number; failed: number }> {
    let next = 0;
    let resolved = 0;
    let failed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const current = next;
        next += 1;
        if (current >= mmsi.length) return;
        try {
          await this.resolveAndStore.execute({ mmsi: mmsi[current] });
          resolved += 1;
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.resolveConcurrency, mmsi.length) }, worker));
    return { resolved, failed };
  }
}
