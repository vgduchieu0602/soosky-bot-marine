// ============================================================================
//  INFRASTRUCTURE · VesselFinder: ô "Navigation Status" -> mã AIS
// ----------------------------------------------------------------------------
//  Trang chi tiết chỉ hiển thị CHỮ ("Moored"), không kèm mã. Bảng tra chữ -> mã
//  là kiến thức riêng của cách nguồn này viết nhãn, nên nó thuộc về thư mục của
//  nguồn — không phải domain (đây không phải luật nghiệp vụ) và cũng không phải
//  script proof (production sẽ mù trong khi bản chẩn đoán thì thấy).
//
//  ⚠️ Mã 0 ("under way using engine") là mã HỢP LỆ. Mọi kiểm tra phải so với
//  `null`, không được dùng `value || fallback` — tàu đang chạy máy sẽ biến mất.
//
//  ⚠️ Nguồn dùng "-" cho ô trống. Đẩy "-" xuống canonical là tự nhận có dữ liệu
//  trong khi không có; những nhãn đó bị coi như VẮNG MẶT.
// ============================================================================

import { NavigationStatus } from "../../../domain/value-objects/VesselPositionReport";

/** Nhãn nghĩa là "ô trống", không phải một trạng thái hành hải. */
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "",
  "-",
  "--",
  "---",
  "n/a",
  "na",
  "unknown",
]);
//  ⚠️ "undefined" CỐ Ý không nằm trong danh sách trên: đó là nhãn của trạng thái
//  AIS 15 ("undefined" = không khai báo). Nếu một chuỗi `undefined` của
//  JavaScript rò tới đây thì nó cũng chỉ được dịch thành mã 15 — vốn nghĩa là
//  "không có trạng thái nào" — nên đánh đổi này không bịa ra thông tin.

/**
 * Nhãn VesselFinder -> mã AIS 0..15. Chỉ những nhãn ĐÃ QUAN SÁT ĐƯỢC; nhãn lạ
 * trả null chứ không đoán bừa một mã gần đúng.
 */
const NAV_TEXT_TO_CODE: Readonly<Record<string, number>> = Object.freeze({
  "under way using engine": 0,
  "under way": 0,
  "at anchor": 1,
  "not under command": 2,
  "restricted manoeuvrability": 3,
  "restricted maneuverability": 3,
  "constrained by her draught": 4,
  "constrained by draught": 4,
  moored: 5,
  aground: 6,
  "engaged in fishing": 7,
  "under way sailing": 8,
  "reserved for future use": 13,
  "ais-sart": 14,
  "ais-sart (active)": 14,
  undefined: 15,
});

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Nhãn có mang dữ liệu thật không. `"-"`, `"Unknown"`, rỗng -> false. */
export function isUsableVesselFinderNavStatusText(text: string | null | undefined): boolean {
  if (text == null) return false;
  return !PLACEHOLDERS.has(normalize(text));
}

/**
 * Mã AIS suy từ nhãn.
 * @returns null khi nhãn là placeholder hoặc không nằm trong bảng đã quan sát.
 *          Mã 0 là giá trị THẬT, không phải "không có".
 */
export function parseVesselFinderNavStatusCode(text: string | null | undefined): number | null {
  if (!isUsableVesselFinderNavStatusText(text)) return null;
  const code = NAV_TEXT_TO_CODE[normalize(text as string)];
  return code === undefined ? null : code;
}

/**
 * Nhãn thô -> nhóm trạng thái canonical.
 * @returns null khi nguồn không nói gì dùng được. Nhãn lạ nhưng CÓ nội dung vẫn
 *          được giữ lại dưới dạng chữ (code null) — mất chữ còn tệ hơn thiếu mã.
 */
export function toVesselFinderNavigationStatus(
  text: string | null | undefined
): NavigationStatus | null {
  if (!isUsableVesselFinderNavStatusText(text)) return null;
  return { code: parseVesselFinderNavStatusCode(text), text: (text as string).trim() };
}
