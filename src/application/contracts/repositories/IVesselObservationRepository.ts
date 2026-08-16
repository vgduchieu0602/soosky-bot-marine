// ============================================================================
//  APPLICATION · PORT: IVesselObservationRepository
// ----------------------------------------------------------------------------
//  Kho append-only cho lời khai của các nguồn. Cố ý NHỎ: chỉ ghi và vài kiểu
//  đọc thật sự cần cho resolver sau này. Không generic Repository<T>.
//
//  KHÔNG có `update`: observation là bất biến. Nguồn nói khác đi -> bản ghi mới.
// ============================================================================

import {
  VesselObservationKey,
  VesselObservationType,
  VesselSourceObservation,
} from "../../../domain/entities/VesselObservation";
import { VesselSource } from "../../../domain/enums/VesselSource";

export const ObservationSaveStatus = {
  SAVED: "SAVED",
  /** Vân tay trùng trong cửa sổ dedupe -> không ghi thêm. */
  SKIPPED_DUPLICATE: "SKIPPED_DUPLICATE",
} as const;

export type ObservationSaveStatus =
  (typeof ObservationSaveStatus)[keyof typeof ObservationSaveStatus];

export interface ObservationSaveResult {
  readonly status: ObservationSaveStatus;
  readonly fingerprint: string;
  /** Id bản ghi mới. Bị bỏ qua -> undefined. */
  readonly id?: string;
}

export interface ObservationQueryOptions {
  readonly limit?: number;
  readonly type?: VesselObservationType;
  /** Chỉ lấy bản ghi có fetchedAt >= mốc này. */
  readonly since?: Date;
  /**
   * Mặc định **false**: truy vấn phục vụ dữ liệu dùng được thì KHÔNG kéo theo
   * bản ghi INVALID. Chỉ bật khi đang debug parser.
   */
  readonly includeInvalid?: boolean;
}

export interface IVesselObservationRepository {
  /** Ghi một observation, tôn trọng cửa sổ dedupe. */
  save(observation: VesselSourceObservation): Promise<ObservationSaveResult>;
  /** Ghi nhiều. Trả kết quả THEO ĐÚNG THỨ TỰ đầu vào. */
  saveMany(
    observations: readonly VesselSourceObservation[]
  ): Promise<readonly ObservationSaveResult[]>;
  /** Mới nhất trước. Khoá khớp theo mmsi HOẶC imo. */
  findRecentByVessel(
    key: VesselObservationKey,
    options?: ObservationQueryOptions
  ): Promise<readonly VesselSourceObservation[]>;
  /** Mới nhất trước, dùng để soi một nguồn. */
  findRecentBySource(
    source: VesselSource,
    options?: ObservationQueryOptions
  ): Promise<readonly VesselSourceObservation[]>;
  /**
   * Bản ghi mới nhất của một tàu cho MỘT nhóm.
   * ⚠️ Có thể đến từ BẤT KỲ nguồn nào — hàm này KHÔNG phân xử nguồn nào đúng.
   * Muốn theo nguồn cụ thể thì lọc từ `findRecentByVessel`.
   *
   * ⛔ KHÔNG dùng cho resolver: nó trả về ĐÚNG MỘT bản ghi, nên mọi nguồn khác
   * biến mất. VD với PARTICULARS của MMSI 636018086 nó trả ShipFinder
   * (`length=179, builtYear=null`) và nuốt mất `builtYear=2010` của ShipInfo.
   * Resolver phải dùng `findLatestPerSourceByVesselAndType`.
   */
  findLatestByVesselAndType(
    key: VesselObservationKey,
    type: VesselObservationType,
    options?: ObservationQueryOptions
  ): Promise<VesselSourceObservation | null>;

  /**
   * Bản ghi MỚI NHẤT của **MỖI NGUỒN** cho một (tàu, nhóm) — đầu vào của resolver.
   *
   * Khác `findLatestByVesselAndType` ở chỗ quyết định: trả **tối đa một bản ghi
   * cho mỗi nguồn**, nên số kết quả bị chặn bởi SỐ NGUỒN chứ không bởi một
   * `limit` tuỳ tiện. Một nguồn crawl dày không thể đẩy nguồn khác ra khỏi cửa
   * sổ — đó chính là lỗi mà `findRecentByVessel(..., {limit})` mắc phải.
   *
   * "Mới nhất" đo bằng `fetchedAt` (giống mọi truy vấn khác của kho này).
   * Việc so **độ tươi của NGUỒN** (`sourceReceivedAt`) là của resolver, không
   * phải của kho — xem RESOLVER_POLICY.md §D.2.
   *
   * Thứ tự trả về SẮP THEO TÊN NGUỒN để kết quả tất định, không phụ thuộc thứ
   * tự đọc từ DB.
   */
  findLatestPerSourceByVesselAndType(
    key: VesselObservationKey,
    type: VesselObservationType,
    options?: ObservationQueryOptions
  ): Promise<readonly VesselSourceObservation[]>;
}
