// ============================================================================
//  DOMAIN · Validators: định danh tàu (MMSI / IMO)
// ----------------------------------------------------------------------------
//  ⚠️ CHƯA nối vào Vessel/GetVesselDetails/ManageWatchlist. Code hiện tại nhận
//  `^\d{7,9}$` cho CẢ IMO lẫn MMSI; siết lại ngay bây giờ sẽ từ chối dữ liệu
//  đang có trong DB và đổi hành vi API. A1 chỉ chuẩn bị model.
//  Xem CANONICAL_VESSEL_MODEL.md §5.
// ============================================================================

function digitsOf(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) return null;
    return String(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * MMSI hợp lệ: đúng 9 chữ số, chữ số đầu 1–9.
 * Chữ số đầu 0 dành cho coast station / group call, không phải một con tàu.
 */
export function isValidMmsi(value: unknown): boolean {
  const digits = digitsOf(value);
  return digits !== null && digits.length === 9 && digits[0] !== "0";
}

/**
 * Chữ số kiểm tra IMO: 6 chữ số đầu nhân trọng số 7,6,5,4,3,2 rồi lấy đơn vị.
 * @returns null nếu chuỗi không phải 7 chữ số.
 */
export function imoCheckDigit(value: unknown): number | null {
  const digits = digitsOf(value);
  if (digits === null || digits.length !== 7) return null;
  let sum = 0;
  for (let i = 0; i < 6; i += 1) {
    sum += Number(digits[i]) * (7 - i);
  }
  return sum % 10;
}

/**
 * IMO hợp lệ: 7 chữ số VÀ khớp chữ số kiểm tra (ISO 8713).
 * VD 9074729 hợp lệ; 9074728 sai checksum.
 */
export function isValidImo(value: unknown): boolean {
  const digits = digitsOf(value);
  if (digits === null || digits.length !== 7) return false;
  return imoCheckDigit(digits) === Number(digits[6]);
}

/**
 * Định danh dùng làm KHOÁ CANONICAL: hợp lệ thì giữ, không hợp lệ thì `null`.
 *
 * Vì sao cần: nguồn ngoài trả những giá trị "có mặt nhưng vô nghĩa" —
 * ShipInfo gửi `imo = "0"` cho tàu không có IMO. Chuỗi đó KHÔNG rỗng nên mọi
 * kiểm tra kiểu `imo ?? null` đều cho nó đi qua, và nó trở thành định danh
 * canonical. Hậu quả thật: unique index `imo_1` coi mọi tàu "không có IMO" là
 * CÙNG một con tàu, và con thứ hai làm sập cả lượt quét vùng bằng E11000.
 *
 * Cố ý KHÔNG có danh sách sentinel ("0", "0000000", ...): quy tắc IMO/MMSI đã
 * đủ để loại chúng. Thêm danh sách đen là mở đường cho hai định nghĩa "hợp lệ"
 * sống song song rồi lệch nhau.
 */
export function normalizeImo(value: unknown): string | null {
  const digits = digitsOf(value);
  if (digits === null || !isValidImo(digits)) return null;
  // `isValidImo` là luật CHECKSUM thuần, và "0000000" thoả checksum một cách
  // hình thức (0 ≡ 0) — repo đã ghi nhận điều đó. Nhưng số IMO toàn số 0 không
  // phải một định danh được cấp cho con tàu nào; nó là cách nguồn nói "không
  // có IMO". Luật checksum giữ nguyên; đây là luật KHOÁ CANONICAL chồng lên.
  if (/^0+$/.test(digits)) return null;
  return digits;
}

/** Cùng luật với `normalizeImo`, áp cho MMSI. */
export function normalizeMmsi(value: unknown): string | null {
  const digits = digitsOf(value);
  return digits !== null && isValidMmsi(digits) ? digits : null;
}
