// ============================================================================
//  APPLICATION · USE CASE: ResolveCurrentVoyage
// ----------------------------------------------------------------------------
//      vesselKey
//        -> repository.findLatestPerSourceByVesselAndType(VOYAGE)
//        -> VoyageResolver
//        -> ResolvedVoyage | null
//
//  Cùng khuôn với ba use case resolve trước. Chỉ ĐỌC: không mạng, không
//  provider, không ghi DB.
// ============================================================================

import { IVesselObservationRepository } from "../observations/IVesselObservationRepository";
import { ResolvedVoyage, VoyageResolver } from "../resolver/VoyageResolver";
import {
  DEFAULT_VOYAGE_RESOLVER_POLICY,
  VoyageResolverPolicy,
} from "../resolver/StaticResolverPolicy";
import {
  VesselObservationKey,
  VesselObservationType,
} from "../../domain/observations/VesselObservation";

export interface ResolveCurrentVoyageDeps {
  repository: IVesselObservationRepository;
  resolver?: VoyageResolver;
  policy?: VoyageResolverPolicy;
  now?: () => Date;
}

export class ResolveCurrentVoyage {
  private readonly repository: IVesselObservationRepository;
  private readonly resolver: VoyageResolver;
  private readonly policy: VoyageResolverPolicy;
  private readonly now: () => Date;

  constructor(deps: ResolveCurrentVoyageDeps) {
    this.repository = deps.repository;
    this.policy = deps.policy ?? DEFAULT_VOYAGE_RESOLVER_POLICY;
    this.resolver = deps.resolver ?? new VoyageResolver();
    this.now = deps.now ?? (() => new Date());
  }

  /** @returns null khi tàu chưa có observation VOYAGE nào dùng được. */
  async execute(key: VesselObservationKey): Promise<ResolvedVoyage | null> {
    // Cửa sổ 7 ngày — một chuyến biển điển hình. Hẹp hơn identity/particulars
    // (90 ngày) vì voyage đổi theo chuyến, rộng hơn position vì nó không đổi
    // theo giây.
    const since = new Date(this.now().getTime() - this.policy.candidateWindowMs);

    const candidates = await this.repository.findLatestPerSourceByVesselAndType(
      key,
      VesselObservationType.VOYAGE,
      { since }
    );

    return this.resolver.resolve(candidates);
  }
}
