// ============================================================================
//  DOMAIN · Value Object: VesselSource — định danh NGUỒN dữ liệu
// ----------------------------------------------------------------------------
//  Trước A1: VesselPosition hardcode union "vesselfinder" | "unknown" -> thêm
//  nguồn mới phải sửa entity (xem CURRENT_ARCHITECTURE.md §6 D-3).
//
//  Ở đây giá trị được giữ đúng dạng CHỮ THƯỜNG đang nằm trong MongoDB
//  ("vesselfinder", "unknown") -> KHÔNG cần migrate dữ liệu cũ, chỉ mở rộng
//  tập giá trị hợp lệ. Đây là điều kiện backward compatibility bắt buộc.
//
//  Value object thuần: không import mongoose/express/crawler.
// ============================================================================

/**
 * Tập nguồn dữ liệu hệ thống biết tới.
 * Key = tên hằng (dùng trong code), value = chuỗi LƯU XUỐNG DB.
 */
export const VesselSource = {
  AISSTREAM: "aisstream",
  VESSELFINDER: "vesselfinder",
  SHIPINFO: "shipinfo",
  SHIPFINDER: "shipfinder",
  BOATNERD: "boatnerd",
  MARINETRAFFIC_LIVE: "marinetraffic_live",
  SHIPTRAFFIC: "shiptraffic",
  VESSELTRACKER: "vesseltracker",
  MYSHIPTRACKING: "myshiptracking",
  UNKNOWN: "unknown",
} as const;

export type VesselSource = (typeof VesselSource)[keyof typeof VesselSource];

/** Mọi giá trị hợp lệ — tiện cho vòng lặp/validate. */
export const VESSEL_SOURCES: readonly VesselSource[] = Object.values(VesselSource);

const VALUE_SET = new Set<string>(VESSEL_SOURCES);

/** Chuẩn hoá: bỏ khoảng trắng, hạ chữ thường, "-"/" " -> "_". */
function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function isVesselSource(value: unknown): value is VesselSource {
  return typeof value === "string" && VALUE_SET.has(value);
}

/**
 * Đọc giá trị từ DB / cấu hình / nguồn ngoài về VesselSource.
 * Không nhận dạng được -> UNKNOWN (không ném lỗi: dữ liệu cũ trong DB không
 * được phép làm sập tiến trình đọc).
 *
 * Chấp nhận cả dạng hằng viết hoa ("MARINETRAFFIC_LIVE") lẫn dạng lưu trong DB
 * ("marinetraffic_live", "marinetraffic-live").
 */
export function parseVesselSource(raw: unknown): VesselSource {
  if (typeof raw !== "string") return VesselSource.UNKNOWN;
  const normalized = normalize(raw);
  return isVesselSource(normalized) ? normalized : VesselSource.UNKNOWN;
}
