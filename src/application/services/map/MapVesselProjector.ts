// ============================================================================
//  APPLICATION · MapVesselProjector — canonical -> object phẳng an toàn cho map
// ----------------------------------------------------------------------------
//  HÀM THUẦN. Bóc `ResolvedField.value` ra khỏi provenance để tầng map không
//  phải hiểu cấu trúc phân xử.
//
//  ⛔ ĐÂY KHÔNG PHẢI `VesselSimple`. Kiểu đó thuộc ranh giới tương thích với
//     Soosky-marine-api và sẽ được dựng ở phase sau, ở ĐÚNG chỗ đó. Canonical
//     giữ độc lập: `lng` (không phải `lon`), MMSI/IMO là CHUỖI, thiếu thì `null`.
//
//  ⛔ TUYỆT ĐỐI không bịa giá trị mặc định: không `imo = 0`, không `name = "N/A"`,
//     không `speed = 0`. Adapter của Marine API sau này muốn đổi thì đó là việc
//     của adapter — canonical nói "không biết" thì phải là `null`.
// ============================================================================

import { NavigationStatus } from "../../../domain/value-objects/VesselPositionReport";
import { ResolvedCurrentVessel } from "../resolution/ResolvedCurrentVessel";
import {
  DEFAULT_MAP_READINESS_POLICY,
  MapReadinessPolicy,
  evaluateMapReadiness,
} from "./MapVesselReadiness";

export interface MapVessel {
  readonly mmsi: string;
  readonly imo: string | null;
  readonly vesselName: string | null;
  readonly vesselTypeCode: number | null;
  readonly lat: number;
  /** ⚠️ Canonical dùng `lng`. Đổi tên sang `lon` là việc của adapter Marine API. */
  readonly lng: number;
  readonly course: number | null;
  readonly speed: number | null;
  readonly navStatus: NavigationStatus | null;
  /** Mốc NGUỒN khai — thứ duy nhất dùng để tính tuổi. */
  readonly observedAt: Date;
  /** Nguồn thắng ở nhóm POSITION. Giữ lại để debug map. */
  readonly positionSource: string;
  /** Tuổi tại thời điểm chiếu. Người đọc KHÔNG được cache lại con số này. */
  readonly ageMs: number;
}

/**
 * @returns `null` khi tàu chưa đủ điều kiện vẽ — lý do tra bằng
 *          `evaluateMapReadiness`. Trả `null` thay vì object thiếu field để
 *          không ai vô tình vẽ một chấm không có toạ độ.
 */
export function projectMapVessel(
  vessel: ResolvedCurrentVessel,
  now: Date,
  policy: MapReadinessPolicy = DEFAULT_MAP_READINESS_POLICY
): MapVessel | null {
  const readiness = evaluateMapReadiness(vessel, now, policy);
  if (!readiness.ready) return null;

  // `ready` đã bảo đảm cả bốn thứ dưới đây tồn tại và hợp lệ.
  const resolved = vessel.position!;
  const report = resolved.position;
  const identity = vessel.identity;

  return {
    mmsi: vessel.vesselKey.mmsi!,
    imo: vessel.vesselKey.imo ?? identity?.imo?.value ?? null,
    vesselName: identity?.name?.value ?? null,
    vesselTypeCode: identity?.vesselTypeCode?.value ?? null,
    lat: report.lat,
    lng: report.lng,
    course: report.course ?? null,
    speed: report.speed ?? null,
    navStatus: report.navStatus ?? null,
    observedAt: resolved.observedAt!,
    positionSource: resolved.source,
    ageMs: readiness.ageMs!,
  };
}

/** Chiếu cả danh sách, bỏ tàu chưa đủ điều kiện. Giữ thứ tự đầu vào. */
export function projectMapVessels(
  vessels: readonly ResolvedCurrentVessel[],
  now: Date,
  policy: MapReadinessPolicy = DEFAULT_MAP_READINESS_POLICY
): readonly MapVessel[] {
  const out: MapVessel[] = [];
  for (const vessel of vessels) {
    const projected = projectMapVessel(vessel, now, policy);
    if (projected !== null) out.push(projected);
  }
  return Object.freeze(out);
}
