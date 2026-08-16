// ============================================================================
//  APPLICATION · USE CASE: AcquireFreeVesselData — vòng acquisition CÓ CHẶN
// ----------------------------------------------------------------------------
//      đọc local -> đủ? -> DỪNG
//                 -> chưa -> chọn nguồn free -> gọi -> ghi observation
//                         -> resolve/store canonical -> đọc lại -> lặp
//
//  Ghép bốn thứ ĐÃ CÓ, không phát minh gì:
//      CheckLocalVesselSufficiency (P9.2) · FreeSourceSelector (P9.3)
//      CollectVesselObservations (P6.4/P7.4) · ResolveAndStoreCurrentVessel (P8.5)
//
//  ⛔ Use case này KHÔNG chứa luật nào của bốn tầng kia:
//      • không `if (position.freshness === ...)`   -> sufficiency ở P9.2
//      • không `if (need POSITION) callShipFinder` -> selection ở P9.3
//      • không `if (ShipFinder mới hơn ShipInfo)`  -> resolution ở P8
//      • không `registry.get()` / `provider.getX()` -> phải qua P3/P4/P5
//  Mỗi luật sống ở đúng một nơi. Chép lại đây là tạo bản thứ hai sẽ trôi.
//
//  ⛔ KHÔNG paid fallback · KHÔNG MyShipTracking · KHÔNG AISStream ·
//  KHÔNG single-flight · KHÔNG scheduler · KHÔNG lưu attempt.
// ============================================================================

import {
  AcquisitionAttempt,
  AcquisitionFailureCode,
  AcquisitionOutcome,
  AttemptScope,
} from "../../services/acquisition/AcquisitionAttempt";
import { DataNeed } from "../../services/acquisition/DataNeed";
import {
  DEFAULT_FREE_ACQUISITION_POLICY,
  FreeAcquisitionPolicy,
} from "../../services/acquisition/FreeAcquisitionPolicy";
import { FreeSourceSelector } from "../../services/acquisition/FreeSourceSelector";
import { SourceAttemptPlan } from "../../services/acquisition/SourceSelectionTypes";
import { SufficiencyResult } from "../../services/acquisition/SufficiencyTypes";
import { ObservationSaveStatus } from "../../contracts/repositories/IVesselObservationRepository";
import { ResolvedCurrentVessel } from "../../services/resolution/ResolvedCurrentVessel";
import { SourceRequestError, SourceUnavailableError } from "../../services/crawl-runtime/SourceError";
import { SourceHealthState } from "../../services/crawl-runtime/SourceHealthTracker";
import { VesselObservationKey } from "../../../domain/entities/VesselObservation";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { CheckLocalVesselSufficiency } from "./CheckLocalVesselSufficiency";
import { CollectStatus, CollectVesselObservations } from "../observation/CollectVesselObservations";
import { ResolveAndStoreCurrentVessel } from "../resolution/ResolveAndStoreCurrentVessel";

export const AcquisitionStopReason = {
  /** Canonical đã đủ ngay từ đầu -> KHÔNG một request mạng nào. */
  LOCAL_DATA_SUFFICIENT: "LOCAL_DATA_SUFFICIENT",
  /** Đủ sau khi lấy thêm. */
  SATISFIED_AFTER_ACQUISITION: "SATISFIED_AFTER_ACQUISITION",
  /** Không còn nguồn free nào đáng thử. ⚠️ KHÔNG mở đường cho nguồn trả tiền. */
  NO_FREE_SOURCE_AVAILABLE: "NO_FREE_SOURCE_AVAILABLE",
  /** Hết ngân sách chạm nguồn. Có thể còn nguồn chưa thử — xem `attempts`. */
  ATTEMPT_BUDGET_EXHAUSTED: "ATTEMPT_BUDGET_EXHAUSTED",
} as const;

export type AcquisitionStopReason =
  (typeof AcquisitionStopReason)[keyof typeof AcquisitionStopReason];

export interface AcquireFreeVesselDataResult {
  /** Bản canonical tốt nhất hiện có — kể cả khi `satisfied = false`. */
  readonly vessel: ResolvedCurrentVessel | null;
  readonly satisfied: boolean;
  /** Kết quả kiểm CUỐI CÙNG. Nói rõ còn thiếu gì khi chưa đủ. */
  readonly sufficiency: SufficiencyResult;
  /** Theo đúng thứ tự đã gọi. Rỗng = không chạm mạng lần nào. */
  readonly attempts: readonly AcquisitionAttempt[];
  readonly stopReason: AcquisitionStopReason;
}

