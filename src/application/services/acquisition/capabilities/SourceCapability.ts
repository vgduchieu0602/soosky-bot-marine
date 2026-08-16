// ============================================================================
//  APPLICATION · Source capability — MÔ TẢ khả năng của một nguồn
// ----------------------------------------------------------------------------
//  Đây là METADATA CẤU HÌNH, không phải implementation. Một entry ở đây nói
//  "nguồn X về lý thuyết cấp được field Y" — nó KHÔNG tự gọi mạng, không tạo
//  adapter, không quyết định fallback. Xem SOURCE_CAPABILITY_MATRIX.md §9.
//
//  Đặt ở application (không phải domain) vì "nguồn nào tốn tiền", "nguồn nào
//  đã bật" là quyết định vận hành, không phải luật nghiệp vụ của con tàu.
//  Nhưng vẫn thuần: không import mongoose/express/http/crawler.
// ============================================================================

import { VesselField, VESSEL_FIELDS } from "../../../../domain/enums/VesselField";
import { VesselSource } from "../../../../domain/enums/VesselSource";

/**
 * Mức chắc chắn của một (nguồn, field).
 *
 *  CONFIRMED   — có bằng chứng: code trong repo đã bóc được field này, HOẶC
 *                đặc tả/tài liệu nguồn mà dự án đã xác nhận.
 *  CANDIDATE   — nguồn CÓ THỂ cấp được nhưng dự án CHƯA audit/POC.
 *  UNSUPPORTED — nguồn không phù hợp hoặc có bằng chứng không cấp field này.
 *
 * ⚠️ Không được tự nâng CANDIDATE -> CONFIRMED. Chỉ nâng sau khi audit/POC
 *    thật, kèm cập nhật SOURCE_CAPABILITY_MATRIX.md.
 */
export const FieldSupportStatus = {
  CONFIRMED: "CONFIRMED",
  CANDIDATE: "CANDIDATE",
  UNSUPPORTED: "UNSUPPORTED",
} as const;

export type FieldSupportStatus = (typeof FieldSupportStatus)[keyof typeof FieldSupportStatus];

/**
 * Chi phí sử dụng nguồn.
 *  EXISTING_STREAM — hạ tầng dự án đã trả tiền/đã vận hành sẵn.
 *  FREE            — crawl công khai, chi phí = rủi ro bị chặn.
 *  PAID            — tính tiền theo request -> luôn là fallback CUỐI.
 */
export const SourceCostType = {
  EXISTING_STREAM: "EXISTING_STREAM",
  FREE: "FREE",
  PAID: "PAID",
} as const;

export type SourceCostType = (typeof SourceCostType)[keyof typeof SourceCostType];

/** Nguồn làm được thao tác gì. Dùng để chọn nguồn theo NHU CẦU, không theo tên. */
export interface SourceOperations {
  searchByName: boolean;
  searchByMmsi: boolean;
  searchByImo: boolean;
  /** Vị trí của MỘT tàu đã biết id. */
  position: boolean;
  /** Lý lịch/kích thước. */
  particulars: boolean;
  /** Chuyến đi, cảng. */
  voyage: boolean;
  /** Quét cả vùng (bbox) trong 1 request. */
  areaScan: boolean;
}

export interface SourceCapability {
  source: VesselSource;
  operations: Readonly<SourceOperations>;
  fields: Readonly<Record<VesselField, FieldSupportStatus>>;
  costType: SourceCostType;
  /** Nguồn đã được phép dùng trong bot ở phase hiện tại chưa. */
  enabled: boolean;
  /**
   * Số nhỏ = ưu tiên cao. CHỈ là số thứ tự mặc định để phase sau sắp xếp —
   * không phải scoring engine, không có trọng số, không tự học.
   * Quy ước: EXISTING_STREAM < FREE < PAID.
   */
  defaultPriority: number;
  notes?: readonly string[];
}

/**
 * Điền đủ 28 field: mặc định `fallback`, rồi ghi đè bằng `overrides`.
 * Nhờ vậy mỗi nguồn chỉ khai những field đáng nói, mà matrix vẫn KHÔNG BAO GIỜ
 * thiếu key — thiếu key nghĩa là "quên", không phải "không hỗ trợ".
 */
export function buildFieldSupport(
  fallback: FieldSupportStatus,
  overrides: Partial<Record<VesselField, FieldSupportStatus>> = {}
): Readonly<Record<VesselField, FieldSupportStatus>> {
  const out = {} as Record<VesselField, FieldSupportStatus>;
  for (const field of VESSEL_FIELDS) {
    out[field] = overrides[field] ?? fallback;
  }
  return Object.freeze(out);
}

/**
 * Dựng 1 entry đã ĐÓNG BĂNG. Matrix là cấu hình -> runtime không được sửa.
 */
export function defineSourceCapability(capability: SourceCapability): Readonly<SourceCapability> {
  return Object.freeze({
    ...capability,
    operations: Object.freeze({ ...capability.operations }),
    fields: Object.freeze({ ...capability.fields }),
    notes: capability.notes ? Object.freeze([...capability.notes]) : undefined,
  });
}
