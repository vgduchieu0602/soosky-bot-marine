// ============================================================================
//  APPLICATION · IdentityResolver — THEO TỪNG FIELD. Hàm thuần.
// ----------------------------------------------------------------------------
//  KHÔNG chọn "nguồn thắng cho cả identity" rồi lấy hết field của nó. Mỗi field
//  đổi độc lập: tàu đổi tên nhưng giữ nguyên callsign; ShipInfo có tên nước mà
//  ShipFinder không có.
//
//  Bài học lớn nhất của P8.1: phần lớn "xung đột" quan sát được KHÔNG phải xung
//  đột. Phải chuẩn hoá TRƯỚC khi so:
//      "AGIA DOXA" vs "Agia Doxa"        -> chỉ khác cách viết
//      "Passenger ship" vs "Passenger Ship" -> chỉ khác cách viết
//      "LR" vs "LBR"                      -> chỉ khác hệ mã
//      "AMERICAN WEST" vs "Queen Of The West" -> XUNG ĐỘT THẬT (tàu đổi tên)
//
//  Không mạng, không DB, không đồng hồ ngầm.
// ============================================================================

import { VesselFlag, VesselIdentity } from "../../domain/canonical/VesselIdentity";
import { ObservationValidationStatus } from "../../domain/observations/ObservationValidation";
import {
  IdentityObservation,
  VesselObservationType,
  VesselSourceObservation,
} from "../../domain/observations/VesselObservation";
import { VesselField } from "../../domain/value-objects/VesselField";
import {
  FieldCandidate,
  Tactic,
  ValueComparison,
  compareText,
  resolveField,
} from "./fieldResolution";
import { normalizeFlagCode } from "./flagNormalization";
import {
  DEFAULT_IDENTITY_RESOLVER_POLICY,
  IdentityResolverPolicy,
} from "./StaticResolverPolicy";
import { ResolvedField } from "./ResolverTypes";

export interface ResolvedIdentity {
  /** Khoá tàu — lấy từ ứng viên, không phân xử. */
  readonly mmsi: string;
  readonly imo: ResolvedField<string> | null;
  readonly name: ResolvedField<string> | null;
  readonly callsign: ResolvedField<string> | null;
  readonly vesselType: ResolvedField<string> | null;
  readonly vesselTypeCode: ResolvedField<number> | null;
  /** `code` và `name` phân xử RIÊNG — có thể đến từ hai nguồn khác nhau. */
  readonly flagCode: ResolvedField<string> | null;
  readonly flagName: ResolvedField<string> | null;
}

export interface IdentityResolverDeps {
  policy?: IdentityResolverPolicy;
}

/**
 * So mã cờ SAU khi quy đổi về alpha-2.
 * `LR` vs `LBR` -> EQUAL (không phải xung đột).
 * alpha-3 lạ -> INCOMPARABLE, KHÔNG phải DIFFERENT: ta chưa chứng minh được
 * chúng khác nhau, chỉ là chưa so được.
 */
function compareFlagCode(a: string, b: string): ValueComparison {
  const left = normalizeFlagCode(a);
  const right = normalizeFlagCode(b);
  if (!left.known || !right.known) return ValueComparison.INCOMPARABLE;
  return left.code === right.code ? ValueComparison.EQUAL : ValueComparison.DIFFERENT;
}

export class IdentityResolver {
  private readonly policy: IdentityResolverPolicy;

  constructor(deps: IdentityResolverDeps = {}) {
    this.policy = deps.policy ?? DEFAULT_IDENTITY_RESOLVER_POLICY;
  }

  /**
   * @param observations Ứng viên của MỘT tàu. Nhóm khác IDENTITY bị bỏ qua.
   * @returns null khi không còn observation IDENTITY hợp lệ nào.
   */
  resolve(observations: readonly VesselSourceObservation[]): ResolvedIdentity | null {
    const usable: IdentityObservation[] = [];
    for (const observation of observations) {
      if (observation.type !== VesselObservationType.IDENTITY) continue;
      // Bản ghi hỏng không được vào vòng trong, dù mới hơn tất cả.
      if (observation.validation.status === ObservationValidationStatus.INVALID) continue;
      usable.push(observation);
    }
    if (usable.length === 0) return null;

    // Khoá tàu lấy từ ứng viên mới nhất; MMSI là khoá tra chứ không phải field tranh chấp.
    const newest = [...usable].sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0];