export interface AcquireFreeVesselDataDeps {
  checkLocal: CheckLocalVesselSufficiency;
  selector: FreeSourceSelector;
  collect: CollectVesselObservations;
  resolveAndStore: ResolveAndStoreCurrentVessel;
  /** CHỈ ĐỌC sức khoẻ. Truyền hàm nên không thể vô tình sửa trạng thái runtime. */
  healthOf: (source: VesselSource) => SourceHealthState;
  now?: () => Date;
  policy?: FreeAcquisitionPolicy;
  /**
   * Lần thử từ các lượt TRƯỚC, do người gọi giữ. P9.4 không lưu ở đâu — không
   * collection, không Redis. Chưa truyền thì chỉ có chặn trong-lượt.
   */
  recentAttempts?: readonly AcquisitionAttempt[];
}

/** Kết quả một lần chạm nguồn, đã quy về từ vựng của tầng acquisition. */
interface AttemptOutcome {
  readonly outcome: AcquisitionOutcome;
  readonly failureCode?: AcquisitionFailureCode;
  /** Có observation MỚI được ghi không -> quyết định có cần resolve lại. */
  readonly hasNewObservation: boolean;
}

export class AcquireFreeVesselData {
  private readonly deps: AcquireFreeVesselDataDeps;
  private readonly policy: FreeAcquisitionPolicy;
  private readonly now: () => Date;

