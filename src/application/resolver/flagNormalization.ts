// ============================================================================
//  APPLICATION · Chuẩn hoá mã cờ để SO SÁNH
// ----------------------------------------------------------------------------
//  Vấn đề thật, đo được trên `vessel_observations`:
//      ShipInfo    flag.code = "LR"   (ISO-3166-1 alpha-2)  flag.name = "Liberia"
//      ShipFinder  flag.code = "LBR"  (alpha-3)             flag.name = null
//  Cùng một quốc gia, hai hệ mã. Resolver so chuỗi thô sẽ báo **xung đột giả**.
//
//  ⛔ KHÔNG viết database quốc gia đầy đủ (~250 dòng) và KHÔNG thêm dependency —
//  đó là over-engineering cho một bài toán 5 dòng dữ liệu.
//
//  ✅ Bảng dưới đây CHỈ chứa mã đã THỰC SỰ quan sát được trong dữ liệu của dự
//  án. Mỗi dòng truy được về một observation hoặc fixture cụ thể.
//
//  Mã alpha-3 KHÔNG có trong bảng -> `null` -> hai giá trị được coi là
//  **KHÔNG SO ĐƯỢC** (`INCOMPARABLE_REPRESENTATION`), *không* phải xung đột.
//  Thà nói "chưa chứng minh được bằng nhau" còn hơn đoán bừa.
//
//  ⚠️ TUYỆT ĐỐI không suy bằng tiền tố: `"CH"` là tiền tố của `"CHN"` nhưng
//  CH = Thuỵ Sĩ còn CHN = Trung Quốc. Suy tiền tố sẽ hợp nhất hai nước khác nhau.
// ============================================================================

/**
 * alpha-3 -> alpha-2, chỉ cho mã đã gặp thật.
 * Thêm dòng mới khi và chỉ khi gặp mã đó trong dữ liệu thật.
 */
const ALPHA3_TO_ALPHA2: Readonly<Record<string, string>> = Object.freeze({
  LBR: "LR", // Liberia — AGIA DOXA, MMSI 636018086 (ShipFinder vs ShipInfo "LR")
  USA: "US", // Hoa Kỳ  — MMSI 367452710 (ShipFinder vs ShipInfo "US")
  CHN: "CN", // Trung Quốc — QI XIAN LING, MMSI 414708000 (ShipFinder)
  SGP: "SG", // Singapore — fixture ShipFinder
  BGD: "BD", // Bangladesh — JAHAN BROTHERS I (ShipInfo "BD")
});

export interface NormalizedFlagCode {
  /** Mã alpha-2 nếu quy đổi được. */
  readonly code: string | null;
  /** false = mã alpha-3 lạ, chưa có trong bảng bằng chứng. */
  readonly known: boolean;
}

/**
 * Đưa mã cờ về alpha-2 để so sánh.
 * alpha-2 giữ nguyên; alpha-3 tra bảng; độ dài khác -> không nhận dạng được.
 */
export function normalizeFlagCode(raw: string | null | undefined): NormalizedFlagCode {
  if (typeof raw !== "string") return { code: null, known: false };
  const code = raw.trim().toUpperCase();

  if (code.length === 2) return { code, known: true };
  if (code.length === 3) {
    const mapped = ALPHA3_TO_ALPHA2[code];
    return mapped === undefined ? { code: null, known: false } : { code: mapped, known: true };
  }
  return { code: null, known: false };
}

/** Mã alpha-3 đã có bằng chứng — dùng cho test và cho việc rà soát bảng. */
export const KNOWN_ALPHA3_CODES: readonly string[] = Object.freeze(Object.keys(ALPHA3_TO_ALPHA2));
