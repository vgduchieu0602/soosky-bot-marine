// ============================================================================
//  INFRASTRUCTURE · ShipFinder RAW DTO — phản ánh ShipFinder TRẢ GÌ
// ----------------------------------------------------------------------------
//  KHÔNG phải canonical model. Mọi giá trị giữ NGUYÊN dạng chuỗi của trang:
//    • toạ độ ở dạng độ-phút (DDM): "33-44.983 N", KHÔNG phải 33.749717
//    • đơn vị nằm TRONG giá trị:    "179 m", "10.6 kn", "0.9 °"
//    • sentinel giữ nguyên:         "Unknown" (heading), "-" (không có)
//    • mốc thời gian không có múi:  "2026-08-14 23:51:36"
//    • ETA KHÔNG có năm:            "07-29 07:01"
//    • cờ là mã 3 ký tự:            "LBR" (ShipInfo dùng 2 ký tự "LR")
//
//  Chuẩn hoá là việc của P7.3. Ranh giới:
//      SOURCE FORMAT -> RAW DTO   |   RAW DTO -> NORMALIZATION -> CANONICAL
//                    P7.2 dừng ở đây
//
//  ⚠️ Đây KHÔNG phải bản sao của ShipInfoTypes. Hai nguồn có transport khác hẳn
//  nhau (JSON nhúng vs HTML server-render) nên hai raw DTO độc lập. Không gom
//  chúng vào một kiểu chung.
//
//  Không có `grossTonnage` / `deadweight` / `builtYear`: trang công khai KHÔNG
//  cung cấp (chúng nằm sau API ký chữ ký mà audit P7.1 cố ý không đụng tới).
//  Xem docs/sources/SHIPFINDER_AUDIT.md §4.
// ============================================================================

export interface ShipFinderRawVessel {
  /** Từ `#ais-name`, dự phòng `<title>` / `og:title`. */
  name?: string | null;

  mmsi?: string | null;
  imo?: string | null;
  callsign?: string | null;

  /** Mã 3 ký tự trong câu mô tả: "sailing under the flag of LBR". */
  flag?: string | null;
  /** Nhãn chữ, thô hơn ShipInfo: "Cargo ship" chứ không phải "Bulk Carrier". */
  type?: string | null;

  /** DDM, VD "33-44.983 N". KHÔNG phải decimal degrees. */
  lat?: string | null;
  /** DDM, VD "118-12.531 W". */
  lon?: string | null;

  /** VD "0 kn" — còn nguyên đơn vị. */
  speed?: string | null;
  /** VD "0.9 °" — còn nguyên ký hiệu độ. */
  course?: string | null;
  /** VD "58.0 °", hoặc sentinel "Unknown". */
  heading?: string | null;
  /** Từ vựng AIS dạng chữ: "Moored", "Under way using engine". */
  status?: string | null;

  /** VD "2026-08-14 23:51:36" — KHÔNG có múi giờ, KHÔNG được tự gán. */
  lastUpdate?: string | null;

  /** VD "179 m". */
  length?: string | null;
  /**
   * VD "29 m". Giữ tên `width` ĐÚNG như nguồn gọi; đổi sang `beam` là việc của
   * canonical mapper ở P7.3.
   */
  width?: string | null;
  /** VD "5.9 m". */
  draught?: string | null;

  /** Chuỗi thô do thuyền viên gõ, có thể có khoảng trắng kép: "LONG BEACH,  US". */
  destination?: string | null;
  /** VD "07-29 07:01" — THIẾU NĂM. Không suy, không thêm năm hiện tại. */
  eta?: string | null;
}

export interface ShipFinderParsedDocument {
  vessel: ShipFinderRawVessel;
  /**
   * Field lấy được bằng đường dự phòng (nhãn/`<title>`) thay vì id neo.
   * Danh sách này dài ra nghĩa là trang đang trôi khỏi hợp đồng id — tín hiệu
   * sớm để xem lại parser trước khi nó hỏng hẳn.
   */
  fallbackFields: readonly string[];
}
