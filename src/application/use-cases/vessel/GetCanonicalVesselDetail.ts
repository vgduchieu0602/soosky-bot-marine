// ============================================================================
//  APPLICATION · USE CASE: GetCanonicalVesselDetail
// ----------------------------------------------------------------------------
//      { mmsi? , imo? }
//            ↓  validator P1 (không cho định danh rác xuống kho)
//      ICurrentVesselRepository.findByMmsi / findByImo
//            ↓
//      projectVesselDetail(now)
//            ↓
//      CanonicalVesselDetail   |   NOT_FOUND
//
//  ⛔ KHÔNG gọi crawler (ShipFinder/ShipInfo/VesselFinder), KHÔNG gọi
//     MyShipTracking, KHÔNG đọc `vessel_observations`, KHÔNG scheduler.
//     Đây là đường ĐỌC thuần trên canonical.
//
//  ⛔ KHÔNG tự đi lấy dữ liệu khi tra không thấy. Quyết định đó là của DETAIL-2,
//     vì nó tiêu request thật lên nguồn ngoài — không được lẫn vào một use case
//     mà người gọi tưởng là chỉ đọc.
// ============================================================================

import { ICurrentVesselRepository } from "../../contracts/repositories/ICurrentVesselRepository";
import {
  CanonicalVesselDetail,
  DEFAULT_VESSEL_DETAIL_POLICY,
  VesselDetailPolicy,
  projectVesselDetail,
} from "../../services/vessel/VesselDetailProjector";
import { isValidImo, isValidMmsi } from "../../../domain/validators/identifiers";

export const VesselDetailStatus = {
  FOUND: "FOUND",
  /** Canonical chưa biết gì về con tàu này. DETAIL-1 KHÔNG tự đi lấy. */
  NOT_FOUND: "NOT_FOUND",
} as const;

export type VesselDetailStatus = (typeof VesselDetailStatus)[keyof typeof VesselDetailStatus];

export type GetCanonicalVesselDetailResult =
  | { readonly status: typeof VesselDetailStatus.FOUND; readonly detail: CanonicalVesselDetail }
  | { readonly status: typeof VesselDetailStatus.NOT_FOUND; readonly detail: null };

export interface GetCanonicalVesselDetailInput {
  readonly mmsi?: string;
  readonly imo?: string;
}

export class InvalidVesselIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVesselIdentifierError";
  }
}

export interface GetCanonicalVesselDetailDeps {
  repository: ICurrentVesselRepository;
  now?: () => Date;
  policy?: VesselDetailPolicy;
}

export class GetCanonicalVesselDetail {
  private readonly repository: ICurrentVesselRepository;
  private readonly now: () => Date;
  private readonly policy: VesselDetailPolicy;

  constructor(deps: GetCanonicalVesselDetailDeps) {
    this.repository = deps.repository;
    this.now = deps.now ?? (() => new Date());
    this.policy = deps.policy ?? DEFAULT_VESSEL_DETAIL_POLICY;
  }

  /**
   * Tra bằng MMSI trước, IMO sau — đúng thứ tự mà `MongoCurrentVesselRepository`
   * đang dùng, và đúng thứ FE có sẵn khi bấm vào một chấm trên map
   * (`MapVesselItem.mmsi`), nên không cần bước tra IMO trung gian nào.
   *
   * @throws InvalidVesselIdentifierError khi không có định danh nào, hoặc định
   *         danh sai định dạng. KHÔNG tra mờ, KHÔNG tìm theo tên.
   */
  async execute(input: GetCanonicalVesselDetailInput): Promise<GetCanonicalVesselDetailResult> {
    const mmsi = GetCanonicalVesselDetail.normalize(input.mmsi);
    const imo = GetCanonicalVesselDetail.normalize(input.imo);

    if (mmsi === null && imo === null) {
      throw new InvalidVesselIdentifierError("Cần ít nhất một trong MMSI hoặc IMO");
    }
    // Dùng lại validator domain — không viết luật định dạng lần thứ hai.
    if (mmsi !== null && !isValidMmsi(mmsi)) {
      throw new InvalidVesselIdentifierError(`MMSI không hợp lệ: "${mmsi}"`);
    }
    if (imo !== null && !isValidImo(imo)) {
      throw new InvalidVesselIdentifierError(`IMO không hợp lệ: "${imo}"`);
    }

    const vessel =
      (mmsi === null ? null : await this.repository.findByMmsi(mmsi)) ??
      (imo === null ? null : await this.repository.findByImo(imo));

    if (vessel === null) return { status: VesselDetailStatus.NOT_FOUND, detail: null };

    // Chi tiết TỪNG PHẦN vẫn là chi tiết hợp lệ: tàu vừa hiện trên map từ AIS
    // mới chỉ có MMSI + vị trí, và đó là câu trả lời đúng — không phải 404.
    return {
      status: VesselDetailStatus.FOUND,
      detail: projectVesselDetail(vessel, this.now(), this.policy),
    };
  }

  private static normalize(value: string | undefined): string | null {
    const trimmed = (value ?? "").trim();
    return trimmed === "" ? null : trimmed;
  }
}
