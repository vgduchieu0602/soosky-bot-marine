// ============================================================================
//  DOMAIN · Canonical group A: Identity — "con tàu này là ai"
// ----------------------------------------------------------------------------
//  Dữ liệu gần như không đổi theo thời gian. Tách khỏi Particulars (nhóm C) vì
//  Identity đến được từ MỌI nguồn (kể cả AIS thô), còn Particulars chỉ có ở
//  nguồn tra cứu lý lịch.
//
//  Đây là INTERFACE thuần: mỗi bản ghi là "nguồn X nói gì về tàu Y", chưa phải
//  kết quả đã hợp nhất. Việc chọn giá trị nào thắng thuộc merge policy —
//  CHƯA tồn tại ở A1.
// ============================================================================

import { SourceMetadata } from "../value-objects/SourceMetadata";

/** Quốc tịch tàu. Tách code/name vì nguồn cho một trong hai, không phải cả hai. */
export interface VesselFlag {
  /** Mã ISO/AIS MID nếu nguồn cung cấp. VD "SG". */
  code?: string | null;
  /** Tên hiển thị. VD "Singapore". */
  name?: string | null;
}

export interface VesselIdentity {
  /** Khoá định danh (BR-01, giống entity hiện tại). */
  mmsi: string;
  imo?: string | null;
  name?: string | null;
  callsign?: string | null;
  /** Nhãn loại tàu dạng chữ. VD "Container Ship". */
  vesselType?: string | null;
  /** Mã loại tàu theo AIS (0–99) nếu nguồn cho. */
  vesselTypeCode?: number | null;
  flag?: VesselFlag | null;
  /** Provenance — bắt buộc: bản ghi không có nguồn thì không arbitrate được. */
  metadata: SourceMetadata;
}
