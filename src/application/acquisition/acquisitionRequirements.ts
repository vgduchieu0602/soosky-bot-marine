// ============================================================================
//  APPLICATION · Dịch "thiếu cái gì" (P9.2) sang "cần lấy được cái gì"
// ----------------------------------------------------------------------------
//  Tách khỏi `FreeSourceSelector` ở P9.5 vì bộ chọn free và cổng trả tiền đều
//  cần đúng phép dịch này. Hai bản sao sẽ trôi khỏi nhau, và khi trôi thì cổng
//  trả tiền sẽ nhắm tới field khác với thứ bộ chọn free đã bỏ cuộc — tức là
//  tiêu tiền cho sai thứ.
//
//  Hàm THUẦN: không I/O, không đồng hồ, không capability matrix.
// ============================================================================

import {
  VesselField,
  VesselFieldGroup,
  getFieldGroup,
} from "../../domain/value-objects/VesselField";
import { DataNeed, getGroupsForNeed } from "./DataNeed";
import { MissingReason, SufficiencyResult } from "./SufficiencyTypes";
import { AcquisitionRequirement } from "./SourceSelectionTypes";

/**
 * Field TỐI THIỂU để coi một nguồn giải được cả NHÓM (khi người gọi không chỉ
 * đích danh field nào). Khớp đúng định nghĩa "đủ" của P9.2 §D.
 */
export const GROUP_MINIMUM_FIELDS: Readonly<
  Record<VesselFieldGroup, readonly VesselField[] | null>
> = Object.freeze({
  // Cần cả mốc NGUỒN, không chỉ toạ độ. Vị trí không rõ tuổi rơi vào bậc
  // NO_SOURCE_TIME của resolver -> không bao giờ đủ tươi, nên nguồn không khai
  // được `positionReceivedAt` thì gọi nó cũng không giải quyết gì.
  [VesselFieldGroup.POSITION]: Object.freeze([
    VesselField.LAT,
    VesselField.LNG,
    VesselField.POSITION_RECEIVED_AT,
  ]),
  [VesselFieldGroup.IDENTITY]: Object.freeze([VesselField.NAME]),
  [VesselFieldGroup.VOYAGE]: Object.freeze([VesselField.DESTINATION]),
  // `null` = "bất kỳ field nào của nhóm cũng được" (P9.2: particulars trần chỉ
  // đòi có gì đó dùng được).
  [VesselFieldGroup.PARTICULARS]: null,
});

export interface RequirementOrder {
  /** Nhóm nào đứng trước khi mọi thứ khác ngang nhau. */
  readonly dynamicGroupOrder: readonly VesselFieldGroup[];
}

/**
 * `SufficiencyResult.missing` -> danh sách yêu cầu, đã bỏ trùng và SẮP TẤT ĐỊNH.
 *
 * `NO_CURRENT_VESSEL` KHÔNG có nghĩa "cần mọi thứ": nó suy ra đúng bộ yêu cầu
 * MẶC ĐỊNH của need — y hệt bộ mà P9.2 dùng để nói "đủ" — CỘNG các field người
 * gọi chỉ đích danh. Bỏ vế sau thì "cần builtYear" trên một con tàu chưa có dữ
 * liệu sẽ rơi về yêu cầu particulars CHUNG và ta chọn phải nguồn không cấp được
 * builtYear.
 */
export function toAcquisitionRequirements(
  sufficiency: SufficiencyResult,
  need: DataNeed,
  order: RequirementOrder
): readonly AcquisitionRequirement[] {
  const collected: AcquisitionRequirement[] = [];

  for (const item of sufficiency.missing) {
    if (item.reason === MissingReason.NO_CURRENT_VESSEL) {
      for (const group of getGroupsForNeed(need.type)) collected.push({ group });
      for (const field of need.requiredFields ?? []) {
        collected.push({ group: getFieldGroup(field), field });
      }
      continue;
    }
    if (item.group === undefined) continue;

    switch (item.reason) {
      // Cả nhóm vắng, hoặc vị trí có mà quá cũ -> cùng một yêu cầu: lấy nhóm đó.
      case MissingReason.MISSING_GROUP:
      case MissingReason.POSITION_NOT_FRESH_ENOUGH:
        collected.push({ group: item.group });
        break;
      case MissingReason.MISSING_REQUIRED_FIELD:
      case MissingReason.VOYAGE_TOO_OLD:
      case MissingReason.FIELD_TOO_OLD:
        collected.push({ group: item.group, field: item.field });
        break;
    }
  }

  const unique = new Map<string, AcquisitionRequirement>();
  for (const requirement of collected) {
    unique.set(`${requirement.group}|${requirement.field ?? "*"}`, requirement);
  }

  const rank = (group: VesselFieldGroup): number => {
    const index = order.dynamicGroupOrder.indexOf(group);
    return index === -1 ? order.dynamicGroupOrder.length : index;
  };

  return Object.freeze(
    [...unique.values()].sort((a, b) => {
      const byGroup = rank(a.group) - rank(b.group);
      if (byGroup !== 0) return byGroup;
      return (a.field ?? "").localeCompare(b.field ?? "");
    })
  );
}
