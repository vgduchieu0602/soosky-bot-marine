// ============================================================================
//  APPLICATION · Kiểu kết quả của bộ kiểm "dữ liệu local đã đủ chưa"
// ----------------------------------------------------------------------------
//  Mã ĐÓNG, nhỏ, chỉ gồm những gì P9.2 thật sự dùng — cùng nguyên tắc với
//  `ResolutionReason` của P8: không câu chữ cho người đọc, không 30 enum dựng
//  sẵn cho thứ chưa viết.
// ============================================================================

import { VesselField, VesselFieldGroup } from "../../domain/value-objects/VesselField";
import { DataNeed } from "./DataNeed";

export const MissingReason = {
  /** Chưa có bản ghi canonical nào cho tàu này. */
  NO_CURRENT_VESSEL: "NO_CURRENT_VESSEL",
  /** Cả nhóm canonical bằng `null` — chưa nguồn nào phân xử được gì. */
  MISSING_GROUP: "MISSING_GROUP",
  /** Field người gọi chỉ đích danh không có giá trị. */
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  /** Vị trí CÓ, nhưng bậc độ tươi thấp hơn mức need đòi hỏi. */
  POSITION_NOT_FRESH_ENOUGH: "POSITION_NOT_FRESH_ENOUGH",
  /** `destination` CÓ, nhưng lấy về đã quá lâu — có thể đã sang chuyến khác. */
  VOYAGE_TOO_OLD: "VOYAGE_TOO_OLD",
  /** Field nửa động (hiện chỉ `draught`) có giá trị nhưng quá cũ. */
  FIELD_TOO_OLD: "FIELD_TOO_OLD",
} as const;

export type MissingReason = (typeof MissingReason)[keyof typeof MissingReason];

export interface MissingRequirement {
  /** Vắng mặt với `NO_CURRENT_VESSEL` — thiếu toàn bộ, không thuộc nhóm nào. */
  readonly group?: VesselFieldGroup;
  /** Chỉ có khi thiếu ở mức FIELD. Thiếu cả nhóm thì không có field cụ thể. */
  readonly field?: VesselField;
  readonly reason: MissingReason;
}

export interface SufficiencyResult {
  readonly satisfied: boolean;
  /** Nhu cầu đã được kiểm — trả lại nguyên vẹn để log/trace không phải đoán. */
  readonly need: DataNeed;
  /** Rỗng khi `satisfied`. Nhiều mục = nhiều lý do độc lập, không phải bậc thang. */
  readonly missing: readonly MissingRequirement[];
}
