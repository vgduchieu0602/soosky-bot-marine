// ============================================================================
//  BOOTSTRAP · Wiring for the LOCAL → FREE → PAID acquisition lane.
// ----------------------------------------------------------------------------
//  Construction is inert: no crawl, no HTTP request, no credit spent here.
//
//  The PAID lane is deliberately NOT wired. `TrackVesselCurrentPosition` needs
//  two things this repository does not have yet: an adapter that implements
//  `PaidPositionSource`, and a credit ledger for `PaidBudgetSnapshot`. The gate
//  treats `remainingCalls: null` as a refusal, so a stub ledger would either lie
//  about the balance or refuse everything while pretending the lane exists.
//
//  Consequence, and it is the intended one: `GetVesselWithFallback` runs
//  LOCAL → FREE and reports `paidSkipReason: LANE_UNAVAILABLE`. Wiring the paid
//  lane is a separate, deliberate step that starts with measuring the free-miss
//  ratio — see docs/FREE_TO_PAID_FALLBACK.md §9.
// ============================================================================

import { AppConfig } from "../config";
import { ICurrentVesselRepository } from "../application/contracts/repositories/ICurrentVesselRepository";
import { FreeSourceSelector } from "../application/services/acquisition/FreeSourceSelector";
import { SourceHealthState } from "../application/services/crawl-runtime/SourceHealthTracker";
import { SourceRuntimeManager } from "../application/services/crawl-runtime/SourceRuntimeManager";
import { usesCrawlRuntime } from "../application/services/crawl-runtime/SourceRuntimeConfig";
import { DetailRefreshGate } from "../application/services/vessel/DetailRefreshGate";
import { CollectVesselObservations } from "../application/use-cases/observation/CollectVesselObservations";
import { ResolveAndStoreCurrentVessel } from "../application/use-cases/resolution/ResolveAndStoreCurrentVessel";
import { GetCanonicalVesselDetail } from "../application/use-cases/vessel/GetCanonicalVesselDetail";
import {
  DEFAULT_DETAIL_REFRESH_POLICY,
  GetOrRefreshVesselDetail,
} from "../application/use-cases/vessel/GetOrRefreshVesselDetail";
import {
  DEFAULT_FALLBACK_POLICY,
  GetVesselWithFallback,
} from "../application/use-cases/vessel/GetVesselWithFallback";

export interface VesselAcquisitionDependencies {
  getCanonicalVesselDetail: GetCanonicalVesselDetail;
  getOrRefreshVesselDetail: GetOrRefreshVesselDetail;
  getVesselWithFallback: GetVesselWithFallback;
  /** Cooldown + single-flight state for the FREE lane. One instance per process. */
  detailRefreshGate: DetailRefreshGate;
  /** Same class, separate instance: the paid cooldown must not share a table. */
  paidFallbackGate: DetailRefreshGate;
}

export interface VesselAcquisitionInputs {
  config: AppConfig;
  currentVesselRepository: ICurrentVesselRepository;
  collectVesselObservations: CollectVesselObservations;
  resolveAndStoreCurrentVessel: ResolveAndStoreCurrentVessel;
  crawlRuntime: SourceRuntimeManager;
}

export function createVesselAcquisitionDependencies(
  inputs: VesselAcquisitionInputs
): VesselAcquisitionDependencies {
  const { config, currentVesselRepository } = inputs;

  const getCanonicalVesselDetail = new GetCanonicalVesselDetail({
    repository: currentVesselRepository,
  });

  const detailRefreshGate = new DetailRefreshGate();
  const getOrRefreshVesselDetail = new GetOrRefreshVesselDetail({
    read: getCanonicalVesselDetail,
    selector: new FreeSourceSelector(),
    collect: inputs.collectVesselObservations,
    resolveAndStore: inputs.resolveAndStoreCurrentVessel,
    gate: detailRefreshGate,
    healthOf: (source) =>
      usesCrawlRuntime(source)
        ? inputs.crawlRuntime.getHealth(source).state
        : SourceHealthState.DISABLED,
    currentVessels: currentVesselRepository,
    policy: {
      ...DEFAULT_DETAIL_REFRESH_POLICY,
      totalBudgetMs: config.detailRefreshTimeoutMs,
      maxSources: config.detailRefreshMaxSources,
    },
  });

  // Separate gate instance, and the orchestrator additionally prefixes its keys
  // with `paid:`. Two locks for one reason: a free crawl cooldown must never
  // silence a paid call, and a paid cooldown must never silence a free crawl.
  const paidFallbackGate = new DetailRefreshGate({
    policy: {
      successCooldownMs: config.paidFallbackCooldownMs,
      // A failed paid call gets the same rest as a successful one. Retrying fast
      // after a failure is how a broken vessel record turns into repeat charges.
      failureCooldownMs: config.paidFallbackCooldownMs,
      maxEntries: 20_000,
    },
  });

  const getVesselWithFallback = new GetVesselWithFallback({
    read: getCanonicalVesselDetail,
    free: getOrRefreshVesselDetail,
    // paid: intentionally absent — see the header of this file.
    gate: paidFallbackGate,
    policy: {
      ...DEFAULT_FALLBACK_POLICY,
      totalBudgetMs: config.freeFallbackTotalTimeoutMs,
    },
    logger: console,
  });

  return {
    getCanonicalVesselDetail,
    getOrRefreshVesselDetail,
    getVesselWithFallback,
    detailRefreshGate,
    paidFallbackGate,
  };
}
