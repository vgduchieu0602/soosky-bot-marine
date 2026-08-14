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
  /** Bậc độ tươi theo `sourceReceivedAt` cao hơn. */
  FRESHER_SOURCE_TIMESTAMP: "FRESHER_SOURCE_TIMESTAMP",
  /** Cùng bậc độ tươi, toạ độ không bị làm tròn. */
  HIGHER_PRECISION: "HIGHER_PRECISION",
  /** Cùng bậc và cùng độ chính xác, nhiều field chuyển động hơn. */
  MORE_COMPLETE: "MORE_COMPLETE",
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
