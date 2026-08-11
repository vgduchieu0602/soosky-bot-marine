// ============================================================================
//  DOMAIN · Validators: chuyển động (speed / course / heading)
// ----------------------------------------------------------------------------
//  Ngưỡng lấy theo đặc tả AIS message 1/2/3 — đây là ranh giới của DỮ LIỆU,
//  không phải của một nguồn cụ thể, nên đặt ở domain là đúng chỗ:
//    • SOG   : 0..102.2 knots   (1023 = not available)
//    • COG   : 0..359.9 độ      (3600 = not available)
//    • HDG   : 0..359 độ nguyên (511  = not available)
//
//  Các validator này CHƯA được nối vào entity/use case nào (xem
//  CANONICAL_VESSEL_MODEL.md §5) — nối vào sẽ làm rơi dữ liệu đang chạy.
// ============================================================================

/** SOG hợp lệ: 0..102.2 knots. */
export function isValidSpeed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 102.2;
}

/** COG hợp lệ: [0, 360) độ. 360 bị loại — vòng tròn đóng tại 0. */
export function isValidCourse(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 360;
}

/** True heading hợp lệ: số NGUYÊN [0, 359] độ. */
export function isValidHeading(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 359;
}
