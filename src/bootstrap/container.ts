// Composition root: composes legacy compatibility wiring and canonical
// multi-source wiring without starting crawlers, schedulers, or AIS.

import { AppConfig, config } from "../config";
import {
  CanonicalDependencies,
  createCanonicalDependencies,
} from "./createCanonicalDependencies";
import {
  createLegacyDependencies,
  LegacyDependencies,
} from "./createLegacyDependencies";
import {
  createVesselAcquisitionDependencies,
  VesselAcquisitionDependencies,
} from "./createVesselAcquisitionDependencies";

export interface Container
  extends LegacyDependencies,
    CanonicalDependencies,
    VesselAcquisitionDependencies {
  config: AppConfig;
}

export interface BuildContainerOptions {
  connectMongo?: boolean;
  /** Tắt việc gieo watchlist legacy (bot production dùng). */
  seedWatchlist?: boolean;
}

export async function buildContainer(options: BuildContainerOptions = {}): Promise<Container> {
  // Compatibility path: legacy VesselFinder entities and workflows remain
  // available to the existing HTTP and CLI entry points.
  const legacy = await createLegacyDependencies(config, {
    connectMongo: options.connectMongo,
    seedWatchlist: options.seedWatchlist,
  });

  // Target path: multi-source providers, observations and canonical current
  // vessel dependencies. Construction is inert; no AIS client is started.
  const canonical = createCanonicalDependencies({
    config,
    detailsSource: legacy.detailsSource,
    mapSource: legacy.mapSource,
  });

  // LOCAL → FREE → PAID orchestration. Also inert; the paid lane is not wired.
  const acquisition = createVesselAcquisitionDependencies({
    config,
    currentVesselRepository: canonical.currentVesselRepository,
    collectVesselObservations: canonical.collectVesselObservations,
    resolveAndStoreCurrentVessel: canonical.resolveAndStoreCurrentVessel,
    crawlRuntime: canonical.crawlRuntime,
  });

  return {
    config,
    repository: legacy.repository,
    watchlistRepository: legacy.watchlistRepository,
    getVesselDetails: legacy.getVesselDetails,
    crawlFleetPositions: legacy.crawlFleetPositions,
    scanArea: legacy.scanArea,
    manageWatchlist: legacy.manageWatchlist,
    enrichVesselTypes: legacy.enrichVesselTypes,
    cleanupStalePositions: legacy.cleanupStalePositions,
    providerRegistry: canonical.providerRegistry,
    crawlRuntime: canonical.crawlRuntime,
    observationRepository: canonical.observationRepository,
    currentVesselRepository: canonical.currentVesselRepository,
    observationRecorder: canonical.observationRecorder,
    collectVesselObservations: canonical.collectVesselObservations,
    resolveAndStoreCurrentVessel: canonical.resolveAndStoreCurrentVessel,
    acquireFreeVesselData: canonical.acquireFreeVesselData,
    completeVesselBasics: canonical.completeVesselBasics,
    ingestAisBatch: canonical.ingestAisBatch,
    getCanonicalVesselDetail: acquisition.getCanonicalVesselDetail,
    getOrRefreshVesselDetail: acquisition.getOrRefreshVesselDetail,
    getVesselWithFallback: acquisition.getVesselWithFallback,
    detailRefreshGate: acquisition.detailRefreshGate,
    paidFallbackGate: acquisition.paidFallbackGate,
  };
}
