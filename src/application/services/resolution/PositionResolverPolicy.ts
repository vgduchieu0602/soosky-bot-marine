// ============================================================================
//  APPLICATION · Chính sách độ tươi cho nhóm POSITION
// ----------------------------------------------------------------------------
//  Mọi ngưỡng nằm ở ĐÂY, không rải trong resolver — cùng bài học với
//  `SourceRuntimeConfig` ở P4.
//
//  Ba ngưỡng đầu KHÔNG phải số bịa: chúng lấy theo hành vi nguồn đã đo và theo
//  hằng số hệ thống đã tồn tại (RESOLVER_POLICY.md §D.4).
// ============================================================================

export const PositionFreshness = {
  /** ≤ 30 phút. Chỉ ShipFinder với tới (đo được 1–37 phút). */
  LIVE: "LIVE",
  /** ≤ 6 giờ — đúng `SCAN_INTERVAL_MS` mặc định, chu kỳ quét của VesselFinder. */
  RECENT: "RECENT",
  /** ≤ 24 giờ — đúng `POSITION_STALE_AFTER_MS` mà `/positions` đang dùng để lọc. */
  STALE: "STALE",
  /** > 24 giờ. Vượt ngưỡng hệ thống đã coi là hết hạn. */
  EXPIRED: "EXPIRED",
  /**
   * Nguồn KHÔNG khai mốc thời gian.
   * Thấp hơn cả EXPIRED: không biết tuổi ≠ tuổi bằng 0. Một vị trí không rõ
   * tuổi có thể cũ 5 phút hoặc 5 ngày; xếp nó ngang "vừa mới" là bịa.
   */
  NO_SOURCE_TIME: "NO_SOURCE_TIME",
} as const;

export type PositionFreshness = (typeof PositionFreshness)[keyof typeof PositionFreshness];

/** Nhỏ hơn = tươi hơn = tốt hơn. Chỉ dùng để SO SÁNH, không lộ ra ngoài. */
const FRESHNESS_RANK: Readonly<Record<PositionFreshness, number>> = Object.freeze({
  [PositionFreshness.LIVE]: 0,
  [PositionFreshness.RECENT]: 1,
  [PositionFreshness.STALE]: 2,
  [PositionFreshness.EXPIRED]: 3,
  [PositionFreshness.NO_SOURCE_TIME]: 4,
});

export function freshnessRank(freshness: PositionFreshness): number {
  return FRESHNESS_RANK[freshness];
}

export interface PositionResolverPolicy {
  liveMaxAgeMs: number;
  recentMaxAgeMs: number;
  staleMaxAgeMs: number;
  /**
   * Cửa sổ nạp ứng viên (lọc theo `fetchedAt`), dùng bởi use case chứ không
   * bởi resolver thuần.
   *
   * ⚠️ CỐ Ý rộng hơn `staleMaxAgeMs`. Lọc đúng 24 giờ sẽ khiến hai bậc cuối
   * (EXPIRED và NO_SOURCE_TIME) không bao giờ tới được resolver — tức là bỏ đi
   * chính cái phao cứu sinh mà chính sách định nghĩa cho tàu ít dữ liệu.
   * 7 ngày vẫn chặn được truy vấn, không nạp lịch sử vô hạn.
   */
  candidateWindowMs: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_POSITION_RESOLVER_POLICY: Readonly<PositionResolverPolicy> = Object.freeze({
  liveMaxAgeMs: 30 * MINUTE,
  recentMaxAgeMs: 6 * HOUR,
  staleMaxAgeMs: 24 * HOUR,
  candidateWindowMs: 7 * DAY,
});

/**
 * Xếp bậc độ tươi.
 *
 * ⚠️ CHỈ nhận `sourceReceivedAt` — mốc do NGUỒN khai. TUYỆT ĐỐI không nhận
 * `fetchedAt`: ShipInfo crawl xong lúc 10:40 nhưng vị trí thật là 14.5 giờ
 * trước; dùng `fetchedAt` sẽ khiến nó trông "vừa mới" (RESOLVER_POLICY.md §D.2).
 *
 * Mốc rơi vào tương lai vẫn xếp LIVE — mapper của từng nguồn đã có lưới chặn
 * riêng, và resolver không phải chỗ kiểm lại tính hợp lệ của mốc thời gian.
 */
export function classifyPositionFreshness(
  sourceReceivedAt: Date | null | undefined,
  now: Date,
  policy: PositionResolverPolicy = DEFAULT_POSITION_RESOLVER_POLICY
): PositionFreshness {
  if (!(sourceReceivedAt instanceof Date) || !Number.isFinite(sourceReceivedAt.getTime())) {
    return PositionFreshness.NO_SOURCE_TIME;
  }

  const ageMs = now.getTime() - sourceReceivedAt.getTime();
  if (ageMs <= policy.liveMaxAgeMs) return PositionFreshness.LIVE;
  if (ageMs <= policy.recentMaxAgeMs) return PositionFreshness.RECENT;
  if (ageMs <= policy.staleMaxAgeMs) return PositionFreshness.STALE;
  return PositionFreshness.EXPIRED;
}
