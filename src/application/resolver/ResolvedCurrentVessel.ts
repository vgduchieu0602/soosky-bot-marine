// ============================================================================
//  APPLICATION · ResolvedCurrentVessel — READ MODEL, chỉ nằm trong RAM
// ----------------------------------------------------------------------------
//  Ảnh hợp nhất của một con tàu tại một thời điểm, ghép từ đầu ra của BỐN
//  resolver. Đây KHÔNG phải entity, KHÔNG có collection, KHÔNG được lưu ở đâu.
//  Phase có canonical storage mới quyết định chuyện đó.
//
//  ⚠️ Tầng ghép KHÔNG được đụng vào nội dung từng nhóm:
//    • không bóc `ResolvedField` thành giá trị trần -> mất provenance
//    • không lấp field của nhóm này bằng nhóm khác
//    • không đụng `position` — nhóm đó NGUYÊN KHỐI (RESOLVER_POLICY.md §D.0)
//  Nó chỉ đặt bốn kết quả cạnh nhau và đóng dấu thời điểm.
// ============================================================================

import { ResolvedIdentity } from "./IdentityResolver";
import { ResolvedParticulars } from "./ParticularsResolver";
import { ResolvedPosition } from "./PositionResolver";
import { ResolvedVoyage } from "./VoyageResolver";

export interface ResolvedCurrentVessel {
  /**
   * Khoá dùng để tra. Giữ nguyên định danh người gọi đưa vào; chỉ BỔ SUNG `imo`
   * nếu identity phân xử được và khoá gốc chưa có. KHÔNG bao giờ thay MMSI được
   * yêu cầu bằng giá trị từ nguồn khác.
   */
  readonly vesselKey: { readonly mmsi?: string; readonly imo?: string };
  readonly identity: ResolvedIdentity | null;
  /** NGUYÊN KHỐI: mọi field đến từ đúng một observation. */
  readonly position: ResolvedPosition | null;
  readonly particulars: ResolvedParticulars | null;
  readonly voyage: ResolvedVoyage | null;
  /** Thời điểm CHẠY resolve — không phải `max(fetchedAt)` của observation. */
  readonly resolvedAt: Date;
}
