import { AppConfig } from "../config";
import { ICurrentVesselRepository } from "../application/contracts/repositories/ICurrentVesselRepository";
import { IVesselObservationRepository } from "../application/contracts/repositories/IVesselObservationRepository";
import { FreeSourceSelector } from "../application/services/acquisition/FreeSourceSelector";
import { ProviderRegistry } from "../application/services/acquisition/ProviderRegistry";
import { SourceHealthState } from "../application/services/crawl-runtime/SourceHealthTracker";
import { SourceRuntimeManager } from "../application/services/crawl-runtime/SourceRuntimeManager";
import { usesCrawlRuntime } from "../application/services/crawl-runtime/SourceRuntimeConfig";
import { ObservationRecorder } from "../application/services/observation/ObservationRecorder";
import { ResolveCurrentVessel } from "../application/use-cases/resolution/ResolveCurrentVessel";
import { ResolveAndStoreCurrentVessel } from "../application/use-cases/resolution/ResolveAndStoreCurrentVessel";
import { AcquireFreeVesselData } from "../application/use-cases/acquisition/AcquireFreeVesselData";
import { CheckLocalVesselSufficiency } from "../application/use-cases/acquisition/CheckLocalVesselSufficiency";
import { CollectVesselObservations } from "../application/use-cases/observation/CollectVesselObservations";
import { VesselSource } from "../domain/enums/VesselSource";
import { ShipFinderClient } from "../infrastructure/integrations/shipfinder/ShipFinderClient";
import { SHIPFINDER_PARSER_VERSION } from "../infrastructure/integrations/shipfinder/ShipFinderParser";
import { ShipFinderProvider } from "../infrastructure/integrations/shipfinder/ShipFinderProvider";
import { ShipInfoClient } from "../infrastructure/integrations/shipinfo/ShipInfoClient";
import { SHIPINFO_PARSER_VERSION } from "../infrastructure/integrations/shipinfo/ShipInfoParser";
import { ShipInfoProvider } from "../infrastructure/integrations/shipinfo/ShipInfoProvider";
import { VesselFinderHtmlSource } from "../infrastructure/integrations/vesselfinder/VesselFinderHtmlSource";
import { VesselFinderMapSource } from "../infrastructure/integrations/vesselfinder/VesselFinderMapSource";
import { VesselFinderProvider } from "../infrastructure/integrations/vesselfinder/VesselFinderProvider";
import { HttpClient } from "../infrastructure/http/HttpClient";
import { InMemoryCurrentVesselRepository } from "../infrastructure/persistence/memory/InMemoryCurrentVesselRepository";
import { InMemoryVesselObservationRepository } from "../infrastructure/persistence/memory/InMemoryVesselObservationRepository";
import { MongoCurrentVesselRepository } from "../infrastructure/persistence/mongo/MongoCurrentVesselRepository";
import { MongoVesselObservationRepository } from "../infrastructure/persistence/mongo/MongoVesselObservationRepository";

export interface CanonicalDependencies {
  providerRegistry: ProviderRegistry;
  crawlRuntime: SourceRuntimeManager;
  observationRepository: IVesselObservationRepository;
  currentVesselRepository: ICurrentVesselRepository;
  observationRecorder: ObservationRecorder;
  collectVesselObservations: CollectVesselObservations;
  resolveAndStoreCurrentVessel: ResolveAndStoreCurrentVessel;
  acquireFreeVesselData: AcquireFreeVesselData;
}

export interface CanonicalDependencyInputs {
  config: AppConfig;
  detailsSource: VesselFinderHtmlSource;
  mapSource: VesselFinderMapSource;
}

/**
 * Wires the canonical multi-source path. Construction is inert: it does not
 * crawl, resolve, persist observations, or start AIS.
 */
export function createCanonicalDependencies(
  inputs: CanonicalDependencyInputs
): CanonicalDependencies {
  const { config, detailsSource, mapSource } = inputs;
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(
    new VesselFinderProvider({ detailsSource, areaScanner: mapSource })
  );

  const crawlRuntime = new SourceRuntimeManager();
  const observationRepository: IVesselObservationRepository = config.mongoUri
    ? new MongoVesselObservationRepository()
    : new InMemoryVesselObservationRepository();
  const observationRecorder = new ObservationRecorder({ repository: observationRepository });
  const currentVesselRepository: ICurrentVesselRepository = config.mongoUri
    ? new MongoCurrentVesselRepository()
    : new InMemoryCurrentVesselRepository();
  const resolveAndStoreCurrentVessel = new ResolveAndStoreCurrentVessel({
    resolve: new ResolveCurrentVessel({ repository: observationRepository }),
    repository: currentVesselRepository,
  });

  const shipInfoTimeoutMs = crawlRuntime.getConfig(VesselSource.SHIPINFO).timeoutMs;
  providerRegistry.register(
    new ShipInfoProvider({
      client: new ShipInfoClient({ http: new HttpClient({ timeoutMs: shipInfoTimeoutMs }) }),
    })
  );

  const shipFinderTimeoutMs = crawlRuntime.getConfig(VesselSource.SHIPFINDER).timeoutMs;
  providerRegistry.register(
    new ShipFinderProvider({
      client: new ShipFinderClient({ http: new HttpClient({ timeoutMs: shipFinderTimeoutMs }) }),
      sourceUtcOffsetMinutes: config.shipFinderSourceUtcOffsetMinutes,
    })
  );

  const collectVesselObservations = new CollectVesselObservations({
    registry: providerRegistry,
    runtime: crawlRuntime,
    recorder: observationRecorder,
    parserVersionBySource: {
      [VesselSource.SHIPINFO]: SHIPINFO_PARSER_VERSION,
      [VesselSource.SHIPFINDER]: SHIPFINDER_PARSER_VERSION,
    },
  });
  const acquireFreeVesselData = new AcquireFreeVesselData({
    checkLocal: new CheckLocalVesselSufficiency({ repository: currentVesselRepository }),
    selector: new FreeSourceSelector(),
    collect: collectVesselObservations,
    resolveAndStore: resolveAndStoreCurrentVessel,
    healthOf: (source) =>
      usesCrawlRuntime(source)
        ? crawlRuntime.getHealth(source).state
        : SourceHealthState.DISABLED,
  });

  return {
    providerRegistry,
    crawlRuntime,
    observationRepository,
    currentVesselRepository,
    observationRecorder,
    collectVesselObservations,
    resolveAndStoreCurrentVessel,
    acquireFreeVesselData,
  };
}
