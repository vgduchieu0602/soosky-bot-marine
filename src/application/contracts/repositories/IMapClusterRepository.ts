// ============================================================================
//  APPLICATION · PORT: IMapClusterRepository — đếm tàu theo ô lưới
// ----------------------------------------------------------------------------
//  Tách khỏi `IMapVesselRepository`: kho kia trả DANH SÁCH tàu, kho này trả
//  CON SỐ theo ô. Hai hình dạng kết quả khác hẳn nhau, và người dùng chế độ
//  VESSELS không cần biết gì về lưới.
//
//  ⛔ Không biết `$geoWithin`, không biết pipeline, không biết mongoose.
//
//  ⚠️ Kho CHỈ đếm tàu ĐỦ ĐIỀU KIỆN VẼ. Bộ lọc độ tươi phải được áp NGAY trong
//     truy vấn — không thể đếm trước rồi lọc sau, vì cụm chỉ trả về con số chứ
//     không trả về danh sách tàu để lọc.
// ============================================================================

import { BoundingBox } from "../geo/Geo";

export interface MapClusterQuery {
  /** Một hoặc nhiều hộp (cắt qua ±180, hoặc hộp quá rộng đã bị chia nhỏ). */
  readonly boxes: readonly BoundingBox[];
  /**
   * Mức lưới gộp. Ô được xác định TOÀN CỤC theo mức này, nên hai mảnh viewport
   * khác nhau tự gộp về cùng một cụm — không cần bước merge nào ở tầng trên.
   */
  readonly gridZoom: number;
  /**
   * Bỏ qua tàu có mốc nguồn cũ hơn mốc này.
   *
   * ⚠️ BẮT BUỘC ở đây (khác `IMapVesselRepository` nơi nó chỉ là lọc sơ bộ):
   * cụm trả về con số, nên không còn cơ hội lọc lại ở tầng trên.
   */
  readonly observedSince: Date;
  /**
   * Bỏ qua tàu có mốc nguồn Ở TƯƠNG LAI xa hơn mốc này.
   *
   * ⚠️ Cận TRÊN cũng bắt buộc, ngang cận dưới. `MapVesselReadiness` đã loại mốc
   * tương lai từ MAP-1, nhưng chế độ cụm không đi qua nó — chỉ có `$gte` thì
   * một mốc hỏng ở tương lai sẽ **luôn** lọt vào mọi cụm, vĩnh viễn, và hai chế
   * độ VESSELS/CLUSTERS nói hai điều khác nhau về cùng một con tàu.
   */
  readonly observedBefore: Date;
  /** Trần số cụm đọc về. Kho đọc dư 1 để biết còn nữa hay không. */
  readonly limit: number;
}

export interface MapClusterRow {
  readonly gridZoom: number;
  readonly x: number;
  readonly y: number;
  /** Số tàu ĐỦ ĐIỀU KIỆN VẼ trong ô. Một tàu đếm đúng một lần. */
  readonly count: number;
  /** Toạ độ TRUNG BÌNH của các tàu trong ô — không phải tâm hình học. */
  readonly avgLat: number;
  readonly avgLon: number;
  /** Số tàu đang chạy (SOG trên ngưỡng). Dùng để tô màu cụm. */
  readonly movingCount: number;
}

export interface MapClusterQueryResult {
  readonly rows: readonly MapClusterRow[];
  /** Kho chạm trần -> còn cụm chưa đọc tới. Biết nhờ đọc `limit + 1`. */
  readonly reachedLimit: boolean;
}

export interface IMapClusterRepository {
  aggregateClusters(query: MapClusterQuery): Promise<MapClusterQueryResult>;
}
