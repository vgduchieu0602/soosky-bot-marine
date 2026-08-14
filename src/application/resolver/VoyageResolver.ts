// ============================================================================
//  APPLICATION · VoyageResolver — THEO TỪNG FIELD. Hàm thuần.
// ----------------------------------------------------------------------------
//  Khác Identity/Particulars ở THỨ TỰ TIÊU CHÍ: voyage ưu tiên `NEWER_FETCH`
//  TRƯỚC hạng capability.
//
//  Lý do: dữ liệu chuyến đi gắn với CHUYẾN HIỆN TẠI, không phải với con tàu.
//  Một `destination` mới hơn phản ánh chuyến mới; một nguồn "uy tín hơn" nhưng
//  nói về chuyến trước thì đơn giản là đã lỗi thời. Ngược lại `builtYear` thì
//  độ mới chẳng nói lên gì (RESOLVER_POLICY.md §G).
//
//  Không mạng, không DB, không đồng hồ ngầm.
//
//  ⚠️ Chỉ đọc CANONICAL observation. Không parse lại chuỗi thô — P7 mapper đã
//  quyết định không map ETA vì nguồn thiếu năm, resolver KHÔNG được phá ranh
//  giới đó bằng cách tự đoán năm.
// ============================================================================

import { VesselVoyage } from "../../domain/canonical/VesselVoyage";
import { ObservationValidationStatus } from "../../domain/observations/ObservationValidation";
import {
  VesselObservationType,
  VesselSourceObservation,
  VoyageObservation,
} from "../../domain/observations/VesselObservation";
import { VesselField } from "../../domain/value-objects/VesselField";
import {
  FieldCandidate,
  Tactic,
  compareDate,
  compareText,
  resolveField,
} from "./fieldResolution";
import { ResolvedField } from "./ResolverTypes";

export interface ResolvedVoyage {
  readonly mmsi: string;
  readonly destination: ResolvedField<string> | null;
  readonly eta: ResolvedField<Date> | null;
  readonly currentPort: ResolvedField<string> | null;
  readonly nextPort: ResolvedField<string> | null;
  readonly lastPort: ResolvedField<string> | null;
  readonly lastPortDepartureAt: ResolvedField<Date> | null;
}

/**
 * Voyage: bản nhìn thấy gần nhất thắng, rồi mới tới hạng capability.
 * Ngược thứ tự so với Identity/Particulars — xem ghi chú đầu file.
 */
const VOYAGE_TACTICS: readonly Tactic[] = Object.freeze([Tactic.NEWER_FETCH, Tactic.FIELD_QUALITY]);

export class VoyageResolver {
  /**
   * @param observations Ứng viên của MỘT tàu. Nhóm khác VOYAGE bị bỏ qua.
   * @returns null khi không còn observation VOYAGE hợp lệ nào.
   */
  resolve(observations: readonly VesselSourceObservation[]): ResolvedVoyage | null {
    const usable: VoyageObservation[] = [];
    for (const observation of observations) {
      if (observation.type !== VesselObservationType.VOYAGE) continue;
      // Bản ghi hỏng không được vào vòng trong, dù mới hơn tất cả.
      if (observation.validation.status === ObservationValidationStatus.INVALID) continue;
      usable.push(observation);
    }
    if (usable.length === 0) return null;

    const newest = [...usable].sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0];

    return {
      mmsi: newest.data.mmsi,

      // Chuỗi thô do thuyền viên gõ. So bằng casefold: "LONG BEACH, US" và
      // "Long Beach,  US" là MỘT. Không geocode, không tra UN/LOCODE.
      destination: this.text(usable, VesselField.DESTINATION, (d) => d.destination),

      // Chỉ nhận `Date` canonical đã hợp lệ. Hiện `null` ở mọi nguồn vì
      // ShipFinder cho "07-29 07:01" (thiếu năm) và mapper cố ý không map.
      eta: this.date(usable, VesselField.ETA, (d) => d.eta),

      // Cảng: KHÔNG suy `currentPort` từ `destination`, KHÔNG suy `lastPort`
      // từ lịch sử. Nguồn không nói thì để trống.
      currentPort: this.text(usable, VesselField.CURRENT_PORT, (d) => d.currentPort),
      nextPort: this.text(usable, VesselField.NEXT_PORT, (d) => d.nextPort),
      lastPort: this.text(usable, VesselField.LAST_PORT, (d) => d.lastPort),
      lastPortDepartureAt: this.date(
        usable,
        VesselField.LAST_PORT_DEPARTURE_AT,
        (d) => d.lastPortDepartureAt
      ),
    };
  }

  private text(
    observations: readonly VoyageObservation[],
    field: VesselField,
    pick: (data: VesselVoyage) => string | null | undefined
  ): ResolvedField<string> | null {
    const candidates: FieldCandidate<string>[] = [];
    for (const observation of observations) {
      const value = pick(observation.data);
      // `null` KHÔNG bao giờ là ứng viên: nguồn mới hơn nhưng thiếu field không
      // được xoá giá trị tốt của nguồn khác.
      if (typeof value !== "string" || value.trim() === "") continue;
      candidates.push(VoyageResolver.candidate(observation, value));
    }
    return resolveField(candidates, { field, compare: compareText, tactics: VOYAGE_TACTICS });
  }

  private date(
    observations: readonly VoyageObservation[],
    field: VesselField,
    pick: (data: VesselVoyage) => Date | null | undefined
  ): ResolvedField<Date> | null {
    const candidates: FieldCandidate<Date>[] = [];
    for (const observation of observations) {
      const value = pick(observation.data);
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) continue;
      candidates.push(VoyageResolver.candidate(observation, value));
    }
    return resolveField(candidates, { field, compare: compareDate, tactics: VOYAGE_TACTICS });
  }

  private static candidate<T>(observation: VoyageObservation, value: T): FieldCandidate<T> {
    return {
      value,
      source: observation.source,
      observationId: observation.id,
      fetchedAt: observation.fetchedAt,
      observedAt: observation.sourceReceivedAt ?? null,
    };
  }
}
