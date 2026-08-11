// ============================================================================
//  DOMAIN · Validators: toạ độ
// ----------------------------------------------------------------------------
//  Logic này TRƯỚC A1 nằm private trong VesselPosition (isValidLat/isValidLon).
//  Nay tách ra để canonical model và entity cũ dùng CHUNG một nguồn sự thật —
//  entity đã được sửa để gọi vào đây, KHÔNG copy logic (yêu cầu A1 §4).
//
//  Hành vi giữ nguyên 100%: NaN/Infinity vẫn bị loại (so sánh với NaN luôn
//  false; Infinity nằm ngoài khoảng), nên BR-03 không đổi.
//
//  Đơn vị: decimal degrees, WGS84.
// ============================================================================

/** Vĩ độ hợp lệ: số hữu hạn trong [-90, 90]. */
export function isValidLatitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

/** Kinh độ hợp lệ: số hữu hạn trong [-180, 180]. */
export function isValidLongitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

/** Cặp toạ độ hợp lệ. Thiếu một trong hai -> false. */
export function isValidCoordinates(lat: unknown, lng: unknown): boolean {
  return isValidLatitude(lat) && isValidLongitude(lng);
}
