// ============================================================================
//  APPLICATION · PORT: ICurrentVesselRepository
// ----------------------------------------------------------------------------
//  Kho TRẠNG THÁI HIỆN TẠI đã phân xử. Khác hẳn `IVesselObservationRepository`:
//
//      observation storage   "nguồn X nói Y lúc T"        append-only
//      current storage       "ảnh hợp nhất tốt nhất hiện tại"   upsert
//
//  Lịch sử ĐÃ nằm trong `vessel_observations`. Kho này KHÔNG append bản mới mỗi
//  lần resolve — mỗi tàu đúng một bản ghi.
//
//  Cố ý NHỎ: một đường ghi, hai đường tra. Không generic Repository<T>,
//  không `findAll`, không phân trang — chưa có use case nào cần.
// ============================================================================

import { ResolvedCurrentVessel } from "../../services/resolution/ResolvedCurrentVessel";

export const CurrentVesselSaveStatus = {
  /** Chưa từng có bản ghi cho tàu này. */
  CREATED: "CREATED",
  /** Đã có, và nội dung canonical ĐỔI THẬT. */
  UPDATED: "UPDATED",
  /**
   * Đã có, nội dung canonical y hệt -> không ghi gì.
   * `resolvedAt` MỘT MÌNH không tính là đổi (xem `currentVesselContentHash`).
   */
  UNCHANGED: "UNCHANGED",
} as const;

export type CurrentVesselSaveStatus =
  (typeof CurrentVesselSaveStatus)[keyof typeof CurrentVesselSaveStatus];

export interface CurrentVesselSaveResult {
  readonly status: CurrentVesselSaveStatus;
  /** SHA-256 nội dung canonical, KHÔNG gồm `resolvedAt`. */
  readonly contentHash: string;
  /** Id bản ghi trong kho. */
  readonly id?: string;
  /** Metadata PERSISTENCE — khác `resolvedAt`/`observedAt`/`fetchedAt`. */
  readonly createdAt: Date;
  /** Giữ NGUYÊN giá trị cũ khi UNCHANGED — đó là cách kiểm idempotency. */
  readonly updatedAt: Date;
}

export interface ICurrentVesselRepository {
  /**
   * Ghi đè trạng thái hiện tại theo khoá canonical của chính `vessel.vesselKey`.
   *
   * ⚠️ KHÔNG append: gọi 10 lần vẫn đúng một document. Muốn xem lịch sử thì đọc
   * `vessel_observations`.
   */
  upsert(vessel: ResolvedCurrentVessel): Promise<CurrentVesselSaveResult>;

  findByMmsi(mmsi: string): Promise<ResolvedCurrentVessel | null>;

  findByImo(imo: string): Promise<ResolvedCurrentVessel | null>;
}
