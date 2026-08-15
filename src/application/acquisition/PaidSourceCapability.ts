// ============================================================================
//  APPLICATION · Giá trị của từng field khi phải TRẢ TIỀN
// ----------------------------------------------------------------------------
//  ⚠️ Bảng này KHÔNG thay `SOURCE_CAPABILITY_MATRIX`. Hai bảng trả lời hai câu
//  khác nhau:
//
//      matrix                 "nguồn có cấp được field này không"
//      bảng này               "có ĐÁNG trả tiền cho field này không"
//
//  Trong matrix, MyShipTracking vẫn là 28 CANDIDATE và PHẢI giữ nguyên như vậy:
//  quy trình nâng CONFIRMED đòi POC trên dữ liệu thật, còn P9.5 mới chỉ đọc tài
//  liệu (SOURCE_CAPABILITY_MATRIX.md §10). Đọc tài liệu rồi tin là đúng thứ quy
//  trình đó tồn tại để ngăn.
//
//  Bảng này là kết quả AUDIT TÀI LIỆU — đủ để một cổng quyết định "có nên tiêu
//  tiền không", KHÔNG đủ để tin rằng dữ liệu sẽ về đúng như mong đợi.
//
//  Bằng chứng từng dòng: docs/sources/MYSHIPTRACKING_AUDIT.md §E.
// ============================================================================

import { VesselField, VESSEL_FIELDS } from "../../domain/value-objects/VesselField";

export const PaidFieldValue = {
  /**
   * Không nguồn free nào giải được, VÀ thiếu nó thì nhu cầu chính thất bại.
   * Hiện chỉ nhóm vị trí: đó là lý do gần như duy nhất đáng tiêu tiền.
   */
  CRITICAL: "CRITICAL",
  /**
   * Không nguồn free nào CONFIRMED, nhưng thiếu nó không chặn nhu cầu nào —
   * mua thì tốt, không mua cũng không hỏng gì.
   */
  USEFUL: "USEFUL",
  /**
   * Nguồn free ĐÃ cấp được. Trả tiền cho nó là mua lại thứ đang có miễn phí.
   * ⛔ Một mình nhóm này KHÔNG BAO GIỜ mở cổng trả tiền.
   */
  ENRICHMENT_ONLY: "ENRICHMENT_ONLY",
  /** Nguồn trả tiền cũng không có. Gọi là đốt quota chắc chắn vô ích. */
  UNSUPPORTED: "UNSUPPORTED",
} as const;

export type PaidFieldValue = (typeof PaidFieldValue)[keyof typeof PaidFieldValue];

const { CRITICAL, USEFUL, ENRICHMENT_ONLY, UNSUPPORTED } = PaidFieldValue;

/**
 * MyShipTracking `GET /api/v2/vessel` (simple = 1 credit · extended = 3 credit).
 *
 * Phân loại theo §7 của spec: dựa vào nguồn free HIỆN CÓ đã cấp được gì, không
 * dựa vào việc API có field đó hay không. Một field API có mà free cũng có thì
 * giá trị trả tiền của nó bằng không.
 */
