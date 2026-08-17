// ============================================================================
//  APPLICATION · USE CASE: GetVesselWithFallback — LOCAL → FREE → PAID
// ----------------------------------------------------------------------------
//      { mmsi? , imo? , need , allowPaidFallback? }
//            ↓  GetCanonicalVesselDetail          đọc thuần
//      đủ + tươi ? ──► LOCAL_HIT  (0 request ra ngoài)
//            ↓ thiếu
//      GetOrRefreshVesselDetail                    LÀN FREE, nguyên vẹn
//            ↓ vẫn thiếu
//      cổng trả tiền + capability theo NHÓM + ngân sách thời gian
//            ↓
//      TrackVesselCurrentPosition                  LÀN PAID, nguyên vẹn
//            ↓
//      đọc lại canonical → trả
//
//  🔴 Vì sao fallback nằm Ở ĐÂY, không nằm trong controller:
//     `try { crawl() } catch { paid() }` trộn lỗi nghiệp vụ với lỗi kỹ thuật,
//     nên không ai trả lời được "404 có được fallback không", và một lần
//     `PARSE_ERROR` do nguồn đổi HTML sẽ âm thầm tiêu credit thật. Quyết định
//     tiêu tiền phải đọc được thành luật, không phải nằm trong một `catch`.
//
//  ⛔ KHÔNG sửa hai use case bên dưới. `GetOrRefreshVesselDetail` vẫn FREE-ONLY,
//     `TrackVesselCurrentPosition` vẫn PAID-ONLY. File này chỉ ĐIỀU PHỐI.
// ============================================================================

import { VesselSource } from "../../../domain/enums/VesselSource";
import { DetailRefreshGate } from "../../services/vessel/DetailRefreshGate";
import {
  CanonicalVesselDetail,
  DetailGroup,
  DetailGroupStatus,
} from "../../services/vessel/VesselDetailProjector";
import {
  PaidTrackingStatus,
  TrackVesselCurrentPosition,
  TrackVesselCurrentPositionResult,
} from "../tracking/TrackVesselCurrentPosition";
import { GetCanonicalVesselDetail, VesselDetailStatus } from "./GetCanonicalVesselDetail";
import {
  GetOrRefreshVesselDetail,
  RefreshAttempt,
} from "./GetOrRefreshVesselDetail";

// ---------------------------------------------------------------------------
//  Nhu cầu
// ---------------------------------------------------------------------------

export const VesselNeed = {
  /** Chỉ cần biết tàu đang ở đâu. */
  POSITION: "POSITION",
  /** Ảnh đầy đủ để mở trang chi tiết. */
  DETAIL: "DETAIL",
} as const;

export type VesselNeed = (typeof VesselNeed)[keyof typeof VesselNeed];

/**
 * 🔴 CAPABILITY THEO NHÓM — hàng rào tốn tiền quan trọng nhất của file này.
 *
 * MyShipTracking `response=simple` trả về ĐÚNG mười field: vessel_name, mmsi,
 * imo, vtype, lat, lng, course, speed, nav_status, received.
 *
 * ⇒ Nó lấp được **POSITION** và phần cơ bản của **IDENTITY**. Nó KHÔNG có
 *   `length`/`beam`/`draught`/`gt`/`dwt`/`built` (PARTICULARS) và không có
 *   `destination`/`eta`/cảng (VOYAGE) — những thứ đó chỉ có ở `extended`
 *   (3 credit), mà TRACK-1 cố ý không dùng.
 *
 * ⚠️ Hệ quả bắt buộc: thiếu PARTICULARS + mọi nguồn free hỏng ⇒ **trả thiếu**,
 *    TUYỆT ĐỐI không gọi API vị trí rồi khai là "đã làm mới particulars".
 *    Đó vừa là tiêu tiền vô ích, vừa là nói dối về dữ liệu.
 */
const PAID_CAPABLE_GROUPS: readonly DetailGroup[] = Object.freeze([
  DetailGroup.POSITION,
  DetailGroup.IDENTITY,
]);

// ---------------------------------------------------------------------------
//  Kết quả
// ---------------------------------------------------------------------------

