// ============================================================================
//  APPLICATION · Kiểu của bộ chọn nguồn free
// ----------------------------------------------------------------------------
//  Mã ĐÓNG, nhỏ — cùng nguyên tắc `ResolutionReason` (P8) và `MissingReason`
//  (P9.2): không câu chữ cho người đọc, không dựng sẵn taxonomy cho thứ chưa
//  viết.
// ============================================================================

import { VesselField, VesselFieldGroup } from "../../domain/value-objects/VesselField";
import { VesselIdentifier } from "../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { CollectOperation } from "../use-cases/CollectVesselObservations";

/**
 * Một thứ cần lấy được, dịch từ `SufficiencyResult.missing`.
 *
 * `field` vắng mặt = "bất kỳ field dùng được nào của nhóm" — VD `PARTICULARS`
 * trần chỉ đòi có gì đó, không đòi field cụ thể.
 */
export interface AcquisitionRequirement {
  readonly group: VesselFieldGroup;
  readonly field?: VesselField;
}

/** Vì sao nguồn này được CHỌN. */
export const SourceSelectionReason = {
  /** Giải được nhiều yêu cầu còn thiếu nhất. */
  BEST_CAPABILITY_MATCH: "BEST_CAPABILITY_MATCH",
  /** Đứng trước trong bảng ưu tiên riêng cho vị trí. */
  BEST_POSITION_SOURCE: "BEST_POSITION_SOURCE",
  /** Nguồn free DUY NHẤT CONFIRMED field đang cần. */
  ONLY_SOURCE_FOR_REQUIRED_FIELD: "ONLY_SOURCE_FOR_REQUIRED_FIELD",
  /** Ngang khả năng, nhưng sức khoẻ tốt hơn. */
  HEALTHIER_SOURCE: "HEALTHIER_SOURCE",
  /** Ngang mọi thứ -> `defaultPriority` rồi tên nguồn. */
  LOWER_COST_FREE_SOURCE: "LOWER_COST_FREE_SOURCE",
} as const;

export type SourceSelectionReason =
  (typeof SourceSelectionReason)[keyof typeof SourceSelectionReason];

/** Vì sao nguồn này KHÔNG được chọn. */
export const SourceSkipReason = {
  /** Không phải nguồn FREE — `EXISTING_STREAM` (AISStream) hoặc `PAID`. */
  UNSUPPORTED_NEED: "UNSUPPORTED_NEED",
  /** Nguồn không tra được bằng định danh ta đang có (VD ShipFinder + IMO). */
  UNSUPPORTED_IDENTIFIER: "UNSUPPORTED_IDENTIFIER",
  /** Sức khoẻ `DISABLED` — người vận hành tắt. KHÁC `capability.enabled`. */
  SOURCE_DISABLED: "SOURCE_DISABLED",
  /** Sức khoẻ `COOLDOWN`. ⛔ không reset, không bypass. */
  SOURCE_COOLDOWN: "SOURCE_COOLDOWN",
  /** Vừa thử ở lượt TRƯỚC, còn trong cửa sổ chặn. */
  RECENTLY_ATTEMPTED: "RECENTLY_ATTEMPTED",
  /** Đã thử trong CHÍNH lượt này -> hàng rào chống vòng lặp. */
  ALREADY_ATTEMPTED_THIS_REQUEST: "ALREADY_ATTEMPTED_THIS_REQUEST",
  /** Không CONFIRMED field/operation nào giải được yêu cầu còn thiếu. */
  NO_REQUIRED_CAPABILITY: "NO_REQUIRED_CAPABILITY",
} as const;

export type SourceSkipReason = (typeof SourceSkipReason)[keyof typeof SourceSkipReason];

export interface SkippedSource {
  readonly source: VesselSource;
  readonly reason: SourceSkipReason;
}

export interface SourceAttemptPlan {
  readonly source: VesselSource;
  /**
   * Operation THẬT của `VesselDataProvider` — chỉ `GET_POSITION` hoặc
   * `GET_DETAILS`. Không bịa `getParticulars()`/`getVoyage()`: interface không
   * có chúng, và `ProviderDetailsResult` vốn mang được cả bốn nhóm.
   */
  readonly operation: CollectOperation;
  /**
   * Trục tra CHO nguồn này — kèm sẵn trong kế hoạch để người thực thi không
   * phải suy lại.
   *
   * Selector đã kiểm `searchByMmsi`/`searchByImo` ở cổng định danh, nên nó là
   * nơi DUY NHẤT biết chắc nguồn này tra được bằng khoá nào. Bắt orchestrator
   * suy lại là nhân bản luật capability ra chỗ thứ hai.
   */
  readonly identifier: VesselIdentifier;
  /**
   * Yêu cầu mà LẦN GỌI NÀY nhắm tới. Nhiều field đi chung một plan khi cùng một
   * nguồn giải được — một request, không phải mỗi field một request.
   */
  readonly targetFields: readonly VesselField[];
  readonly reason: SourceSelectionReason;
}

export interface FreeSourceSelectionResult {
  /**
   * `null` = KHÔNG còn nguồn free nào đáng thử.
   *
   * ⚠️ `null` KHÔNG có nghĩa "dữ liệu đã đủ" — `SufficiencyResult.satisfied` mới
   * trả lời câu đó. Hai câu trả lời khác nhau: "đủ rồi" và "chưa đủ nhưng không
   * còn cách nào lấy thêm bằng nguồn miễn phí".
   */
  readonly next: SourceAttemptPlan | null;
  /** Mọi nguồn đã cân nhắc và bị loại, kèm lý do. Đủ để trace không phải đoán. */
  readonly skipped: readonly SkippedSource[];
}
