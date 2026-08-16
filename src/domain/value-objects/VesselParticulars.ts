// ============================================================================
//  DOMAIN · Canonical group C: Particulars — kích thước & thông số kỹ thuật
// ----------------------------------------------------------------------------
//  Tách khỏi Identity vì chỉ nguồn tra cứu lý lịch mới có; nguồn AIS vị trí
//  không bao giờ cung cấp.
//
//  ⚠️ `draught` đổi theo chuyến (mớn nước hiện tại), khác hẳn length/beam là
//  hằng số của con tàu. Giữ chung nhóm để khớp canonical spec, nhưng merge
//  policy sau này phải xử lý nó theo độ tươi, không coi là dữ liệu tĩnh.
//
//  Đơn vị: length/beam/draught mét · grossTonnage/deadweight tấn · builtYear năm.
// ============================================================================

import { SourceMetadata } from "./SourceMetadata";

export interface VesselParticulars {
  mmsi: string;
  imo?: string | null;
  /** GT — không thứ nguyên theo công ước, giữ dạng số. */
  grossTonnage?: number | null;
  /** DWT, tấn. */
  deadweight?: number | null;
  builtYear?: number | null;
  /** LOA, mét. */
  length?: number | null;
  /** Chiều rộng, mét. */
  beam?: number | null;
  /** Mớn nước hiện tại, mét. */
  draught?: number | null;
  metadata: SourceMetadata;
}
