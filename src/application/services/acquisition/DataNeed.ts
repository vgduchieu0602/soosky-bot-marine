// ============================================================================
//  APPLICATION · DataNeed — người gọi CẦN GÌ
// ----------------------------------------------------------------------------
//  Nhu cầu là ĐẦU VÀO của người gọi, không phải thứ suy ra từ dữ liệu đang có.
//  Cùng một con tàu, hai nhu cầu khác nhau cho hai câu trả lời khác nhau về
//  "đủ hay chưa" (ACQUISITION_POLICY.md §C).
//
//  `DETAILS` CỐ Ý không có ở đây: nó là bí danh của IDENTITY + PARTICULARS,
//  người gọi tự tách thành hai lần hỏi. Thêm một need thứ sáu chỉ để đặt tên
//  cho phép cộng là làm bảng luật dài ra mà không thêm luật nào.
// ============================================================================

import {
  VesselField,
  VesselFieldGroup,
  getFieldGroup,
  isVesselField,
} from "../../../domain/enums/VesselField";

export const DataNeedType = {
  /** Tàu đang ở đâu BÂY GIỜ. */
  POSITION: "POSITION",
  /** Tàu này là tàu nào. */
  IDENTITY: "IDENTITY",
  /** Thông số con tàu. */
  PARTICULARS: "PARTICULARS",
  /** Chuyến đi hiện tại. */
  VOYAGE: "VOYAGE",
  /** Ảnh tổng hợp để hiển thị — chuẩn vị trí NỚI hơn `POSITION`. */
  FULL: "FULL",
} as const;

export type DataNeedType = (typeof DataNeedType)[keyof typeof DataNeedType];

export interface DataNeed {
  readonly type: DataNeedType;
  /**
   * Field bắt buộc, chỉ đích danh.
   *
   * ⚠️ Nó **thu hẹp** định nghĩa "đủ", KHÔNG mở rộng: field không nằm ở đây thì
   * thiếu cũng không làm need thất bại. Đó là hàng rào chống đuổi theo sự hoàn
   * hảo (ACQUISITION_POLICY.md §D.0) — canonical luôn có field null, và coi mọi
   * field null là thiếu sẽ khiến không tàu nào "đủ" bao giờ.
   */
  readonly requiredFields?: readonly VesselField[];
}

/** Nhóm canonical mà mỗi need chịu trách nhiệm. `FULL` nhận cả bốn. */
const GROUPS_BY_NEED: Readonly<Record<DataNeedType, readonly VesselFieldGroup[]>> =
  Object.freeze({
    [DataNeedType.POSITION]: Object.freeze([VesselFieldGroup.POSITION]),
    [DataNeedType.IDENTITY]: Object.freeze([VesselFieldGroup.IDENTITY]),
    [DataNeedType.PARTICULARS]: Object.freeze([VesselFieldGroup.PARTICULARS]),
    [DataNeedType.VOYAGE]: Object.freeze([VesselFieldGroup.VOYAGE]),
    [DataNeedType.FULL]: Object.freeze([
      VesselFieldGroup.IDENTITY,
      VesselFieldGroup.POSITION,
      VesselFieldGroup.PARTICULARS,
      VesselFieldGroup.VOYAGE,
    ]),
  });

export function getGroupsForNeed(type: DataNeedType): readonly VesselFieldGroup[] {
  return GROUPS_BY_NEED[type];
}

/** Sai hình dạng need — lỗi của người gọi, không phải "dữ liệu chưa đủ". */
export class InvalidDataNeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDataNeedError";
  }
}

/**
 * Kiểm need TRƯỚC khi đánh giá.
 *
 * ⚠️ `POSITION + builtYear` phải NỔ, không được lặng lẽ bỏ qua. Bỏ qua im lặng
 * thì người gọi nhận `satisfied: true` và tin rằng `builtYear` đã được kiểm —
 * trong khi nó chưa hề được nhìn tới. Sai âm thầm nguy hiểm hơn lỗi ồn ào.
 *
 * @throws InvalidDataNeedError
 */
export function validateDataNeed(need: DataNeed): void {
  if (!(need.type in GROUPS_BY_NEED)) {
    throw new InvalidDataNeedError(`DataNeedType không hợp lệ: "${String(need.type)}"`);
  }
  if (need.requiredFields === undefined) return;

  const allowed = GROUPS_BY_NEED[need.type];
  for (const field of need.requiredFields) {
    if (!isVesselField(field)) {
      throw new InvalidDataNeedError(`Không phải VesselField: "${String(field)}"`);
    }
    const group = getFieldGroup(field);
    if (!allowed.includes(group)) {
      throw new InvalidDataNeedError(
        `Field "${field}" thuộc nhóm "${group}", không dùng được với need ` +
          `"${need.type}" (chỉ nhận: ${allowed.join(", ")})`
      );
    }
  }
}
