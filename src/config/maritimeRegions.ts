// ============================================================================
//  CONFIG · Danh mục vùng biển để LẬP LỊCH quét
// ----------------------------------------------------------------------------
//  Đây là CẤU HÌNH VẬN HÀNH, không phải khái niệm nghiệp vụ. Một "region" ở đây
//  chỉ là một hình chữ nhật ta chĩa scanner vào, kèm phỏng đoán ban đầu về mật
//  độ tàu. Vì thế nó KHÔNG nằm trong `domain/entities` và KHÔNG có aggregate:
//  không có luật nghiệp vụ nào của tàu phụ thuộc vào việc ta chia vùng thế nào.
//
//  Bậc mật độ ở đây chỉ là ĐIỂM XUẤT PHÁT. Sau lần quét thành công đầu tiên,
//  `RegionSchedulePolicy` sẽ tự phân loại lại bằng số tàu ĐO ĐƯỢC — bảng này
//  không phải nguồn sự thật lâu dài.
//
//  Cố ý KHÔNG phủ toàn cầu: 9 vùng đại diện của US/UK/Norway, dùng lại đúng các
//  bbox đã chứng minh có tàu ở các phase trước.
// ============================================================================

import { BoundingBox } from "../application/contracts/geo/Geo";

/** Bậc mật độ giao thông — quyết định khoảng cách giữa hai lần quét. */
export const RegionTrafficTier = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
  EMPTY_OR_RARE: "EMPTY_OR_RARE",
} as const;

export type RegionTrafficTier = (typeof RegionTrafficTier)[keyof typeof RegionTrafficTier];

export interface MaritimeRegion {
  readonly id: string;
  readonly name: string;
  readonly country: "US" | "UK" | "NORWAY";
  readonly bbox: BoundingBox;
  /** Phỏng đoán ban đầu, sẽ bị số đo thật ghi đè. */
  readonly baseTier: RegionTrafficTier;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Khoảng cách quét theo bậc. Là KHOẢNG, không phải một con số cứng. */
export interface TierInterval {
  readonly minMs: number;
  readonly maxMs: number;
}

export const DEFAULT_TIER_INTERVALS: Readonly<Record<RegionTrafficTier, TierInterval>> =
  Object.freeze({
    [RegionTrafficTier.HIGH]: Object.freeze({ minMs: 10 * MINUTE, maxMs: 20 * MINUTE }),
    [RegionTrafficTier.MEDIUM]: Object.freeze({ minMs: 30 * MINUTE, maxMs: 60 * MINUTE }),
    [RegionTrafficTier.LOW]: Object.freeze({ minMs: 2 * HOUR, maxMs: 4 * HOUR }),
    [RegionTrafficTier.EMPTY_OR_RARE]: Object.freeze({ minMs: 6 * HOUR, maxMs: 12 * HOUR }),
  });

/**
 * Chặn TUYỆT ĐỐI. Dù chính sách có tính sai thế nào, không vùng nào được quét
 * dày hơn 10 phút/lần, và cũng không vùng nào bị bỏ quên quá 12 giờ.
 */
export const ABSOLUTE_MIN_INTERVAL_MS = 10 * MINUTE;
export const ABSOLUTE_MAX_INTERVAL_MS = 12 * HOUR;

/** Nghỉ giữa hai VÙNG (không phải giữa hai tile). */
export const REGION_PAUSE_MS: TierInterval = Object.freeze({ minMs: 30_000, maxMs: 90_000 });

/**
 * Nghỉ giữa hai request tile của VesselFinder.
 *
 * Nới quanh mốc 15s đang dùng (`SCAN_TILE_DELAY_MS`) thành một khoảng 12–22s để
 * nhịp không đều như máy. CỐ Ý không hạ thấp hơn mức bảo thủ hiện tại.
 */
export const TILE_DELAY_MS: TierInterval = Object.freeze({ minMs: 12_000, maxMs: 22_000 });

/** Một vùng một lúc. KHÔNG song song hoá VesselFinder (§15). */
export const REGION_SCAN_CONCURRENCY = 1;

/**
 * Trần số tàu được "hoàn thiện VesselBasics" sau MỖI lần quét vùng.
 * Quét ra 500 tàu không có nghĩa là bắn 500 lượt tra cứu (§24).
 */
export const COMPLETION_BUDGET_PER_CYCLE = 15;

/**
 * 9 vùng đại diện. Bbox lấy nguyên từ các phase trước — đều đã đo được có tàu
 * thật, nên đây không phải toạ độ phỏng đoán.
 */
export const MARITIME_REGIONS: readonly MaritimeRegion[] = Object.freeze([
  {
    id: "us-east-ny-nj",
    name: "US East Coast — New York / New Jersey approaches",
    country: "US",
    bbox: { minLat: 40.4, minLon: -74.3, maxLat: 40.9, maxLon: -73.7 },
    baseTier: RegionTrafficTier.HIGH,
  },
  {
    id: "us-west-la-lb",
    name: "US West Coast — Los Angeles / Long Beach",
    country: "US",
    bbox: { minLat: 33.5, minLon: -118.4, maxLat: 33.9, maxLon: -118.0 },
    baseTier: RegionTrafficTier.HIGH,
  },
  {
    id: "us-gulf-houston",
    name: "Gulf of Mexico — Houston / Galveston",
    country: "US",
    bbox: { minLat: 29.2, minLon: -95.2, maxLat: 29.8, maxLon: -94.5 },
    baseTier: RegionTrafficTier.MEDIUM,
  },
  {
    id: "uk-english-channel",
    name: "English Channel — Dover Strait",
    country: "UK",
    bbox: { minLat: 50.8, minLon: 0.8, maxLat: 51.3, maxLon: 1.6 },
    baseTier: RegionTrafficTier.HIGH,
  },
  {
    id: "uk-thames",
    name: "Thames approaches",
    country: "UK",
    bbox: { minLat: 51.3, minLon: 0.4, maxLat: 51.7, maxLon: 1.2 },
    baseTier: RegionTrafficTier.MEDIUM,
  },
  {
    id: "uk-irish-sea",
    name: "Irish Sea — Liverpool Bay",
    country: "UK",
    bbox: { minLat: 53.2, minLon: -3.3, maxLat: 53.6, maxLon: -2.8 },
    baseTier: RegionTrafficTier.MEDIUM,
  },
  {
    id: "no-oslofjord",
    name: "Oslofjord",
    country: "NORWAY",
    bbox: { minLat: 59.6, minLon: 10.3, maxLat: 59.95, maxLon: 10.9 },
    baseTier: RegionTrafficTier.MEDIUM,
  },
  {
    id: "no-bergen-coast",
    name: "Bergen / coastal",
    country: "NORWAY",
    bbox: { minLat: 60.2, minLon: 4.9, maxLat: 60.5, maxLon: 5.5 },
    baseTier: RegionTrafficTier.MEDIUM,
  },
  {
    id: "no-northern-coast",
    name: "Northern coastal corridor — Tromsø",
    country: "NORWAY",
    bbox: { minLat: 69.5, minLon: 18.7, maxLat: 69.8, maxLon: 19.3 },
    baseTier: RegionTrafficTier.LOW,
  },
]);

export function findMaritimeRegion(id: string): MaritimeRegion | undefined {
  return MARITIME_REGIONS.find((region) => region.id === id);
}
