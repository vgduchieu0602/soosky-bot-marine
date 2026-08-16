// ============================================================================
//  APPLICATION · USE CASE: ResolveCurrentPosition
//  → Chứng minh đường ĐỌC: observation -> resolver -> vị trí canonical.
// ----------------------------------------------------------------------------
//      vesselKey
//        -> repository.findLatestPerSourceByVesselAndType(POSITION)
//        -> PositionResolver
//        -> ResolvedPosition | null
//
//  KHÔNG mạng, KHÔNG provider, KHÔNG runtime P4, KHÔNG ghi DB, KHÔNG fallback.
//  Resolver chỉ ĐỌC thứ đã thu thập; việc thu thập là mối lo khác.
//
//  Kết quả KHÔNG được lưu ở đâu cả — P8.2 chưa có canonical storage.
// ============================================================================

import {
  IVesselObservationRepository,
} from "../../contracts/repositories/IVesselObservationRepository";
import { PositionResolver, ResolvedPosition } from "../../services/resolution/PositionResolver";
import {
  DEFAULT_POSITION_RESOLVER_POLICY,
  PositionResolverPolicy,
} from "../../services/resolution/PositionResolverPolicy";
import {
  VesselObservationKey,
  VesselObservationType,
} from "../../../domain/entities/VesselObservation";

export interface ResolveCurrentPositionDeps {
  repository: IVesselObservationRepository;
  resolver?: PositionResolver;
  policy?: PositionResolverPolicy;
  now?: () => Date;
}

export class ResolveCurrentPosition {
  private readonly repository: IVesselObservationRepository;
  private readonly resolver: PositionResolver;
  private readonly policy: PositionResolverPolicy;
  private readonly now: () => Date;

  constructor(deps: ResolveCurrentPositionDeps) {
    this.repository = deps.repository;
    this.policy = deps.policy ?? DEFAULT_POSITION_RESOLVER_POLICY;
    this.resolver = deps.resolver ?? new PositionResolver({ policy: this.policy });
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * @returns null khi tàu không có observation POSITION nào dùng được.
   *          KHÔNG bịa vị trí, KHÔNG gọi nguồn để lấy thêm.
   */
  async execute(key: VesselObservationKey): Promise<ResolvedPosition | null> {
    const now = this.now();

    // Cửa sổ lọc theo `fetchedAt`, RỘNG HƠN ngưỡng STALE có chủ ý: cắt đúng 24h
    // sẽ khiến bậc EXPIRED và NO_SOURCE_TIME không bao giờ tới được resolver.
    const since = new Date(now.getTime() - this.policy.candidateWindowMs);

    const candidates = await this.repository.findLatestPerSourceByVesselAndType(
      key,
      VesselObservationType.POSITION,
      { since }
      // includeInvalid mặc định false — bản ghi hỏng không phải ứng viên.
    );

    return this.resolver.resolve(candidates, now);
  }
}
