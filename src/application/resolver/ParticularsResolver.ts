// ============================================================================
//  APPLICATION · ParticularsResolver — TRỘN FIELD, dứt khoát. Hàm thuần.
// ----------------------------------------------------------------------------
//  Bằng chứng thật (MMSI 636018086, cả hai observation đều VALID):
//      shipfinder   length 179   beam 29   draught 5.9   builtYear null   deadweight null
//      shipinfo     length null  beam null draught null  builtYear 2010   deadweight 33261
//
//  Bù trừ HOÀN HẢO. Chọn "nguồn thắng cho cả nhóm" là VỨT BỎ MỘT NỬA dữ liệu
//  đang có. Đây là chứng cứ mạnh nhất cho trộn theo field.
//
//  Độ tin cậy từng field lấy từ SOURCE_CAPABILITY_MATRIX — dự án ĐÃ có bảng đó,
//  không dựng bảng thứ hai (hai bảng cùng nội dung sẽ lệch nhau).
//  VD `shipinfo.length = UNSUPPORTED` vì nguồn đảo kích thước không nhất quán.
// ============================================================================

import { VesselParticulars } from "../../domain/canonical/VesselParticulars";
import { ObservationValidationStatus } from "../../domain/observations/ObservationValidation";
import {
  ParticularsObservation,
  VesselObservationType,
  VesselSourceObservation,
} from "../../domain/observations/VesselObservation";
import { VesselField } from "../../domain/value-objects/VesselField";
import {
  FieldCandidate,
  Tactic,
  ValueComparison,
  compareNumber,
  resolveField,
} from "./fieldResolution";
import {
  DEFAULT_PARTICULARS_RESOLVER_POLICY,
  NumericTolerance,
  ParticularsResolverPolicy,
} from "./StaticResolverPolicy";
import { ResolvedField } from "./ResolverTypes";

export interface ResolvedParticulars {
  readonly mmsi: string;
  readonly length: ResolvedField<number> | null;
  readonly beam: ResolvedField<number> | null;
  readonly draught: ResolvedField<number> | null;
  readonly grossTonnage: ResolvedField<number> | null;
  readonly deadweight: ResolvedField<number> | null;
  readonly builtYear: ResolvedField<number> | null;
}

export interface ParticularsResolverDeps {
  policy?: ParticularsResolverPolicy;
}

export class ParticularsResolver {
  private readonly policy: ParticularsResolverPolicy;

  constructor(deps: ParticularsResolverDeps = {}) {
    this.policy = deps.policy ?? DEFAULT_PARTICULARS_RESOLVER_POLICY;
  }

  /**
   * @param observations Ứng viên của MỘT tàu. Nhóm khác PARTICULARS bị bỏ qua.
   * @returns null khi không còn observation PARTICULARS hợp lệ nào.
   */
  resolve(observations: readonly VesselSourceObservation[]): ResolvedParticulars | null {
    const usable: ParticularsObservation[] = [];
    for (const observation of observations) {
      if (observation.type !== VesselObservationType.PARTICULARS) continue;
      if (observation.validation.status === ObservationValidationStatus.INVALID) continue;
      usable.push(observation);
    }
    if (usable.length === 0) return null;

    const newest = [...usable].sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0];

    return {
      mmsi: newest.data.mmsi,

      // Kích thước tàu: hằng số vật lý -> hạng capability quyết định, không
      // phải độ mới. `shipinfo` là UNSUPPORTED nên không thể vượt `shipfinder`.
      length: this.numeric(usable, VesselField.LENGTH, (d) => d.length, this.policy.lengthTolerance, [
        Tactic.FIELD_QUALITY,
        Tactic.NEWER_FETCH,
      ]),
      beam: this.numeric(usable, VesselField.BEAM, (d) => d.beam, this.policy.beamTolerance, [
        Tactic.FIELD_QUALITY,
        Tactic.NEWER_FETCH,
      ]),

      // ⚠️ Mớn nước NỬA ĐỘNG: đổi theo hàng hoá từng chuyến, không phải hằng số
      // của con tàu. Canonical hiện xếp nó trong Particulars nên P8.3 giữ
      // nguyên chỗ, nhưng ưu tiên bản MỚI HƠN ngay sau hạng capability.
      // Nếu sau này cần chính xác theo chuyến thì phải có policy riêng —
      // KHÔNG thiết kế lại canonical model ở P8.3.
      draught: this.numeric(
        usable,
        VesselField.DRAUGHT,
        (d) => d.draught,
        this.policy.draughtTolerance,
        [Tactic.FIELD_QUALITY, Tactic.NEWER_FETCH]
      ),

      // Không suy GT từ DWT, không suy DWT từ kích thước.
      grossTonnage: this.numeric(
        usable,
        VesselField.GROSS_TONNAGE,
        (d) => d.grossTonnage,
        this.policy.tonnageTolerance,
        [Tactic.FIELD_QUALITY, Tactic.NEWER_FETCH]
      ),
      deadweight: this.numeric(
        usable,
        VesselField.DEADWEIGHT,
        (d) => d.deadweight,
        this.policy.tonnageTolerance,
        [Tactic.FIELD_QUALITY, Tactic.NEWER_FETCH]
      ),

      // Năm đóng bất biến: lệch 1 năm là SAI THẬT, không phải làm tròn.
      builtYear: this.numeric(
        usable,
        VesselField.BUILT_YEAR,
        (d) => d.builtYear,
        this.policy.builtYearTolerance,
        [Tactic.FIELD_QUALITY]
      ),
    };
  }

  private numeric(
    observations: readonly ParticularsObservation[],
    field: VesselField,
    pick: (data: VesselParticulars) => number | null | undefined,
    tolerance: NumericTolerance,
    tactics: readonly Tactic[]
  ): ResolvedField<number> | null {
    const candidates: FieldCandidate<number>[] = [];
    for (const observation of observations) {
      const value = pick(observation.data);
      // `null` KHÔNG bao giờ là ứng viên: một nguồn mới hơn nhưng thiếu field
      // không được xoá giá trị tốt của nguồn khác.
      if (value === null || value === undefined || !Number.isFinite(value)) continue;
      candidates.push({
        value,
        source: observation.source,
        observationId: observation.id,
        fetchedAt: observation.fetchedAt,
        observedAt: observation.sourceReceivedAt ?? null,
      });
    }

    return resolveField(candidates, {
      field,
      compare: (a, b): ValueComparison => compareNumber(a, b, tolerance),
      tactics,
    });
  }
}
