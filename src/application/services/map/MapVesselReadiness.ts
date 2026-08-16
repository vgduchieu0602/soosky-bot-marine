// ============================================================================
//  APPLICATION · MapVesselReadiness — "con tàu này có vẽ được lên map không?"
// ----------------------------------------------------------------------------
//  HÀM THUẦN. Không Mongo, không HTTP, không đọc đồng hồ — `now` do người gọi
//  truyền vào.
//
//  ⚠️ ĐIỀU QUAN TRỌNG NHẤT CỦA FILE NÀY: độ tươi được TÍNH LẠI, tuyệt đối không
//  đọc `position.freshness` đã lưu trong canonical.
//
//  Vì sao: canonical chỉ được ghi lại KHI CÓ DỮ LIỆU MỚI. Tàu ngừng phát tín
//  hiệu sẽ giữ nguyên `freshness: "LIVE"` trong document mãi mãi — bậc đó là ảnh
//  chụp tại LÚC PHÂN XỬ, không phải một sự thật vĩnh viễn. Tin nó là đẩy tàu ma
//  lên map. Xem docs/AIS_LOAD_AND_RETENTION.md §6.
// ============================================================================

import { isValidCoordinates } from "../../../domain/validators/geo";
import { ResolvedCurrentVessel } from "../resolution/ResolvedCurrentVessel";
import { DEFAULT_POSITION_RESOLVER_POLICY } from "../resolution/PositionResolverPolicy";

export const MapReadinessReason = {
  /** Không có MMSI — map của Marine đánh địa chỉ tàu bằng MMSI. */
  NO_MMSI: "NO_MMSI",
  /** Chưa nhóm POSITION nào được phân xử. */
  NO_POSITION: "NO_POSITION",
  /** Toạ độ không dùng được, hoặc mốc nguồn nằm ở tương lai. */
  INVALID_POSITION: "INVALID_POSITION",
  /**
   * Có vị trí nhưng nguồn KHÔNG khai mốc thời gian (bậc `NO_SOURCE_TIME`).
   * Không biết tuổi ≠ tuổi bằng 0 — không đủ điều kiện vẽ.
   */
  NO_POSITION_TIME: "NO_POSITION_TIME",
  /** Vị trí quá cũ so với ngưỡng hiện hành. */
  STALE_POSITION: "STALE_POSITION",
} as const;

export type MapReadinessReason =
  (typeof MapReadinessReason)[keyof typeof MapReadinessReason];

export interface MapReadinessResult {
  readonly ready: boolean;
  /** Vắng mặt khi `ready`. */
  readonly reason?: MapReadinessReason;
  /** Tuổi vị trí tính tại thời điểm hỏi. Vắng mặt khi không tính được. */
  readonly ageMs?: number;
}

export interface MapReadinessPolicy {
  /**
   * Vị trí cũ hơn ngần này -> không vẽ.
   *
   * Mặc định DÙNG LẠI `PositionResolverPolicy.staleMaxAgeMs` (24 giờ) — chính
   * là hằng số mà `POSITION_STALE_AFTER_MS` của hệ thống đang dùng để ẩn vị trí
   * hết hạn. Không khai một con số thứ hai cho cùng một khái niệm.
   */
  readonly maxPositionAgeMs: number;
  /**
   * Cho phép mốc nguồn nhỉnh hơn đồng hồ ta một chút (lệch đồng hồ giữa các máy).
   * Quá ngưỡng này thì mốc là RÁC, không phải "rất tươi" — nếu không, một mốc
   * hỏng ở tương lai sẽ nằm trên map vĩnh viễn.
   */
  readonly futureToleranceMs: number;
}

const MINUTE = 60 * 1000;

export const DEFAULT_MAP_READINESS_POLICY: Readonly<MapReadinessPolicy> = Object.freeze({
  maxPositionAgeMs: DEFAULT_POSITION_RESOLVER_POLICY.staleMaxAgeMs,
  futureToleranceMs: 5 * MINUTE,
});

/**
 * Điều kiện TỐI THIỂU để vẽ: MMSI + toạ độ hợp lệ + mốc nguồn còn hạn.
 *
 * ⚠️ IMO / tên / loại tàu / tốc độ / hướng / trạng thái hành hải đều KHÔNG bắt
 * buộc. Một chấm không nhãn vẫn là thông tin thật; ép có tên mới được vẽ sẽ
 * giấu mất phần lớn tàu vừa phát `PositionReport` mà chưa tới chu kỳ
 * `ShipStaticData` (~6 phút).
 */
export function evaluateMapReadiness(
  vessel: ResolvedCurrentVessel,
  now: Date,
  policy: MapReadinessPolicy = DEFAULT_MAP_READINESS_POLICY
): MapReadinessResult {
  if (vessel.vesselKey.mmsi === undefined || vessel.vesselKey.mmsi === "") {
    return { ready: false, reason: MapReadinessReason.NO_MMSI };
  }

  const resolved = vessel.position;
  if (resolved === null) {
    return { ready: false, reason: MapReadinessReason.NO_POSITION };
  }

  const report = resolved.position;
  if (!isValidCoordinates(report.lat, report.lng)) {
    return { ready: false, reason: MapReadinessReason.INVALID_POSITION };
  }

  // `observedAt` là mốc NGUỒN khai. KHÔNG thay bằng `fetchedAt`: đó là đồng hồ
  // của bot, và một vị trí ShipInfo trễ 14 giờ sẽ trông như vừa mới.
  const observedAt = resolved.observedAt;
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
    return { ready: false, reason: MapReadinessReason.NO_POSITION_TIME };
  }

  const ageMs = now.getTime() - observedAt.getTime();
  if (ageMs < -policy.futureToleranceMs) {
    return { ready: false, reason: MapReadinessReason.INVALID_POSITION, ageMs };
  }
  if (ageMs > policy.maxPositionAgeMs) {
    return { ready: false, reason: MapReadinessReason.STALE_POSITION, ageMs };
  }

  return { ready: true, ageMs };
}

export function isMapReady(
  vessel: ResolvedCurrentVessel,
  now: Date,
  policy: MapReadinessPolicy = DEFAULT_MAP_READINESS_POLICY
): boolean {
  return evaluateMapReadiness(vessel, now, policy).ready;
}
