// ============================================================================
//  APPLICATION · USE CASE: ResolveAndStoreCurrentVessel
// ----------------------------------------------------------------------------
//      VesselObservationKey
//        -> ResolveCurrentVessel        (đọc vessel_observations, phân xử)
//        -> ICurrentVesselRepository    (upsert canonical_current_vessels)
//
//  ⛔ KHÔNG gọi provider, KHÔNG mạng, KHÔNG crawl. Use case này chỉ phân xử
//  DỮ LIỆU ĐANG CÓ. Muốn có observation mới thì chạy CollectVesselObservations
//  (P6.4/P7.4) — hai việc tách hẳn nhau có chủ ý: crawl hỏng không được kéo
//  theo canonical hỏng, và resolve lại không được sinh thêm request lên nguồn.
//
//  Đầu vào KHÔNG có `source`: resolver dùng TẤT CẢ nguồn đang có.
// ============================================================================

import {
  CurrentVesselSaveStatus,
  ICurrentVesselRepository,
} from "../contracts/repositories/ICurrentVesselRepository";
import { ResolvedCurrentVessel } from "../services/resolution/ResolvedCurrentVessel";
import { VesselObservationKey } from "../../domain/entities/VesselObservation";
import { ResolveCurrentVessel } from "./ResolveCurrentVessel";

export const ResolveAndStoreStatus = {
  /** Không nhóm nào phân xử được gì -> KHÔNG ghi, không tạo bản rỗng. */
  NO_DATA: "NO_DATA",
  CREATED: "CREATED",
  UPDATED: "UPDATED",
  UNCHANGED: "UNCHANGED",
} as const;

export type ResolveAndStoreStatus =
  (typeof ResolveAndStoreStatus)[keyof typeof ResolveAndStoreStatus];

export interface ResolveAndStoreResult {
  readonly status: ResolveAndStoreStatus;
  /** `null` khi NO_DATA. */
  readonly vessel: ResolvedCurrentVessel | null;
  readonly contentHash?: string;
  readonly id?: string;
  /** Metadata persistence của bản ghi. Vắng mặt khi NO_DATA. */
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface ResolveAndStoreCurrentVesselDeps {
  resolve: ResolveCurrentVessel;
  repository: ICurrentVesselRepository;
}

/** Mã của kho và mã của use case trùng chữ, nhưng là hai enum khác nhau. */
const SAVE_TO_RESULT: Readonly<Record<CurrentVesselSaveStatus, ResolveAndStoreStatus>> =
  Object.freeze({
    [CurrentVesselSaveStatus.CREATED]: ResolveAndStoreStatus.CREATED,
    [CurrentVesselSaveStatus.UPDATED]: ResolveAndStoreStatus.UPDATED,
    [CurrentVesselSaveStatus.UNCHANGED]: ResolveAndStoreStatus.UNCHANGED,
  });

export class ResolveAndStoreCurrentVessel {
  private readonly resolve: ResolveCurrentVessel;
  private readonly repository: ICurrentVesselRepository;

  constructor(deps: ResolveAndStoreCurrentVesselDeps) {
    this.resolve = deps.resolve;
    this.repository = deps.repository;
  }

  async execute(key: VesselObservationKey): Promise<ResolveAndStoreResult> {
    const vessel = await this.resolve.execute(key);

    // Không có gì để nói thì KHÔNG ghi. Một document canonical rỗng là lời nói
    // dối: nó khiến tàu chưa hề có dữ liệu trông như đã được phân xử.
    if (vessel === null) {
      return { status: ResolveAndStoreStatus.NO_DATA, vessel: null };
    }

    const saved = await this.repository.upsert(vessel);

    return {
      status: SAVE_TO_RESULT[saved.status],
      vessel,
      contentHash: saved.contentHash,
      id: saved.id,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
  }
}
