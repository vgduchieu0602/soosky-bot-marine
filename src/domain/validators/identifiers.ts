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
