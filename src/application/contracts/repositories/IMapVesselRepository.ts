// ============================================================================
//  APPLICATION · PORT: IMapVesselRepository — tra tàu theo VÙNG
// ----------------------------------------------------------------------------
//  Tách khỏi `ICurrentVesselRepository` có chủ ý. Kho kia trả lời "tàu X hiện
//  thế nào" (upsert + tra theo định danh); kho này trả lời "trong vùng này có
//  những tàu nào". Nhét truy vấn không gian vào interface kia sẽ biến một cổng
//  hai đường tra thành cổng mọi thứ.
//
//  ⛔ Hợp đồng này KHÔNG biết `$geoWithin`, KHÔNG biết Polygon, KHÔNG biết
//     mongoose. Nó nhận hộp bao và trả canonical.
//
//  ⚠️ Kho CHỈ lọc KHÔNG GIAN (và, nếu rẻ, cắt bớt theo mốc thời gian). Quyết
//     định "có vẽ được không" là của `MapVesselReadiness` ở tầng application —
//     kho không được sao chép luật đó.
// ============================================================================

import { BoundingBox } from "../geo/Geo";
import { ResolvedCurrentVessel } from "../../services/resolution/ResolvedCurrentVessel";

export interface MapVesselQuery {
  /**
   * Một hoặc NHIỀU hộp. Nhiều hộp là trường hợp viewport cắt qua kinh tuyến
   * ±180 — kho phải gộp kết quả và **khử trùng theo MMSI**, vì một tàu nằm sát
   * biên có thể trúng cả hai hộp.
   */
  readonly boxes: readonly BoundingBox[];
  /**
   * Trần số ỨNG VIÊN kho được đọc. Không phải trần số tàu trả về cho người
   * dùng — tầng trên còn lọc tiếp theo độ tươi rồi mới cắt.
   */
  readonly candidateLimit: number;
  /**
   * Bỏ qua tàu có mốc nguồn cũ hơn mốc này, NẾU kho lọc được rẻ.
   *
   * ⚠️ Đây chỉ là bộ lọc SƠ BỘ để giảm số ứng viên. Kết quả cuối vẫn phải qua
   * `evaluateMapReadiness`; kho không được coi đây là luật nghiệp vụ.
   */
  readonly observedSince?: Date;
  /**
   * Bỏ qua tàu có mốc nguồn ở TƯƠNG LAI xa hơn mốc này.
   *
   * Cũng chỉ là lọc sơ bộ — `evaluateMapReadiness` vẫn là quyết định cuối. Có
   * mặt ở đây để hai chế độ VESSELS/CLUSTERS lọc CÙNG một khoảng thời gian.
   */
  readonly observedBefore?: Date;
}

export interface MapVesselQueryResult {
  readonly candidates: readonly ResolvedCurrentVessel[];
  /**
   * Kho đã chạm `candidateLimit` -> ngoài kia CÒN tàu chưa đọc tới.
   * Biết được nhờ đọc `limit + 1` bản ghi, KHÔNG phải `countDocuments`: đếm
   * toàn viewport trên collection hàng trăm nghìn document là rất đắt.
   */
  readonly reachedCandidateLimit: boolean;
}

export interface IMapVesselRepository {
  /**
   * Tàu có toạ độ nằm trong (một trong) các hộp.
   *
   * ⚠️ Kho KHÔNG được trả document của mongoose ra ngoài, và KHÔNG được nạp
   * những nhóm map không dùng (particulars/voyage/danh sách ứng viên bị loại).
   */
  findInBoxes(query: MapVesselQuery): Promise<MapVesselQueryResult>;
}