  constructor(deps: AcquireFreeVesselDataDeps) {
    this.deps = deps;
    this.policy = deps.policy ?? DEFAULT_FREE_ACQUISITION_POLICY;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * @throws Error khi khoá rỗng hoặc need sai hình dạng — lỗi của người gọi.
   *         Nguồn hỏng thì KHÔNG ném: còn nguồn khác thì phải thử tiếp, và
   *         "chưa đủ dữ liệu" là câu trả lời hợp lệ, không phải sự cố.
   */
  async execute(
    key: VesselObservationKey,
    need: DataNeed
  ): Promise<AcquireFreeVesselDataResult> {
    // LOCAL-FIRST: đọc trước, luôn luôn. Đây là lý do phần lớn yêu cầu thật
    // không sinh request nào (ACQUISITION_POLICY.md §B).
    let check = await this.deps.checkLocal.execute(key, need);
    if (check.sufficiency.satisfied) {
      return AcquireFreeVesselData.result(
        check.vessel,
        check.sufficiency,
        [],
        AcquisitionStopReason.LOCAL_DATA_SUFFICIENT
      );
    }

    const attempts: AcquisitionAttempt[] = [];

    for (;;) {
      // Đếm MỌI lần chạm nguồn, kể cả NOT_FOUND và lỗi — nếu chỉ đếm lần thành
      // công thì một nguồn hỏng liên tục không bao giờ tiêu hết ngân sách.
      if (attempts.length >= this.policy.maxAttemptsPerRequest) {
        return AcquireFreeVesselData.result(
          check.vessel,
          check.sufficiency,
          attempts,
          AcquisitionStopReason.ATTEMPT_BUDGET_EXHAUSTED
        );
      }

      const selection = this.deps.selector.select({
        key,
        need,
        sufficiency: check.sufficiency,
        healthOf: this.deps.healthOf,
        // Truyền CẢ lịch sử của lượt này -> selector tự chặn nguồn đã thử.
        // Đó là hàng rào chống vòng lặp, và nó nằm ở P9.3 chứ không ở đây.
        attempts: [...(this.deps.recentAttempts ?? []), ...attempts],
        now: this.now(),
      });

      if (selection.next === null) {
        return AcquireFreeVesselData.result(
          check.vessel,
          check.sufficiency,
          attempts,
          AcquisitionStopReason.NO_FREE_SOURCE_AVAILABLE
        );
      }

      const plan = selection.next;
      const attempted = await this.attempt(plan);
      attempts.push(AcquireFreeVesselData.toAttempt(plan, key, attempted, this.now()));

      // Không có observation mới thì canonical không thể đổi -> bỏ qua resolve.
      // Đây là chỗ NOT_FOUND tiết kiệm thật, không phải cắt xén.
      if (attempted.hasNewObservation) {
        await this.deps.resolveAndStore.execute(key);
      }

      // Kiểm lại sau MỖI lần chạm nguồn. Sufficiency là trọng tài duy nhất —
      // không suy từ `plan.targetFields` rằng field đó đã được lấp: provider có
      // thể trả về ít nhóm hơn ta nhắm tới.
      check = await this.deps.checkLocal.execute(key, need);
      if (check.sufficiency.satisfied) {
        return AcquireFreeVesselData.result(
          check.vessel,
          check.sufficiency,
          attempts,
          AcquisitionStopReason.SATISFIED_AFTER_ACQUISITION
        );
      }
    }
  }

  /**
   * Gọi nguồn qua `CollectVesselObservations` — cửa DUY NHẤT. Use case đó đã sở
   * hữu `ProviderRegistry` (P3), runtime cooldown/retry/nhịp nghỉ (P4) và
   * `ObservationRecorder` (P5). Gọi thẳng provider là bỏ qua cả ba.
   */
  private async attempt(plan: SourceAttemptPlan): Promise<AttemptOutcome> {
    try {
      const result = await this.deps.collect.execute({
        source: plan.source,
        identifier: plan.identifier,
        operation: plan.operation,
      });

      switch (result.status) {
        case CollectStatus.RECORDED:
          return {
            outcome: AcquisitionOutcome.SUCCESS,
            // Toàn bộ bị dedupe -> nguồn nói y hệt lần trước -> canonical không
            // thể đổi. Vẫn là một lần chạm nguồn THÀNH CÔNG, chỉ là không có
            // thông tin mới (OBSERVATION_STORAGE dedupe).
            hasNewObservation: result.observations.some(
              (saved) => saved.status === ObservationSaveStatus.SAVED
            ),
          };

        case CollectStatus.NOT_FOUND:
          // Nguồn NÀY không tìm được tàu. KHÔNG có nghĩa tàu không tồn tại —
          // nguồn khác vẫn được thử.
          return { outcome: AcquisitionOutcome.NOT_FOUND, hasNewObservation: false };

        // Khoảng trống giữa matrix và registry: selector chọn theo capability,
        // nhưng code adapter có thể chưa được lắp. Đây là lỗi CẤU HÌNH, không
        // phải nguồn hỏng — nhưng ném lên sẽ giết cả lượt trong khi nguồn khác
        // còn dùng được. Ghi mã rồi đi tiếp; vòng sau selector tự loại nguồn này.
        case CollectStatus.NO_PROVIDER:
          return {
            outcome: AcquisitionOutcome.FAILED,
            failureCode: "NO_PROVIDER",
            hasNewObservation: false,
          };
        case CollectStatus.UNSUPPORTED_OPERATION:
          return {
            outcome: AcquisitionOutcome.FAILED,
            failureCode: "UNSUPPORTED_OPERATION",
            hasNewObservation: false,
          };
      }
    } catch (err) {
      // Nguồn hỏng là chuyện VẬN HÀNH -> ghi lại, thử nguồn khác.
      if (err instanceof SourceRequestError) {
        return {
          outcome: AcquisitionOutcome.FAILED,
          failureCode: err.category,
          hasNewObservation: false,
        };
      }
      // Cổng chặn phía ta (cooldown/tắt). Selector lẽ ra đã loại, nhưng trạng
      // thái có thể đổi giữa lúc chọn và lúc gọi. ⛔ Không reset, không bypass.
      if (err instanceof SourceUnavailableError) {
        return {
          outcome: AcquisitionOutcome.FAILED,
          failureCode: err.code,
          hasNewObservation: false,
        };
      }
      // Còn lại là lỗi lập trình/lắp ráp. KHÔNG nuốt — nuốt hết rồi gọi là
      // FAILED sẽ biến một cái bug thành "nguồn hôm nay hơi chập".
      throw err;
    }
  }

  private static toAttempt(
    plan: SourceAttemptPlan,
    key: VesselObservationKey,
    outcome: AttemptOutcome,
    attemptedAt: Date
  ): AcquisitionAttempt {
    return {
      source: plan.source,
      operation: plan.operation,
      vesselKey: key,
      attemptedAt,
      outcome: outcome.outcome,
      scope: AttemptScope.CURRENT_REQUEST,
      failureCode: outcome.failureCode,
      targetFields: plan.targetFields,
    };
  }

  private static result(
    vessel: ResolvedCurrentVessel | null,
    sufficiency: SufficiencyResult,
    attempts: readonly AcquisitionAttempt[],
    stopReason: AcquisitionStopReason
  ): AcquireFreeVesselDataResult {
    return {
      vessel,
      satisfied: sufficiency.satisfied,
      sufficiency,
      attempts: Object.freeze([...attempts]),
      stopReason,
    };
  }
}
