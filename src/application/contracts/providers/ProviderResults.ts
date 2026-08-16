// ============================================================================
//  APPLICATION · Kiểu KẾT QUẢ của provider
// ----------------------------------------------------------------------------
//  Hợp đồng một chiều: provider nuốt HTML/binary/JSON của nguồn, nhả ra CANONICAL.
//  Không kiểu nào ở đây được mang field thô của nguồn (ship_lat, lrpd, mp2...).
//
//  Không định nghĩa lại canonical interface — chỉ GOM chúng lại. Mỗi nhóm mang
//  `metadata` riêng của nó (đã có sẵn trong canonical A1) vì một lần gọi có thể
//  lấy các nhóm ở độ tươi khác nhau.
//
//  Mọi nhóm đều OPTIONAL: nguồn cấp được gì thì trả nấy. Nhóm vắng mặt nghĩa là
//  "nguồn này không cho", KHÔNG phải "tàu không có dữ liệu đó" — đừng lấp đầy
//  bằng null để trông cho đủ bộ.
// ============================================================================

import { VesselIdentity } from "../../../domain/value-objects/VesselIdentity";
import { VesselParticulars } from "../../../domain/value-objects/VesselParticulars";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import { VesselVoyage } from "../../../domain/value-objects/VesselVoyage";

/**
 * Một ứng viên của `searchByName`. Identity bắt buộc — kết quả tìm kiếm mà
 * không nói được đó là tàu nào thì vô dụng.
 */
export interface ProviderSearchResult {
  identity: VesselIdentity;
  /** Nguồn tiện thể trả kèm vị trí thì giữ lại, không bắt buộc. */
  position?: VesselPositionReport;
}

/**
 * Một báo cáo vị trí. Dùng cho cả `getPosition` (1 tàu) lẫn `scanArea` (n tàu).
 */
export interface ProviderPositionResult {
  position: VesselPositionReport;
  /**
   * Identity đi kèm nếu nguồn trả luôn trong cùng response — VD mp2 của
   * VesselFinder cho `name` ngay trong bản ghi vị trí. Không tách ra thì mất.
   */
  identity?: VesselIdentity;
}

/**
 * Kết quả tra chi tiết. Provider chỉ điền nhóm nào nó THỰC SỰ bóc được.
 */
export interface ProviderDetailsResult {
  identity?: VesselIdentity;
  particulars?: VesselParticulars;
  voyage?: VesselVoyage;
  position?: VesselPositionReport;
}
