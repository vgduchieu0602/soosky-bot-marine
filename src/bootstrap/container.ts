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

export interface Container extends LegacyDependencies, CanonicalDependencies {
  config: AppConfig;
}

export interface BuildContainerOptions {
  connectMongo?: boolean;
}

export async function buildContainer(options: BuildContainerOptions = {}): Promise<Container> {
  // Compatibility path: legacy VesselFinder entities and workflows remain
  // available to the existing HTTP and CLI entry points.
  const legacy = await createLegacyDependencies(config, { connectMongo: options.connectMongo });

  // Target path: multi-source providers, observations and canonical current
  // vessel dependencies. Construction is inert; no AIS client is started.
  const canonical = createCanonicalDependencies({
    config,
    detailsSource: legacy.detailsSource,
    mapSource: legacy.mapSource,
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
    ingestAisBatch: canonical.ingestAisBatch,
  };
}
