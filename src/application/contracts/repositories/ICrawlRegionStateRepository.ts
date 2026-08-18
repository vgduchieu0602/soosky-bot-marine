// ============================================================================
//  APPLICATION · PORT: ICrawlRegionStateRepository
// ----------------------------------------------------------------------------
//  Trạng thái LẬP LỊCH của vùng quét. Cố ý nhỏ: đọc hết, đọc một, ghi một.
//
//  ⛔ KHÔNG dính gì tới dữ liệu tàu. Trạng thái này KHÔNG được nhét vào
//  `canonical_current_vessels` hay `vessel_observations` — đó là dữ liệu về
//  CON TÀU, còn đây là dữ liệu về CÔNG VIỆC CỦA BOT (§8).
// ============================================================================

import { RegionScheduleState } from "../../services/crawl-runtime/RegionSchedulePolicy";

export interface ICrawlRegionStateRepository {
  /** Toàn bộ trạng thái đã lưu. Vùng chưa từng quét sẽ không có ở đây. */
  findAll(): Promise<readonly RegionScheduleState[]>;
  findByRegionId(regionId: string): Promise<RegionScheduleState | null>;
  /** Ghi đè theo `regionId`. Trạng thái lập lịch là ẢNH HIỆN TẠI, không phải nhật ký. */
  save(state: RegionScheduleState): Promise<void>;
}
