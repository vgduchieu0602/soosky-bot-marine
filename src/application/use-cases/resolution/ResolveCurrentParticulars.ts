// ============================================================================
//  APPLICATION · USE CASE: ResolveCurrentParticulars
// ----------------------------------------------------------------------------
//      vesselKey
//        -> repository.findLatestPerSourceByVesselAndType(PARTICULARS)
//        -> ParticularsResolver
//        -> ResolvedParticulars | null
//
//  Chỉ ĐỌC: không mạng, không provider, không ghi DB.
// ============================================================================

import { IVesselObservationRepository } from "../../contracts/repositories/IVesselObservationRepository";
import { ParticularsResolver, ResolvedParticulars } from "../../services/resolution/ParticularsResolver";
import {
  DEFAULT_PARTICULARS_RESOLVER_POLICY,
  ParticularsResolverPolicy,
} from "../../services/resolution/StaticResolverPolicy";
import {
  VesselObservationKey,
  VesselObservationType,
} from "../../../domain/entities/VesselObservation";

export interface ResolveCurrentParticularsDeps {
  repository: IVesselObservationRepository;
  resolver?: ParticularsResolver;
  policy?: ParticularsResolverPolicy;
  now?: () => Date;
}

export class ResolveCurrentParticulars {
  private readonly repository: IVesselObservationRepository;
  private readonly resolver: ParticularsResolver;
  private readonly policy: ParticularsResolverPolicy;
  private readonly now: () => Date;

  constructor(deps: ResolveCurrentParticularsDeps) {
    this.repository = deps.repository;
    this.policy = deps.policy ?? DEFAULT_PARTICULARS_RESOLVER_POLICY;
    this.resolver = deps.resolver ?? new ParticularsResolver({ policy: this.policy });
    this.now = deps.now ?? (() => new Date());
  }

  /** @returns null khi tàu chưa có observation PARTICULARS nào dùng được. */
  async execute(key: VesselObservationKey): Promise<ResolvedParticulars | null> {
    const since = new Date(this.now().getTime() - this.policy.candidateWindowMs);

    const candidates = await this.repository.findLatestPerSourceByVesselAndType(
      key,
      VesselObservationType.PARTICULARS,
      { since }
    );

    return this.resolver.resolve(candidates);
  }
}