    return {
      mmsi: newest.data.mmsi,

      // IMO là định danh gần như VĨNH VIỄN. Cố ý KHÔNG dùng NEWER_FETCH: hai
      // nguồn nói hai IMO khác nhau thì "nguồn mới hơn" không phải bằng chứng
      // gì cả — một trong hai đơn giản là sai. Dựa vào hạng capability trước.
      imo: this.text(usable, VesselField.IMO, (d) => d.imo, [Tactic.FIELD_QUALITY]),

      // Tên tàu ĐỔI THẬT (quan sát được: "Queen Of The West" -> "AMERICAN WEST").
      // Khác nhau sau casefold -> lần nhìn thấy gần nhất thắng.
      name: this.text(usable, VesselField.NAME, (d) => d.name, [
        Tactic.FIELD_QUALITY,
        Tactic.NEWER_FETCH,
      ]),

      callsign: this.text(usable, VesselField.CALLSIGN, (d) => d.callsign, [
        Tactic.FIELD_QUALITY,
        Tactic.NEWER_FETCH,
      ]),

      // Độ CHI TIẾT quyết định, không phải độ mới: "Bulk Carrier" > "Cargo ship".
      vesselType: resolveField(
        this.candidates(usable, (d) => d.vesselType),
        {
          field: VesselField.VESSEL_TYPE,
          compare: compareText,
          tactics: [Tactic.FIELD_QUALITY, Tactic.SOURCE_PREFERENCE, Tactic.NEWER_FETCH],
          sourcePreference: this.policy.vesselTypePreference,
        }
      ),

      // Không suy mã từ nhãn chữ.
      vesselTypeCode: resolveField(
        this.candidates(usable, (d) => d.vesselTypeCode),
        { field: VesselField.VESSEL_TYPE_CODE, tactics: [Tactic.FIELD_QUALITY, Tactic.NEWER_FETCH] }
      ),

      flagCode: resolveField(
        this.candidates(usable, (d) => flagPart(d.flag, "code")),
        {
          field: VesselField.FLAG,
          compare: compareFlagCode,
          tactics: [Tactic.FIELD_QUALITY, Tactic.NEWER_FETCH],
        }
      ),
      flagName: resolveField(
        this.candidates(usable, (d) => flagPart(d.flag, "name")),
        { field: VesselField.FLAG, compare: compareText, tactics: [Tactic.FIELD_QUALITY, Tactic.NEWER_FETCH] }
      ),
    };
  }

  private text(
    observations: readonly IdentityObservation[],
    field: VesselField,
    pick: (data: VesselIdentity) => string | null | undefined,
    tactics: readonly Tactic[]
  ): ResolvedField<string> | null {
    return resolveField(this.candidates(observations, pick), {
      field,
      compare: compareText,
      tactics,
    });
  }

  /** Chỉ giữ ứng viên có giá trị THẬT — `null` không bao giờ là ứng viên. */
  private candidates<T>(
    observations: readonly IdentityObservation[],
    pick: (data: VesselIdentity) => T | null | undefined
  ): FieldCandidate<T>[] {
    const candidates: FieldCandidate<T>[] = [];
    for (const observation of observations) {
      const value = pick(observation.data);
      if (value === null || value === undefined) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      candidates.push({
        value,
        source: observation.source,
        observationId: observation.id,
        fetchedAt: observation.fetchedAt,
        observedAt: observation.sourceReceivedAt ?? null,
      });
    }
    return candidates;
  }
}

function flagPart(flag: VesselFlag | null | undefined, part: "code" | "name"): string | null {
  if (flag === null || flag === undefined) return null;
  return flag[part] ?? null;
}