export const FallbackStatus = {
  /** Canonical đã đủ — không request nào ra ngoài. */
  LOCAL_HIT: "LOCAL_HIT",
  /** Nguồn free lấp được nhu cầu. */
  FREE_UPDATED: "FREE_UPDATED",
  /** Phải dùng tới nguồn trả tiền. */
  PAID_UPDATED: "PAID_UPDATED",
  /** Có dữ liệu nhưng vẫn thiếu nhóm — và đó là câu trả lời hợp lệ. */
  PARTIAL: "PARTIAL",
  /** Canonical rỗng và không nguồn nào cho ra gì. */
  NOT_FOUND: "NOT_FOUND",
  /** Không lấy được gì và cũng không có dữ liệu cũ để trả. */
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type FallbackStatus = (typeof FallbackStatus)[keyof typeof FallbackStatus];

export const FallbackSourceUsed = {
  LOCAL: "LOCAL",
  FREE: "FREE",
  PAID: "PAID",
  NONE: "NONE",
} as const;

export type FallbackSourceUsed =
  (typeof FallbackSourceUsed)[keyof typeof FallbackSourceUsed];

/** Vì sao KHÔNG gọi trả tiền. Đọc được, để không ai phải đoán. */
export const PaidSkipReason = {
  /** Người gọi không bật. Đây là MẶC ĐỊNH. */
  NOT_ALLOWED: "NOT_ALLOWED",
  /** Nhu cầu đã được lấp bởi local hoặc free. */
  NEED_SATISFIED: "NEED_SATISFIED",
  /** Nhóm còn thiếu nằm ngoài khả năng của endpoint trả tiền. */
  NO_PAID_CAPABILITY: "NO_PAID_CAPABILITY",
  /** Vừa gọi trả tiền cho tàu này. */
  COOLDOWN: "COOLDOWN",
  /** Hết ngân sách thời gian của cả lượt. */
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  /**
   * Bản triển khai này KHÔNG có làn trả tiền nào được nối vào.
   *
   * Khác `NOT_ALLOWED` một cách quan trọng: `NOT_ALLOWED` là "có đường nhưng
   * cấu hình nói không", còn cái này là "không có đường". Gộp hai thứ lại thì
   * một lần quên nối adapter sẽ trông y như một lựa chọn vận hành.
   */
  LANE_UNAVAILABLE: "LANE_UNAVAILABLE",
} as const;

export type PaidSkipReason = (typeof PaidSkipReason)[keyof typeof PaidSkipReason];

export interface GetVesselWithFallbackResult {
  readonly status: FallbackStatus;
  readonly sourceUsed: FallbackSourceUsed;
  readonly need: VesselNeed;
  readonly detail: CanonicalVesselDetail | null;
  /**
   * ⚠️ Ba cờ này CỐ Ý tách nhau — `refreshed` một mình từng gộp cả ba và không
   * ai đọc ra được điều gì.
   */
  readonly externalAttempted: boolean;
  readonly dataUpdated: boolean;
  readonly fallbackUsed: boolean;
  readonly freeAttempts: readonly RefreshAttempt[];
  readonly paidAttempt?: {
    readonly status: PaidTrackingStatus;
    readonly creditCharged?: number;
  };
  /** Vắng mặt khi đã gọi trả tiền. */
  readonly paidSkipReason?: PaidSkipReason;
  readonly remainingMissingGroups: readonly DetailGroup[];
  readonly remainingStaleGroups: readonly DetailGroup[];
  readonly durationMs: number;
}

export interface GetVesselWithFallbackInput {
  readonly mmsi?: string;
  readonly imo?: string;
  readonly need: VesselNeed;
  /**
   * ⚠️ MẶC ĐỊNH `false`, và phải giữ như vậy.
   *
   * `undefined` do quên khai cũng phải là KHÔNG tiêu tiền. Nếu mọi request đều
   * mặc định được fallback trả tiền thì một đợt truy cập bình thường sẽ thành
   * hoá đơn — xem docs/FREE_TO_PAID_FALLBACK.md §"An toàn chi phí".
   */
  readonly allowPaidFallback?: boolean;
}

export interface FallbackPolicy {
  readonly totalBudgetMs: number;
  readonly minPaidSliceMs: number;
}

export const DEFAULT_FALLBACK_POLICY: Readonly<FallbackPolicy> = Object.freeze({
  /**
   * Ngân sách cho TOÀN LƯỢT (local + free + paid), không phải mỗi chặng.
   *
   * 15 giây: làn free đã tự có trần 10 giây; phần dôi ra là chỗ cho đúng một
   * request trả tiền. Không cộng dồn timeout của từng chặng — 3 chặng × 10 giây
   * là 30 giây treo trên đầu người dùng cho một cú bấm.
   */
  totalBudgetMs: 15_000,
  /** Còn ít hơn ngần này thì KHÔNG bắt đầu lượt trả tiền. */
  minPaidSliceMs: 2_000,
});

export interface GetVesselWithFallbackDeps {
  read: GetCanonicalVesselDetail;
  /** LÀN FREE — dùng lại nguyên vẹn, không sao chép `FreeSourceSelector`. */
  free: GetOrRefreshVesselDetail;
  /**
   * LÀN PAID — dùng lại nguyên vẹn, giữ cả cổng và single-flight của nó.
   *
   * TÙY CHỌN có chủ ý: một bản triển khai chỉ có LOCAL + FREE là hợp lệ, và là
   * mặc định hiện tại. Vắng làn này thì `paidSkipReason = LANE_UNAVAILABLE`,
   * không phải một lỗi.
   */
  paid?: TrackVesselCurrentPosition;
  /**
   * Dùng lại `DetailRefreshGate` cho cooldown trả tiền, với KHOÁ RIÊNG
   * (`paid:*`). Không viết bộ đếm cooldown thứ hai: cái này đã có LRU có trần
   * và đã được test.
   */
  gate: DetailRefreshGate;
  policy?: FallbackPolicy;
  now?: () => Date;
  logger?: { info(message: string): void };
}

export class GetVesselWithFallback {
  private readonly deps: GetVesselWithFallbackDeps;
  private readonly policy: FallbackPolicy;
  private readonly now: () => Date;

  /**
   * Single-flight NGOÀI, khoá theo `(định danh, nhu cầu)`.
   *
   * Hai làn bên trong đã có single-flight riêng, nhưng chúng chỉ chặn được phần
   * của mình: 10 request đồng thời vẫn sẽ chạy 10 lần chuỗi
   * "đọc → quyết định → đọc lại". Khoá ở đây gộp cả chuỗi.
   *
   * ⚠️ Khoá gồm cả `need`: cùng một tàu, nhu cầu POSITION và DETAIL có điều
   * kiện "đủ" khác nhau, gộp chung sẽ trả sai cho một trong hai.
   */
  private readonly inFlight = new Map<string, Promise<GetVesselWithFallbackResult>>();

  private stats = {
    requests: 0,
    localHits: 0,
    freeSuccess: 0,
    freeExhausted: 0,
    paidFallbacks: 0,
    paidSuccess: 0,
    paidFailure: 0,
    paidCreditsKnown: 0,
    singleFlightJoins: 0,
  };

  constructor(deps: GetVesselWithFallbackDeps) {
    this.deps = deps;
    this.policy = deps.policy ?? DEFAULT_FALLBACK_POLICY;
    this.now = deps.now ?? (() => new Date());
  }

  getStats(): Readonly<typeof this.stats> & { inFlight: number } {
    return { ...this.stats, inFlight: this.inFlight.size };
  }

  async execute(
    input: GetVesselWithFallbackInput
  ): Promise<GetVesselWithFallbackResult> {
    const flightKey = `${input.mmsi ?? ""}/${input.imo ?? ""}|${input.need}`;

    const running = this.inFlight.get(flightKey);
    if (running !== undefined) {
      this.stats.singleFlightJoins += 1;
      return running;
    }

    // `finally` nhả khoá: hỏng cũng phải nhả, nếu không con tàu đó bị khoá vĩnh viễn.
    const promise = this.run(input).finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, promise);
    return promise;
  }

  private async run(
    input: GetVesselWithFallbackInput
  ): Promise<GetVesselWithFallbackResult> {
    const startedAt = this.now().getTime();
    const deadline = startedAt + this.policy.totalBudgetMs;
    this.stats.requests += 1;

    // ---- BƯỚC 1 · LOCAL ----------------------------------------------------
    // Định danh rác bị `read` ném ra ngay đây, nên không lượt crawl/trả tiền
    // nào xuất phát từ một MMSI sai định dạng.
    const local = await this.deps.read.execute({ mmsi: input.mmsi, imo: input.imo });

    if (
      local.status === VesselDetailStatus.FOUND &&
      GetVesselWithFallback.satisfies(local.detail, input.need)
    ) {
      this.stats.localHits += 1;
      return this.settle({
        status: FallbackStatus.LOCAL_HIT,
        sourceUsed: FallbackSourceUsed.LOCAL,
        need: input.need,
        detail: local.detail,
        externalAttempted: false,
        dataUpdated: false,
        fallbackUsed: false,
        freeAttempts: [],
        paidSkipReason: PaidSkipReason.NEED_SATISFIED,
        startedAt,
      });
    }

    // ---- BƯỚC 2 · FREE -----------------------------------------------------
    // Gọi thẳng làn free đã có. Nó tự lo: chọn nguồn theo capability, trần 2
    // nguồn, ngân sách riêng, cooldown, single-flight, phân loại lỗi.
    const free = await this.deps.free.execute({ mmsi: input.mmsi, imo: input.imo });
    let detail = free.detail;

    if (GetVesselWithFallback.satisfies(detail, input.need)) {
      this.stats.freeSuccess += 1;
      return this.settle({
        status: FallbackStatus.FREE_UPDATED,
        sourceUsed: FallbackSourceUsed.FREE,
        need: input.need,
        detail,
        externalAttempted: free.refreshed,
        dataUpdated: free.refreshedGroups.length > 0,
        fallbackUsed: false,
        freeAttempts: free.attempts,
        paidSkipReason: PaidSkipReason.NEED_SATISFIED,
        startedAt,
      });
    }

    // Tới đây nghĩa là làn free đã đi hết phần của nó mà nhu cầu vẫn chưa xong.
    // "Hết" ở đây là hết theo CHÍNH SÁCH của làn free (trần nguồn + ngân sách
    // + cooldown), không phải "đã gọi mọi nguồn tồn tại" — và đó là điều đúng:
    // ShipInfo hỏng KHÔNG được phép nhảy thẳng sang tiền khi ShipFinder vẫn còn
    // lượt, và chính làn free là nơi bảo đảm việc đó.
    this.stats.freeExhausted += 1;

    // ---- BƯỚC 3 · PAID -----------------------------------------------------
    const skip = this.paidSkipReason(input, detail, deadline);
    if (skip !== null) {
      return this.settle({
        status: GetVesselWithFallback.partialStatus(detail),
        sourceUsed:
          free.refreshedGroups.length > 0 ? FallbackSourceUsed.FREE : FallbackSourceUsed.LOCAL,
        need: input.need,
        detail,
        externalAttempted: free.refreshed,
        dataUpdated: free.refreshedGroups.length > 0,
        fallbackUsed: false,
        freeAttempts: free.attempts,
        paidSkipReason: skip,
        startedAt,
      });
    }

    const gateKey = GetVesselWithFallback.paidGateKey(input);
    const lane = this.deps.paid;
    if (lane === undefined) throw new Error("paid lane missing after gate check");
    this.stats.paidFallbacks += 1;
    // Làn paid giữ nguyên cổng 9 lớp + single-flight của chính nó. Ở đây chỉ
    // gọi, không lách.
    const paid = await lane.execute({ mmsi: input.mmsi, imo: input.imo });
    this.deps.gate.recordAttempt(
      gateKey,
      [DetailGroup.POSITION],
      paid.status === PaidTrackingStatus.UPDATED
    );
    if (paid.actualCreditCharged !== undefined) this.stats.paidCreditsKnown += 1;

    if (paid.status === PaidTrackingStatus.UPDATED) {
      this.stats.paidSuccess += 1;
      // Đọc lại canonical: kết quả trả tiền đã đi qua Observation + Resolver,
      // nên thứ đúng để trả là ảnh ĐÃ PHÂN XỬ — không phải response của nguồn.
      // ⚠️ Resolver có thể vẫn chọn AIS nếu AIS mới hơn. Trả tiền không mua
      //    được quyền ghi đè dữ liệu mới hơn.
      const reread = await this.deps.read.execute({ mmsi: input.mmsi, imo: input.imo });
      detail = reread.detail;
    } else {
      this.stats.paidFailure += 1;
    }

    // ⛔ KHÔNG quay lại làn free sau khi paid hỏng. Vòng free→paid→free là cách
    //    chắc chắn nhất để một request treo và một hoá đơn phình.
    return this.settle({
      status:
        paid.status === PaidTrackingStatus.UPDATED
          ? FallbackStatus.PAID_UPDATED
          : GetVesselWithFallback.partialStatus(detail),
      sourceUsed:
        paid.status === PaidTrackingStatus.UPDATED
          ? FallbackSourceUsed.PAID
          : free.refreshedGroups.length > 0
            ? FallbackSourceUsed.FREE
            : FallbackSourceUsed.LOCAL,
      need: input.need,
      detail,
      externalAttempted: true,
      dataUpdated: paid.status === PaidTrackingStatus.UPDATED || free.refreshedGroups.length > 0,
      fallbackUsed: true,
      freeAttempts: free.attempts,
      paidAttempt: {
        status: paid.status,
        ...(paid.actualCreditCharged === undefined
          ? {}
          : { creditCharged: paid.actualCreditCharged }),
      },
      startedAt,
    });
  }

  /**
   * `null` = được phép gọi trả tiền. Thứ tự kiểm là thứ tự RẺ TRƯỚC: không bao
   * giờ hỏi "còn bao nhiêu thời gian" trước khi biết "có được phép" hay không.
   */
  private paidSkipReason(
    input: GetVesselWithFallbackInput,
    detail: CanonicalVesselDetail | null,
    deadline: number
  ): PaidSkipReason | null {
    // `!== true`: `undefined` do quên khai phải là TỪ CHỐI.
    if (input.allowPaidFallback !== true) return PaidSkipReason.NOT_ALLOWED;

    if (this.deps.paid === undefined) return PaidSkipReason.LANE_UNAVAILABLE;

    // §18/§19 — endpoint trả tiền chỉ lấp được POSITION + IDENTITY. Thiếu
    // PARTICULARS/VOYACE thì gọi nó là tiêu tiền cho thứ nó không có.
    const outstanding = GetVesselWithFallback.outstandingGroups(detail, input.need);
    if (!outstanding.some((group) => PAID_CAPABLE_GROUPS.includes(group))) {
      return PaidSkipReason.NO_PAID_CAPABILITY;
    }

    const gateKey = GetVesselWithFallback.paidGateKey(input);
    if (this.deps.gate.filterAllowed(gateKey, [DetailGroup.POSITION]).allowed.length === 0) {
      return PaidSkipReason.COOLDOWN;
    }

    // Bắt đầu một request trả tiền mà biết chắc sẽ bị cắt giữa chừng là tệ nhất
    // trong mọi lựa chọn: tốn credit mà không ai nhận được kết quả.
    if (deadline - this.now().getTime() < this.policy.minPaidSliceMs) {
      return PaidSkipReason.BUDGET_EXHAUSTED;
    }

    return null;
  }

  /** Khoá cooldown riêng cho làn trả tiền — không lẫn với cooldown của làn free. */
  private static paidGateKey(input: GetVesselWithFallbackInput): string {
    return `paid:${input.mmsi ?? ""}/${input.imo ?? ""}`;
  }

  /** Nhu cầu đã được lấp chưa. Hai nhu cầu, hai định nghĩa "đủ". */
  private static satisfies(
    detail: CanonicalVesselDetail | null,
    need: VesselNeed
  ): boolean {
    if (detail === null) return false;
    if (need === VesselNeed.POSITION) {
      return detail.groups[DetailGroup.POSITION].status === DetailGroupStatus.AVAILABLE;
    }
    return !detail.needsRefresh;
  }

  /** Nhóm còn thiếu MÀ nhu cầu này quan tâm. */
  private static outstandingGroups(
    detail: CanonicalVesselDetail | null,
    need: VesselNeed
  ): readonly DetailGroup[] {
    if (detail === null) {
      return need === VesselNeed.POSITION ? [DetailGroup.POSITION] : PAID_CAPABLE_GROUPS;
    }
    const remaining = [...detail.missingGroups, ...detail.staleGroups];
    return need === VesselNeed.POSITION
      ? remaining.filter((group) => group === DetailGroup.POSITION)
      : remaining;
  }

  /** Có dữ liệu mà vẫn thiếu = PARTIAL. Không có gì cả = NOT_FOUND. */
  private static partialStatus(detail: CanonicalVesselDetail | null): FallbackStatus {
    return detail === null ? FallbackStatus.NOT_FOUND : FallbackStatus.PARTIAL;
  }

  private settle(
    parts: Omit<
      GetVesselWithFallbackResult,
      "remainingMissingGroups" | "remainingStaleGroups" | "durationMs"
    > & { startedAt: number }
  ): GetVesselWithFallbackResult {
    const { startedAt, ...rest } = parts;
    const result: GetVesselWithFallbackResult = {
      ...rest,
      remainingMissingGroups: rest.detail?.missingGroups ?? [],
      remainingStaleGroups: rest.detail?.staleGroups ?? [],
      durationMs: this.now().getTime() - startedAt,
    };

    // MỘT dòng mỗi lượt. ⛔ Không HTML thô, không API key, không lỗi của nguồn.
    this.deps.logger?.info(
      `[vessel-fallback] ${rest.detail?.identifiers.mmsi ?? rest.detail?.identifiers.imo ?? "?"} ` +
        `need=${rest.need} ${rest.status} source=${rest.sourceUsed} ` +
        `free=${rest.freeAttempts.map((a) => `${a.source}:${a.status}`).join(",") || "—"} ` +
        `paid=${rest.paidAttempt?.status ?? rest.paidSkipReason ?? "—"} ` +
        `credit=${rest.paidAttempt?.creditCharged ?? "?"} ${result.durationMs}ms`
    );
    return result;
  }
}

/** Nguồn trả tiền duy nhất của làn này. Khai ra để test khoá được. */
export const FALLBACK_PAID_SOURCE = VesselSource.MYSHIPTRACKING;
