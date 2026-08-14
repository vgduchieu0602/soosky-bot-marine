// ============================================================================
//  APPLICATION · Kiểu dùng chung của resolver
// ----------------------------------------------------------------------------
//  CHỈ khai những mã mà P8.2 thực sự dùng (nhóm POSITION). Identity /
//  Particulars / Voyage sẽ bổ sung mã của riêng chúng ở P8.3 — không dựng sẵn
//  taxonomy cho thứ chưa viết.
//
//  Xem RESOLVER_POLICY.md §I (provenance) và §J (explainability).
// ============================================================================

import { VesselSource } from "../../domain/value-objects/VesselSource";

/** Vì sao ứng viên này THẮNG. */
export const ResolutionReason = {
  /** Chỉ còn đúng một ứng viên dùng được. */
  ONLY_AVAILABLE_VALUE: "ONLY_AVAILABLE_VALUE",
  /** Nhiều nguồn nói CÙNG một giá trị sau chuẩn hoá/dung sai — không phải xung đột. */
  SOURCES_AGREE: "SOURCES_AGREE",
  /** Bậc độ tươi theo `sourceReceivedAt` cao hơn. (POSITION) */
  FRESHER_SOURCE_TIMESTAMP: "FRESHER_SOURCE_TIMESTAMP",
  /** Cùng bậc độ tươi, toạ độ không bị làm tròn. (POSITION) */
  HIGHER_PRECISION: "HIGHER_PRECISION",
  /** Cùng bậc và cùng độ chính xác, nhiều field chuyển động hơn. (POSITION) */
  MORE_COMPLETE: "MORE_COMPLETE",
  /** Hạng capability cao hơn cho ĐÚNG field đó (CONFIRMED > CANDIDATE > UNSUPPORTED). */
  HIGHER_FIELD_QUALITY: "HIGHER_FIELD_QUALITY",
  /** Luật ưu tiên nguồn khai riêng cho field này (VD `vesselType`). */
  SOURCE_FIELD_PREFERENCE: "SOURCE_FIELD_PREFERENCE",
  /** `fetchedAt` mới hơn — dùng cho field TĨNH có thể đổi thật (tên tàu, mớn nước). */
  NEWER_FETCH: "NEWER_FETCH",
  /** Hoà mọi tiêu chí -> `defaultPriority` của capability matrix. */
  TIE_BREAK_PRIORITY: "TIE_BREAK_PRIORITY",
} as const;

export type ResolutionReason = (typeof ResolutionReason)[keyof typeof ResolutionReason];

/** Vì sao ứng viên này THUA (hoặc không được vào vòng trong). */
export const RejectionReason = {
  /** Bị loại ngay từ đầu: observation không hợp lệ. */
  INVALID_OBSERVATION: "INVALID_OBSERVATION",
  /** Không có mốc thời gian của nguồn -> bậc thấp nhất. */
  NO_SOURCE_TIMESTAMP: "NO_SOURCE_TIMESTAMP",
  /** Bậc độ tươi thấp hơn. */
  STALER_TIMESTAMP: "STALER_TIMESTAMP",
  /** Cùng bậc nhưng toạ độ bị làm tròn. */
  LOWER_PRECISION: "LOWER_PRECISION",
  /** Cùng bậc, cùng độ chính xác, ít field chuyển động hơn. */
  LESS_COMPLETE: "LESS_COMPLETE",
  /** Hạng capability thấp hơn cho field đó. */
  LOWER_FIELD_QUALITY: "LOWER_FIELD_QUALITY",
  /** Không phải nguồn được ưu tiên cho field này. */
  NOT_PREFERRED_SOURCE: "NOT_PREFERRED_SOURCE",
  /** `fetchedAt` cũ hơn. */
  OLDER_FETCH: "OLDER_FETCH",
  /**
   * Hai giá trị dùng HỆ BIỂU DIỄN KHÁC NHAU nên không so được (VD cờ ISO-2 `LR`
   * với ISO-3 `LBR` mà bảng quy đổi chưa biết). Đây KHÔNG phải xung đột dữ liệu
   * — chỉ là ta chưa chứng minh được chúng bằng nhau.
   */
  INCOMPARABLE_REPRESENTATION: "INCOMPARABLE_REPRESENTATION",
  /** Thua ở bước tie-break cuối. */
  TIE_BREAK_PRIORITY: "TIE_BREAK_PRIORITY",
} as const;

export type RejectionReason = (typeof RejectionReason)[keyof typeof RejectionReason];

export interface RejectedCandidate {
  readonly source: VesselSource;
  /** Chưa lưu thì undefined. Đủ để truy ngược về bản ghi gốc. */
  readonly observationId?: string;
  readonly reason: RejectionReason;
}

/**
 * Một field canonical đã phân xử, KÈM xuất xứ.
 *
 * Canonical không bao giờ được chứa `length = 179` trần: mất `source` là mất
 * khả năng trả lời "ai nói thế" — đúng thứ audit A0 chỉ ra legacy không làm được.
 */
export interface ResolvedField<T> {
  readonly value: T;
  readonly source: VesselSource;
  readonly observationId?: string;
  /** Mốc NGUỒN khai. Nhóm tĩnh (identity/particulars) hiện luôn `null`. */
  readonly observedAt: Date | null;
  /** Lúc bot lấy được. Luôn có. */
  readonly fetchedAt: Date;
  readonly reason: ResolutionReason;
  readonly rejected: readonly RejectedCandidate[];
}
