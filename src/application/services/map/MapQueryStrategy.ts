// ============================================================================
//  APPLICATION · Zoom -> chế độ trả lời. HÀM THUẦN, không Mongo.
// ----------------------------------------------------------------------------
//  Chỉ HAI chế độ, và cố ý không hơn:
//
//      CLUSTERS   zoom thấp / viewport rộng  -> mật độ theo ô lưới
//      VESSELS    zoom cao  / viewport hẹp   -> từng con tàu
//
//  ⛔ Không `MapStrategyFactory`, không `ClusterEngine`, không đăng ký chiến
//     lược động. Một hàm, một ngưỡng, một bảng cấu hình.
// ============================================================================

import { MAX_ZOOM, MIN_ZOOM, isValidZoom } from "./MapGrid";

export const MapQueryMode = {
  CLUSTERS: "CLUSTERS",
  VESSELS: "VESSELS",
} as const;

export type MapQueryMode = (typeof MapQueryMode)[keyof typeof MapQueryMode];

export interface MapQueryStrategyPolicy {
  /**
   * Zoom **nhỏ hơn** giá trị này -> gộp cụm.
   *
   * Mốc khởi điểm 6 (tức zoom 0–5 là cụm) lấy theo quy ước slippy map: ở zoom 6
   * một màn hình phủ cỡ một quốc gia/biển khu vực, số tàu còn nằm trong trần
   * 1.000 của MAP-2; dưới mức đó thì danh sách bị cắt cụt và thiên lệch.
   *
   * ⚠️ Đây là mốc để ĐO, không phải hằng số thiêng. Đo mật độ thật rồi chỉnh —
   * xem docs/MAP_ZOOM_AND_DENSITY.md.
   */
  readonly vesselModeMinZoom: number;
  /**
   * Lưới gộp mịn hơn zoom hiển thị bao nhiêu bậc.
   *
   * `+2` = mỗi ô hiển thị chia 4×4 = 16 ô lưới: đủ để cụm bám theo hình dạng
   * thật của luồng tàu thay vì dồn hết vào một chấm giữa màn hình.
   *
   * ⚠️ ĐO RỒI MỚI CHỌN, không phải đoán. Với `+3`, viewport toàn cầu ở zoom 2
   * dùng lưới zoom 5 = 32×32 = 1.024 ô; đo trên 10.000 tàu rải đều thì nó vượt
   * trần 500 cụm và trả về `truncated=true` — tức là vẫn cắt cụt đúng thứ mà
   * MAP-3 sinh ra để tránh. `+2` cho tối đa 256 ô toàn cầu, nằm gọn dưới trần.
   * Xem docs/MAP_ZOOM_AND_DENSITY.md §"Benchmark".
   */
  readonly gridZoomOffset: number;
}

export const DEFAULT_MAP_QUERY_STRATEGY: Readonly<MapQueryStrategyPolicy> = Object.freeze({
  vesselModeMinZoom: 6,
  gridZoomOffset: 2,
});

export class InvalidZoomError extends Error {
  constructor(readonly zoom: unknown) {
    super(`Zoom phải là số trong [${MIN_ZOOM}, ${MAX_ZOOM}], nhận ${String(zoom)}`);
    this.name = "InvalidZoomError";
  }
}

export interface MapQueryPlan {
  readonly mode: MapQueryMode;
  /** Chỉ có nghĩa ở chế độ CLUSTERS. */
  readonly gridZoom: number;
}

/** @throws InvalidZoomError khi zoom ngoài [0, 22] hoặc không phải số hữu hạn. */
export function planMapQuery(
  zoom: unknown,
  policy: MapQueryStrategyPolicy = DEFAULT_MAP_QUERY_STRATEGY
): MapQueryPlan {
  if (!isValidZoom(zoom)) throw new InvalidZoomError(zoom);

  if (zoom >= policy.vesselModeMinZoom) {
    return { mode: MapQueryMode.VESSELS, gridZoom: Math.floor(zoom) };
  }

  // Kẹp về [0, MAX_ZOOM]: lưới mịn hơn màn hình là được, nhưng vượt 22 thì
  // `2^z` bắt đầu mất ý nghĩa thực tế.
  const gridZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.floor(zoom) + policy.gridZoomOffset));
  return { mode: MapQueryMode.CLUSTERS, gridZoom };
}
