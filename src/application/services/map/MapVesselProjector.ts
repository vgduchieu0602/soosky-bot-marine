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

/**
 * Payload MỎNG cho một chấm trên map.
 *
 * ⛔ KHÔNG mang: `rejected` (danh sách nguồn thua), `reason`, `observationId`,
 *    `contentHash`, `particulars`, `voyage`, `SourceMetadata`. Chúng là dữ liệu
 *    phân xử — hữu ích khi debug một con tàu, vô dụng khi vẽ mười nghìn chấm,
 *    và là thứ thổi payload từ vài trăm byte lên vài kilobyte mỗi tàu.
 *
 * ⚠️ Ở đây dùng `lon` (không phải `lng` của canonical): đây là payload MAP, và
 *    cả GeoJSON lẫn contract của Marine API đều gọi là `lon`. Việc quy đổi nằm
 *    gọn trong file này, không rò ra chỗ khác.
 */
export interface MapVesselItem {
  readonly mmsi: string;
  readonly imo: string | null;
  readonly vesselName: string | null;
  readonly vesselTypeCode: number | null;
  readonly lat: number;
  readonly lon: number;
  readonly course: number | null;
  readonly speed: number | null;
  /** Tách `{code, text}` thành hai field phẳng — người vẽ map cần một trong hai. */
  readonly navStatusCode: number | null;
  readonly navStatusText: string | null;
  /** Mốc NGUỒN khai. Người đọc tính tuổi từ đây, KHÔNG cache bậc độ tươi. */
  readonly observedAt: Date;
}

function navStatusOf(status: NavigationStatus | null | undefined): {
  code: number | null;
  text: string | null;
} {
  return { code: status?.code ?? null, text: status?.text ?? null };
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
): MapVesselItem | null {
  const readiness = evaluateMapReadiness(vessel, now, policy);
  if (!readiness.ready) return null;

  // `ready` đã bảo đảm cả bốn thứ dưới đây tồn tại và hợp lệ.
  const resolved = vessel.position!;
  const report = resolved.position;
  const identity = vessel.identity;
  const navStatus = navStatusOf(report.navStatus);

  return {
    mmsi: vessel.vesselKey.mmsi!,
    imo: vessel.vesselKey.imo ?? identity?.imo?.value ?? null,
    vesselName: identity?.name?.value ?? null,
    vesselTypeCode: identity?.vesselTypeCode?.value ?? null,
    lat: report.lat,
    lon: report.lng,
    course: report.course ?? null,
    speed: report.speed ?? null,
    navStatusCode: navStatus.code,
    navStatusText: navStatus.text,
    observedAt: resolved.observedAt!,
  };
}

/** Chiếu cả danh sách, bỏ tàu chưa đủ điều kiện. Giữ thứ tự đầu vào. */
export function projectMapVessels(
  vessels: readonly ResolvedCurrentVessel[],
  now: Date,
  policy: MapReadinessPolicy = DEFAULT_MAP_READINESS_POLICY
): readonly MapVesselItem[] {
  const out: MapVesselItem[] = [];
  for (const vessel of vessels) {
    const projected = projectMapVessel(vessel, now, policy);
    if (projected !== null) out.push(projected);
  }
  return Object.freeze(out);
}
