// ============================================================================
//  APPLICATION · Viewport -> hộp bao đã chuẩn hoá. HÀM THUẦN.
// ----------------------------------------------------------------------------
//  Không Mongo, không GeoJSON, không `$geoWithin`. File này chỉ trả lời hai câu:
//    1. Viewport này có hợp lệ không?
//    2. Nó phải được hỏi bằng MẤY hộp?
//
//  Câu 2 tồn tại vì đường đổi ngày quốc tế. Dựng Polygon là việc của tầng
//  persistence — xem docs/MAP_VIEWPORT_QUERY.md.
// ============================================================================

import { BoundingBox } from "../../contracts/geo/Geo";

export const MapBoundingBoxError = {
  /** Có giá trị không phải số hữu hạn (NaN / Infinity / thiếu). */
  NOT_FINITE: "NOT_FINITE",
  /** Vĩ độ ngoài [-90, 90]. */
  LAT_OUT_OF_RANGE: "LAT_OUT_OF_RANGE",
  /** Kinh độ ngoài [-180, 180]. */
  LON_OUT_OF_RANGE: "LON_OUT_OF_RANGE",
  /**
   * `minLat > maxLat`.
   *
   * ⚠️ CỐ Ý báo lỗi thay vì lặng lẽ đảo hai giá trị. Vĩ độ KHÔNG vòng quanh —
   * `minLat > maxLat` là người gọi truyền nhầm, và tự sửa hộ sẽ giấu mất cái
   * bug đó. Kinh độ thì khác, xem `crossesAntiMeridian`.
   */
  LAT_INVERTED: "LAT_INVERTED",
} as const;

export type MapBoundingBoxError =
  (typeof MapBoundingBoxError)[keyof typeof MapBoundingBoxError];

export type MapBoundingBoxResult =
  | {
      readonly ok: true;
      /** Một hộp, hoặc HAI hộp khi viewport cắt qua kinh tuyến ±180. */
      readonly boxes: readonly BoundingBox[];
      readonly crossesAntiMeridian: boolean;
    }
  | { readonly ok: false; readonly reason: MapBoundingBoxError };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Kiểm tra viewport và tách nếu cần.
 *
 * ⚠️ `minLon > maxLon` KHÔNG phải lỗi. Đó là viewport cắt qua đường đổi ngày:
 *
 *     minLon = 170, maxLon = -170   ->   [170..180] và [-180..-170]
 *
 * Ai đó "sửa" bằng cách đảo hai giá trị sẽ biến một dải rộng 20° quanh Fiji
 * thành một dải rộng 340° phủ gần hết địa cầu — và không lỗi nào được ném ra,
 * chỉ có map trả về hàng chục nghìn tàu sai. Nên phải tách thành hai hộp.
 */
export function resolveViewport(bbox: BoundingBox): MapBoundingBoxResult {
  const { minLat, minLon, maxLat, maxLon } = bbox;

  if (![minLat, minLon, maxLat, maxLon].every(isFiniteNumber)) {
    return { ok: false, reason: MapBoundingBoxError.NOT_FINITE };
  }
  if (minLat < -90 || minLat > 90 || maxLat < -90 || maxLat > 90) {
    return { ok: false, reason: MapBoundingBoxError.LAT_OUT_OF_RANGE };
  }
  if (minLon < -180 || minLon > 180 || maxLon < -180 || maxLon > 180) {
    return { ok: false, reason: MapBoundingBoxError.LON_OUT_OF_RANGE };
  }
  if (minLat > maxLat) {
    return { ok: false, reason: MapBoundingBoxError.LAT_INVERTED };
  }

  if (minLon <= maxLon) {
    return {
      ok: true,
      boxes: Object.freeze(splitWideBox({ minLat, maxLat, minLon, maxLon })),
      crossesAntiMeridian: false,
    };
  }

  return {
    ok: true,
    boxes: Object.freeze([
      ...splitWideBox({ minLat, maxLat, minLon, maxLon: 180 }),
      ...splitWideBox({ minLat, maxLat, minLon: -180, maxLon }),
    ]),
    crossesAntiMeridian: true,
  };
}

/**
 * Bề rộng kinh độ tối đa của MỘT hộp gửi xuống tầng geo.
 *
 * 🔴 Đây KHÔNG phải tối ưu — nó là điều kiện ĐÚNG/SAI.
 *
 * `$geoWithin: { $geometry: Polygon }` của MongoDB dùng quy tắc bàn tay phải để
 * biết đâu là "bên trong". Với một đa giác lớn hơn nửa mặt cầu, quy tắc đó trở
 * nên nhập nhằng và Mongo chọn vùng NHỎ HƠN — nghĩa là một viewport toàn cầu
 * trả về gần như KHÔNG CÓ GÌ, mà không lỗi nào được ném ra.
 *
 * Đo thật với 10.000 tàu rải toàn cầu: hộp `-180..180` trả về **3** tàu.
 *
 * Cắt nhỏ dưới 90° khiến mọi đa giác luôn nhỏ hơn nửa cầu, nên hướng vòng không
 * còn nhập nhằng. Cách khác là khai `crs: strictwinding` trong truy vấn, nhưng
 * thế là nhét kiến thức Mongo vào tận đây; cắt hộp thì tầng nào cũng hiểu.
 */
const MAX_LON_SPAN_DEG = 90;

/** Cắt theo kinh độ cho tới khi mỗi mảnh <= `MAX_LON_SPAN_DEG`. Hợp của các mảnh = hộp gốc. */
function splitWideBox(box: BoundingBox): BoundingBox[] {
  const span = box.maxLon - box.minLon;
  if (span <= MAX_LON_SPAN_DEG) return [box];

  const parts = Math.ceil(span / MAX_LON_SPAN_DEG);
  const step = span / parts;
  return Array.from({ length: parts }, (_, index) => ({
    minLat: box.minLat,
    maxLat: box.maxLat,
    minLon: box.minLon + index * step,
    maxLon: index === parts - 1 ? box.maxLon : box.minLon + (index + 1) * step,
  }));
}

/** Toàn cầu — tiện cho POC và test. */
export const WORLD_BOUNDING_BOX: Readonly<BoundingBox> = Object.freeze({
  minLat: -90,
  minLon: -180,
  maxLat: 90,
  maxLon: 180,
});
