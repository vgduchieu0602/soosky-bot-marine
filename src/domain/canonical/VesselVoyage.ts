// ============================================================================
//  DOMAIN · Canonical group D: Voyage — chuyến đi & lịch cảng
// ----------------------------------------------------------------------------
//  Nhóm rỗng nhất ở thời điểm A1: crawler hiện tại KHÔNG ghi destination/eta
//  (mapper không bóc), và hoàn toàn không có khái niệm cảng
//  (xem CURRENT_DATA_FLOW.md §2.3). Khai báo trước để nguồn sau đổ vào mà
//  không phải sửa lại domain.
//
//  Mọi mốc thời gian là Date UTC. `destination` giữ nguyên chuỗi thô của nguồn
//  (AIS destination do thuyền viên gõ tay, không chuẩn hoá được ở tầng domain).
// ============================================================================

import { SourceMetadata } from "../value-objects/SourceMetadata";

export interface VesselVoyage {
  mmsi: string;
  imo?: string | null;
  /** Cảng đích do tàu khai báo, chuỗi thô. */
  destination?: string | null;
  /** ETA tới `destination`. */
  eta?: Date | null;

  /** Cảng tàu đang nằm trong (nếu nguồn xác định được). */
  currentPort?: string | null;
  currentPortArrivalAt?: Date | null;

  nextPort?: string | null;
  nextPortEta?: Date | null;

  lastPort?: string | null;
  lastPortDepartureAt?: Date | null;

  metadata: SourceMetadata;
}
