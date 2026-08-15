// ============================================================================
//  APPLICATION · Ngưỡng của bộ kiểm sufficiency
// ----------------------------------------------------------------------------
//  Mọi con số nằm ở ĐÂY, không rải trong checker — cùng bài học với
//  `SourceRuntimeConfig` (P4) và `PositionResolverPolicy` (P8.2).
//
//  KHÔNG có ngưỡng "bao nhiêu phút thì vị trí còn tươi": bậc độ tươi đã do
//  `PositionResolver` tính và đóng dấu vào `ResolvedPosition.freshness`. Tính
//  lại ở đây là dựng bộ luật thứ hai cho cùng một câu hỏi — hai bộ sẽ trôi khỏi
//  nhau. Ở đây chỉ khai BẬC NÀO ĐƯỢC CHẤP NHẬN cho từng need.
//
//  Nguồn gốc mọi hằng: ACQUISITION_POLICY.md §D và phụ lục.
// ============================================================================

import {
  DEFAULT_POSITION_RESOLVER_POLICY,
  PositionFreshness,
} from "../resolver/PositionResolverPolicy";

export interface SufficiencyPolicy {
  /**
   * Bậc độ tươi CHẤP NHẬN ĐƯỢC cho need `POSITION` — "tàu ở đâu BÂY GIỜ".
   *
   * Chỉ `LIVE`. Ngưỡng này khớp đúng thứ nguồn tốt nhất của ta thật sự đạt
   * được: POC P7 đo ShipFinder trả vị trí tuổi 1–37 phút. Chặt hơn thì không
   * nguồn nào thoả (crawl vô hạn), lỏng hơn thì ShipFinder gần như không bao
   * giờ được gọi và ta trả về vị trí lệch tới 72 hải lý cho tàu chạy 12 knot.
   */
  readonly positionFreshnessForPosition: readonly PositionFreshness[];

  /**
   * Bậc chấp nhận được cho nhánh vị trí của need `FULL`.
   *
   * NỚI hơn: `FULL` là nhu cầu hiển thị hồ sơ tàu, không phải theo dõi thời
   * gian thực. Đòi `LIVE` ở đây biến mọi lần mở trang chi tiết thành một lần
   * crawl.
   */
  readonly positionFreshnessForFull: readonly PositionFreshness[];

  /** Tuổi tối đa của `destination` (đo bằng `fetchedAt`). */
  readonly voyageMaxAgeMs: number;

  /**
   * Tuổi tối đa của `draught` KHI người gọi yêu cầu đích danh.
   *
   * ⚠️ `draught` NỬA ĐỘNG: đổi theo hàng hoá từng chuyến, không phải hằng số
   * của con tàu như `length`/`beam`. Canonical hiện xếp nó trong Particulars
   * (RESOLVER_POLICY.md §Q.2) và P9.2 KHÔNG thiết kế lại model — chỉ áp thang
   * thời gian của chuyến đi cho riêng field này.
   */
  readonly draughtMaxAgeMs: number;
}

/**
 * 6 giờ lấy từ `recentMaxAgeMs` của policy vị trí — chính là `SCAN_INTERVAL_MS`
 * mặc định, nhịp quét mà hệ thống đang chạy. Tham chiếu thay vì viết lại số:
 * đổi nhịp quét thì hai chỗ không thể trôi khỏi nhau.
 */
const VOYAGE_SCALE_MS = DEFAULT_POSITION_RESOLVER_POLICY.recentMaxAgeMs;

export const DEFAULT_SUFFICIENCY_POLICY: Readonly<SufficiencyPolicy> = Object.freeze({
  positionFreshnessForPosition: Object.freeze([PositionFreshness.LIVE]),
  positionFreshnessForFull: Object.freeze([PositionFreshness.LIVE, PositionFreshness.RECENT]),
  voyageMaxAgeMs: VOYAGE_SCALE_MS,
  draughtMaxAgeMs: VOYAGE_SCALE_MS,
});

/**
 * Tuổi tính bằng mili giây, KHÔNG BAO GIỜ âm.
 *
 * `fetchedAt` trong tương lai là lệch đồng hồ vài giây giữa bot và DB, không
 * phải dữ liệu hỏng. Coi nó là "vừa lấy xong" (tuổi 0). Loại một con tàu vì
 * 5 giây lệch đồng hồ là phản ứng sai với một vấn đề không tồn tại.
 */
export function ageMs(fetchedAt: Date, now: Date): number {
  return Math.max(0, now.getTime() - fetchedAt.getTime());
}