const MYSHIPTRACKING_OVERRIDES: Partial<Record<VesselField, PaidFieldValue>> = {
  // --- Vị trí: lý do đáng tiền duy nhất -------------------------------------
  // Free có ShipFinder (tươi theo phút) nhưng nó chỉ tra được bằng MMSI và có
  // thể NOT_FOUND/cooldown. Khi đó đây là đường cuối cùng còn lại.
  [VesselField.LAT]: CRITICAL,
  [VesselField.LNG]: CRITICAL,
  [VesselField.SPEED]: CRITICAL,
  [VesselField.COURSE]: CRITICAL,
  [VesselField.NAV_STATUS]: CRITICAL,
  // `received` — ISO-8601 UTC, ngữ nghĩa nguồn khai rõ. Hơn hẳn ShipFinder
  // (phải GIẢ ĐỊNH múi giờ UTC+8 vì nguồn không khai).
  [VesselField.POSITION_RECEIVED_AT]: CRITICAL,

  // ⚠️ PHÁT HIỆN QUAN TRỌNG: response KHÔNG có `heading`, cả simple lẫn
  // extended. Nguồn TRẢ TIỀN thua nguồn MIỄN PHÍ ở đúng field này —
  // ShipFinder CONFIRMED `heading`. Không có gì để mua.
  [VesselField.HEADING]: UNSUPPORTED,

  // --- Thứ không nguồn free nào có -----------------------------------------
  // `gt` — 0/3 nguồn free CONFIRMED. Ứng viên trả tiền hợp lệ duy nhất trong
  // nhóm particulars.
  [VesselField.GROSS_TONNAGE]: USEFUL,
  // `eta` datetime UTC — CÓ NĂM. ShipFinder cho "07-29 07:01" thiếu năm nên
  // mapper cố ý không map; đây là thứ free thật sự không cấp được.
  [VesselField.ETA]: USEFUL,
  [VesselField.CURRENT_PORT]: USEFUL,
  [VesselField.NEXT_PORT]: USEFUL,
  [VesselField.LAST_PORT]: USEFUL,
  [VesselField.CURRENT_PORT_ARRIVAL_AT]: USEFUL,
  [VesselField.NEXT_PORT_ETA]: USEFUL,
  [VesselField.LAST_PORT_DEPARTURE_AT]: USEFUL,

  // --- Free đã có: mua lại là lãng phí --------------------------------------
  [VesselField.MMSI]: ENRICHMENT_ONLY,
  [VesselField.IMO]: ENRICHMENT_ONLY,
  [VesselField.NAME]: ENRICHMENT_ONLY,
  [VesselField.CALLSIGN]: ENRICHMENT_ONLY,
  [VesselField.FLAG]: ENRICHMENT_ONLY,
  [VesselField.VESSEL_TYPE]: ENRICHMENT_ONLY,
  [VesselField.DESTINATION]: ENRICHMENT_ONLY,
  [VesselField.DRAUGHT]: ENRICHMENT_ONLY,
  [VesselField.BUILT_YEAR]: ENRICHMENT_ONLY,
  [VesselField.DEADWEIGHT]: ENRICHMENT_ONLY,
  // ⚠️ API KHÔNG trả `length`/`beam` trực tiếp — chỉ `size_a..size_d` (khoảng
  // cách từ ăng-ten AIS tới mũi/lái/mạn trái/mạn phải). Suy ra được bằng công
  // thức AIS chuẩn (a+b, c+d) nhưng đó là PHÉP SUY, chưa POC. Free đã CONFIRMED
  // cả hai nên không cần mạo hiểm.
  [VesselField.LENGTH]: ENRICHMENT_ONLY,
  [VesselField.BEAM]: ENRICHMENT_ONLY,
  // `ais_type`/`vtype` có, nhưng ánh xạ sang mã canonical CHƯA audit.
  [VesselField.VESSEL_TYPE_CODE]: ENRICHMENT_ONLY,
};

/**
 * Mặc định `UNSUPPORTED`: field không được audit khai tường minh thì coi như
 * không mua được. Bảng thiếu key nghĩa là "chưa xét", và "chưa xét" không được
 * phép trở thành "cứ gọi thử xem".
 */
export const MYSHIPTRACKING_FIELD_VALUE: Readonly<Record<VesselField, PaidFieldValue>> =
  Object.freeze(
    VESSEL_FIELDS.reduce((table, field) => {
      table[field] = MYSHIPTRACKING_OVERRIDES[field] ?? UNSUPPORTED;
      return table;
    }, {} as Record<VesselField, PaidFieldValue>)
  );

export function paidFieldValue(field: VesselField): PaidFieldValue {
  return MYSHIPTRACKING_FIELD_VALUE[field];
}

/** Đáng tiêu tiền = `CRITICAL` hoặc `USEFUL`. Xem §L của ACQUISITION_POLICY. */
export function isWorthPaying(value: PaidFieldValue): boolean {
  return value === CRITICAL || value === USEFUL;
}
