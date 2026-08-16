// ============================================================================
//  APPLICATION · AcquisitionAttempt — đã thử nguồn nào, khi nào, ra sao
// ----------------------------------------------------------------------------
//  Bản ghi này do NGƯỜI GỌI đưa vào. P9.3 KHÔNG lưu nó ở đâu: không collection
//  Mongo, không Redis, không Map toàn cục. Selector chỉ ĐỌC danh sách được
//  truyền vào và không giữ trạng thái giữa hai lần gọi.
//
//  ⚠️ Ba mã kết quả, không hơn. P4 đã có `SourceErrorCategory` với 8 mã chi
//  tiết (TIMEOUT/BLOCKED/RATE_LIMITED/...) — nhưng với câu hỏi "có nên gọi lại
//  nguồn này không", tám mã đó rơi vào đúng ba nhóm. Chép lại taxonomy của P4
//  vào đây là tạo ra hai bảng phải giữ đồng bộ mà không mua được gì.
// ============================================================================

import { VesselObservationKey } from "../../../domain/entities/VesselObservation";
import { VesselField } from "../../../domain/enums/VesselField";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { SourceErrorCategory } from "../crawl-runtime/SourceError";
import { CollectOperation } from "../../use-cases/observation/CollectVesselObservations";

export const AcquisitionOutcome = {
  /** Nguồn trả dữ liệu, observation đã được ghi. */
  SUCCESS: "SUCCESS",
  /** Nguồn trả lời rõ ràng "không có tàu này". KHÔNG phải nguồn hỏng. */
  NOT_FOUND: "NOT_FOUND",
  /** Hỏng kỹ thuật: timeout / 403 / 429 / 5xx / parse. Gộp có chủ ý — xem đầu file. */
  FAILED: "FAILED",
} as const;

export type AcquisitionOutcome = (typeof AcquisitionOutcome)[keyof typeof AcquisitionOutcome];

/**
 * Lần thử này thuộc lượt nào.
 *
 * Phân biệt bằng CỜ chứ không đoán theo `attemptedAt`: một attempt 3 giây trước
 * có thể là của lượt đang chạy, cũng có thể là của một yêu cầu khác vừa xong.
 * Đoán sai thì hoặc gọi lặp (loop), hoặc chặn nhầm một nguồn còn dùng được.
 */
export const AttemptScope = {
  /**
   * Thuộc lượt orchestration ĐANG CHẠY -> chặn vô điều kiện, không TTL.
   * Đây là hàng rào chống vòng lặp: gọi ShipFinder, hỏng, chọn lại ShipFinder.
   */
  CURRENT_REQUEST: "CURRENT_REQUEST",
  /** Từ trí nhớ của lượt trước -> chặn theo TTL, xem `FreeSourceSelectionPolicy`. */
  RECENT: "RECENT",
} as const;

export type AttemptScope = (typeof AttemptScope)[keyof typeof AttemptScope];

/**
 * Mã chi tiết khi `outcome = FAILED`.
 *
 * Ba mã cuối KHÔNG phải lỗi của nguồn: hai mã đầu là khoảng trống giữa capability
 * matrix (nói nguồn *về lý thuyết* làm được gì) và `ProviderRegistry` (nói code
 * có tồn tại hay không); hai mã cổng runtime là chặn phía ta, chưa hề chạm mạng.
 * Gộp hết vào `FAILED` mà không giữ mã thì không phân biệt được "nguồn hỏng" với
 * "ta lắp thiếu provider".
 */
export type AcquisitionFailureCode =
  | SourceErrorCategory
  | "SOURCE_COOLDOWN"
  | "SOURCE_DISABLED"
  | "NO_PROVIDER"
  | "UNSUPPORTED_OPERATION";

export interface AcquisitionAttempt {
  readonly source: VesselSource;
  readonly operation: CollectOperation;
  /** Tàu đã tra. Attempt của tàu KHÁC không chặn tàu này. */
  readonly vesselKey: VesselObservationKey;
  readonly attemptedAt: Date;
  readonly outcome: AcquisitionOutcome;
  readonly scope: AttemptScope;
  /** Chỉ có khi `FAILED`. Mã đóng, không phải câu chữ cho người đọc. */
  readonly failureCode?: AcquisitionFailureCode;
  /** Field mà lần gọi này nhắm tới — lấy nguyên từ `SourceAttemptPlan`. */
  readonly targetFields?: readonly VesselField[];
}

/**
 * Hai khoá cùng chỉ MỘT con tàu khi trùng ít nhất một định danh.
 *
 * Cố ý KHÔNG so khớp mờ: không so tên, không so callsign. P9 không làm entity
 * resolution — chỉ dùng định danh canonical (ACQUISITION_POLICY.md §L, §11 của
 * spec P8.5).
 */
export function attemptMatchesVessel(
  attempt: AcquisitionAttempt,
  key: VesselObservationKey
): boolean {
  const { mmsi, imo } = attempt.vesselKey;
  if (key.mmsi !== undefined && mmsi === key.mmsi) return true;
  if (key.imo !== undefined && imo === key.imo) return true;
  return false;
}
