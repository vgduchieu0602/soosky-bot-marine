// ============================================================================
//  INFRASTRUCTURE · ShipInfo RAW DTO — phản ánh ShipInfo TRẢ GÌ
// ----------------------------------------------------------------------------
//  Đây KHÔNG phải canonical model. Tên field, kiểu dữ liệu, cả những chỗ khó
//  chịu đều giữ NGUYÊN như nguồn:
//    • mọi số đều là CHUỖI  ("speed":"12", "lat":"33.74968")
//    • `type` có "\n" ở cuối ("Bulk Carrier\n")
//    • `course` có sentinel "-1" nghĩa là không rõ
//    • `length`/`width` bị ĐẢO ở một số tàu (xem cảnh báo dưới)
//
//  Chuẩn hoá là việc của canonical mapper ở P6.3. Ranh giới:
//      SOURCE FORMAT -> RAW DTO   |   RAW DTO -> NORMALIZATION -> CANONICAL
//                    P6.2 dừng ở đây
//
//  Mọi field đều optional: bằng chứng P6.1 cho thấy tàu nào cũng thiếu một vài
//  thứ khác nhau (callsign 4/5, flag 3/5, year 2/5, dwt 1/5).
//  Xem docs/sources/SHIPINFO_AUDIT.md §4.
// ============================================================================

/**
 * Khối `fresh_access` — ShipInfo tự khai độ trễ của bản miễn phí.
 * P6.1: `position_delay_hours = 14`, `fresh_locked = true` trên 5/5 tàu. Vị trí
 * mới TỒN TẠI nhưng không nằm trong HTML. Giữ nguyên để tầng trên biết dữ liệu
 * cũ tới mức nào.
 */
export interface ShipInfoRawFreshAccess {
  has_fresh_position?: boolean | null;
  /** Mốc của vị trí bị khoá. Cùng hệ giờ với `points[].updated` (UTC+2). */
  fresh_position_time?: string | null;
  fresh_locked?: boolean | null;
  fresh_age_minutes?: number | null;
  position_delay_hours?: number | null;
  access_mode?: string | null;
}

/**
 * Một điểm trong `points[]`. Đúng 14 khoá quan sát được ở P6.1.
 *
 * ⚠️ `heading`, `draught`, `destination`, `eta`, `zone`, `order` tồn tại nhưng
 * LUÔN null — 0/1073 điểm có giá trị. Khai báo ở đây để giữ đúng hình dạng
 * nguồn, KHÔNG phải vì chúng dùng được.
 */
export interface ShipInfoRawPoint {
  /** Mốc của NGUỒN. Chuỗi trần "YYYY-MM-DD HH:mm:ss", KHÔNG mang offset. */
  updated?: string | null;
  /** Lúc DB của ShipInfo ghi bản ghi. Đồng hồ nội bộ của họ. */
  inserted?: string | null;
  lat?: string | null;
  lng?: string | null;
  /** Knots, dạng chuỗi. */
  speed?: string | null;
  /** Độ, dạng chuỗi. Sentinel "-1" = không rõ — GIỮ NGUYÊN ở tầng raw. */
  course?: string | null;
  heading?: string | null;
  draught?: string | null;
  destination?: string | null;
  eta?: string | null;
  zone?: string | null;
  order?: string | null;
  /** Quan sát được: luôn "free". */
  provider?: string | null;
  /** Quan sát được: luôn chuỗi rỗng. */
  src?: string | null;
}

/**
 * Một tàu trong `var IMOs = {...}`.
 *
 * ⚠️ `length` / `width` KHÔNG đáng tin. P6.1 đo được:
 *      Agia Doxa        length=179 width=29   -> đúng
 *      Qi Xian Ling     length=29  width=180  -> ĐẢO
 *   Không nhất quán, sai từ database. Raw DTO giữ NGUYÊN tên field của nguồn;
 *   TUYỆT ĐỐI không tự hoán đổi ở đây. Quyết định map (hoặc bỏ) là của P6.3.
 */
export interface ShipInfoRawVessel {
  id?: string | null;
  imo?: string | null;
  mmsi?: string | null;
  name?: string | null;
  callsign?: string | null;
  /** Nhãn chữ, thường kèm "\n" ở cuối. */
  type?: string | null;
  /** Mã cờ 2 ký tự ("LR", "US", "BD"). ShipInfo cho cả mã LẪN tên. */
  flag?: string | null;
  /** Tên nước ("Liberia", "USA"). */
  country?: string | null;
  /** ⚠️ Xem cảnh báo trên. */
  length?: string | null;
  /** ⚠️ Xem cảnh báo trên. */
  width?: string | null;
  year?: string | null;
  dwt?: string | null;
  text?: string | null;
  notes?: string | null;
  image?: string | null;
  first?: number | null;
  fresh_access?: ShipInfoRawFreshAccess | null;
  points?: ShipInfoRawPoint[] | null;
}

/**
 * Khối `var vesselSeoContext = {...}`.
 * Giá trị RIÊNG của khối này: `updated_utc` là mốc DUY NHẤT trên trang được
 * khai rõ là UTC. So với `points[cuối].updated` sẽ suy ra được offset thật của
 * nguồn (P6.1 đo +2h). P6.2 KHÔNG tự đổi múi giờ.
 */
export interface ShipInfoSeoContext {
  name?: string | null;
  geo_label?: string | null;
  /** Chuỗi người đọc, VD "about 14h ago". Không parse được thành mốc. */
  last_seen?: string | null;
  updated_utc?: string | null;
  type?: string | null;
  imo?: string | null;
  /** Có thể là số 0 khi nguồn không biết MMSI (quan sát ở LADY K II). */
  mmsi?: string | number | null;
  /** ⚠️ Lặp lại đúng giá trị đảo của `IMOs.length`/`IMOs.width`. */
  length_m?: string | null;
  width_m?: string | null;
}

/** Bản đồ khoá -> tàu của `var IMOs`. Khoá là IMO, hoặc MMSI khi tra bằng `IMO-0`. */
export type ShipInfoRawVesselMap = Record<string, ShipInfoRawVessel>;

export interface ShipInfoParsedDocument {
  /**
   * Khoá trong `IMOs`. Tra bằng IMO -> khoá là IMO; tra bằng MMSI -> khoá là
   * MMSI. Không phải lúc nào cũng bằng `vessel.imo`.
   */
  vesselKey: string;
  vessel: ShipInfoRawVessel;
  seoContext?: ShipInfoSeoContext;
  /** Trang chi tiết chỉ có 1 tàu. Khác 0 nghĩa là đang đọc nhầm trang bản đồ. */
  otherVesselKeys: readonly string[];
}
