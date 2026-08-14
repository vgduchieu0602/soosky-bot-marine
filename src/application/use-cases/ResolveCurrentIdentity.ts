// ============================================================================
//  APPLICATION · USE CASE: ResolveCurrentIdentity
// ----------------------------------------------------------------------------
//      vesselKey
//        -> repository.findLatestPerSourceByVesselAndType(IDENTITY)
//        -> IdentityResolver
//        -> ResolvedIdentity | null
//
//  Cùng khuôn với `ResolveCurrentPosition` (P8.2). Chỉ ĐỌC: không mạng, không
//  provider, không ghi DB. Kết quả KHÔNG được lưu ở đâu — chưa có canonical
//  storage.
// ============================================================================

import { IVesselObservationRepository } from "../observations/IVesselObservationRepository";
import { IdentityResolver, ResolvedIdentity } from "../resolver/IdentityResolver";
import {
  DEFAULT_IDENTITY_RESOLVER_POLICY,
  IdentityResolverPolicy,
} from "../resolver/StaticResolverPolicy";
import {
  VesselObservationKey,
  VesselObservationType,
} from "../../domain/observations/VesselObservation";

export interface ResolveCurrentIdentityDeps {
  repository: IVesselObservationRepository;
  resolver?: IdentityResolver;
  policy?: IdentityResolverPolicy;
  now?: () => Date;
}

export class ResolveCurrentIdentity {
  private readonly repository: IVesselObservationRepository;
  private readonly resolver: IdentityResolver;
  private readonly policy: IdentityResolverPolicy;
  private readonly now: () => Date;

  constructor(deps: ResolveCurrentIdentityDeps) {
    this.repository = deps.repository;
    this.policy = deps.policy ?? DEFAULT_IDENTITY_RESOLVER_POLICY;
    this.resolver = deps.resolver ?? new IdentityResolver({ policy: this.policy });
    this.now = deps.now ?? (() => new Date());
  }

  /** @returns null khi tàu chưa có observation IDENTITY nào dùng được. */
  async execute(key: VesselObservationKey): Promise<ResolvedIdentity | null> {
    // Cửa sổ rộng (90 ngày): identity gần như bất biến, nguồn crawl thưa vẫn
    // phải lọt vào. Nguồn thưa hơn 90 ngày sẽ bị bỏ — giới hạn đã biết.
    const since = new Date(this.now().getTime() - this.policy.candidateWindowMs);

    const candidates = await this.repository.findLatestPerSourceByVesselAndType(
      key,
      VesselObservationType.IDENTITY,
      { since }
    );

    return this.resolver.resolve(candidates);
  }
}
