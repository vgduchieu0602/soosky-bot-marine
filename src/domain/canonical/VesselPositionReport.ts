// ============================================================================
//  DOMAIN · Canonical group B: Position — "tàu ở đâu, lúc nào"
// ----------------------------------------------------------------------------
//  Tên `VesselPositionReport` (không phải `VesselPosition`) là CỐ Ý: entity
//  `VesselPosition` hiện tại vẫn đang chạy production, hai thứ song song tồn
//  tại trong A1 và không được nhầm lẫn.
//
//  Khác biệt so với entity cũ:
//    • lng thay cho lon                (đặt tên theo canonical spec)
//    • receivedAt là Date, không phải chuỗi ISO
//    • navStatus gom code + text về một value object
//    • speed/course/heading bỏ hậu tố đơn vị trong tên; đơn vị ghi ở comment
//      và CANONICAL_VESSEL_MODEL.md §4
//
//  Đơn vị: lat/lng decimal degrees · speed knots · course/heading degrees.
// ============================================================================

import { SourceMetadata } from "../value-objects/SourceMetadata";

/** Trạng thái hành hải. Nguồn có thể cho mã, cho chữ, hoặc cả hai. */
export interface NavigationStatus {
  /** Mã AIS 0–15. */
  code?: number | null;
  /** Chữ đã hiển thị được. VD "Under way using engine". */
  text?: string | null;
}

export interface VesselPositionReport {
  mmsi: string;
  imo?: string | null;
  /** Vĩ độ, decimal degrees. Bắt buộc — báo cáo vị trí không toạ độ là vô nghĩa. */
  lat: number;
  /** Kinh độ, decimal degrees. */
  lng: number;
  /** SOG, knots. */
  speed?: number | null;
  /** COG, degrees [0,360). */
  course?: number | null;
  /** True heading, degrees [0,359]. */
  heading?: number | null;
  navStatus?: NavigationStatus | null;
  /**
   * Nguồn trả toạ độ đã làm tròn (VD trang chi tiết VesselFinder chưa đăng
   * nhập, sai số ~111km). Giữ lại từ `latLonApproximate` của entity cũ vì đây
   * là đầu vào bắt buộc cho arbitration sau này.
   */
  latLngApproximate?: boolean;
  /** Thời điểm bản ghi được ghi nhận (UTC Date, không phải chuỗi ISO). */
  receivedAt: Date;
  metadata: SourceMetadata;
}
