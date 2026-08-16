// ============================================================================
//  APPLICATION · Lưới gộp cụm theo Web Mercator. HÀM THUẦN.
// ----------------------------------------------------------------------------
//  Không Mongo, không phụ thuộc ngoài. Không H3, không geohash — chỉ đúng phép
//  toán mà mọi map di động đang dùng để chia ô (`slippy map tile`).
//
//  Vì sao Web Mercator chứ không phải lưới lat/lon đều: lưới lat/lon cho ra ô
//  méo dần về phía cực (ở 60° vĩ, một ô 1°×1° hẹp bằng nửa ô ở xích đạo), nên
//  cụm ở Bắc Âu trông dày giả tạo so với cụm ở Singapore. Ô Mercator thì VUÔNG
//  TRÊN MÀN HÌNH — đúng thứ người dùng nhìn thấy.
// ============================================================================

/**
 * Giới hạn vĩ độ của Web Mercator.
 *
 * ⚠️ BẮT BUỘC kẹp. Ở đúng ±90°, `cos(lat) = 0` và phép chia trong công thức
 * dưới đây thành chia cho 0 -> `Infinity` -> `NaN` -> ô rác. Đây là con số quy
 * ước của mọi map dùng Mercator: `atan(sinh(π)) ≈ 85.0511°`.
 */
export const WEB_MERCATOR_MAX_LAT = 85.05112878;

/** Mức zoom hợp lệ, theo quy ước slippy map. */
export const MIN_ZOOM = 0;
export const MAX_ZOOM = 22;

export interface GridCell {
  readonly gridZoom: number;
  readonly x: number;
  readonly y: number;
}

export function isValidZoom(zoom: unknown): zoom is number {
  return (
    typeof zoom === "number" &&
    Number.isFinite(zoom) &&
    zoom >= MIN_ZOOM &&
    zoom <= MAX_ZOOM
  );
}

export function clampLatitude(lat: number): number {
  return Math.min(WEB_MERCATOR_MAX_LAT, Math.max(-WEB_MERCATOR_MAX_LAT, lat));
}

/** Số ô mỗi cạnh ở mức zoom này: `2^z`. */
export function gridSize(gridZoom: number): number {
  return 2 ** gridZoom;
}

/**
 * Toạ độ -> ô lưới.
 *
 *     n = 2^z
 *     x = floor( (lon + 180) / 360 * n )
 *     y = floor( (1 - ln(tan(φ) + sec(φ)) / π) / 2 * n )
 *
 * Kẹp cả hai đầu vào [0, n-1]: `lon = 180` cho ra đúng `n`, tức là tràn một ô
 * ra ngoài bảng.
 */
export function toGridCell(lat: number, lon: number, gridZoom: number): GridCell {
  const n = gridSize(gridZoom);
  const clamped = (clampLatitude(lat) * Math.PI) / 180;

  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(clamped) + 1 / Math.cos(clamped)) / Math.PI) / 2) * n
  );

  return {
    gridZoom,
    x: Math.min(n - 1, Math.max(0, x)),
    y: Math.min(n - 1, Math.max(0, y)),
  };
}

/**
 * Khoá cụm — TẤT ĐỊNH theo (zoom lưới, x, y).
 *
 * ⚠️ Không dùng `ObjectId`, không dùng số ngẫu nhiên. FE cần khoá ổn định giữa
 * hai lần tải để cập nhật marker tại chỗ thay vì xoá rồi vẽ lại toàn bộ. Và
 * chính vì khoá là toàn cục theo lưới, hai mảnh viewport khác nhau (trường hợp
 * cắt qua kinh tuyến ±180) tự gộp về cùng một cụm mà không cần bước merge nào.
 */
export function gridCellId(cell: GridCell): string {
  return `${cell.gridZoom}:${cell.x}:${cell.y}`;
}

/** Tâm hình học của ô — dự phòng khi không tính được toạ độ trung bình. */
export function gridCellCenter(cell: GridCell): { lat: number; lon: number } {
  const n = gridSize(cell.gridZoom);
  const lon = ((cell.x + 0.5) / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (cell.y + 0.5)) / n)));
  return { lat: (latRad * 180) / Math.PI, lon };
}
