import { AppConfig } from "../config";
import { ICache } from "../application/contracts/cache/ICache";
import { IVesselRepository } from "../application/contracts/repositories/IVesselRepository";
import { IWatchlistRepository } from "../application/contracts/repositories/IWatchlistRepository";
import { CleanupStalePositions } from "../application/use-cases/vessel/CleanupStalePositions";
import { GetVesselDetails } from "../application/use-cases/vessel/GetVesselDetails";
import { ManageWatchlist } from "../application/use-cases/watchlist/ManageWatchlist";
import { InMemoryCache } from "../infrastructure/cache/InMemoryCache";
import { RedisCache } from "../infrastructure/cache/RedisCache";
import { VesselFinderHtmlSource } from "../infrastructure/integrations/vesselfinder/VesselFinderHtmlSource";
import { VesselFinderMapSource } from "../infrastructure/integrations/vesselfinder/VesselFinderMapSource";
import { HttpClient } from "../infrastructure/http/HttpClient";
import { JsonFileVesselRepository } from "../infrastructure/persistence/file/JsonFileVesselRepository";
import { JsonWatchlistRepository } from "../infrastructure/persistence/file/JsonWatchlistRepository";
import { connectMongo } from "../infrastructure/persistence/mongo/connection";
import { MongoVesselRepository } from "../infrastructure/persistence/mongo/MongoVesselRepository";
import { MongoWatchlistRepository } from "../infrastructure/persistence/mongo/MongoWatchlistRepository";
import { CrawlFleetPositions } from "../legacy/use-cases/CrawlFleetPositions";
import { EnrichVesselTypes } from "../legacy/use-cases/EnrichVesselTypes";
import { ScanArea } from "../legacy/use-cases/ScanArea";

export interface LegacyDependencies {
  repository: IVesselRepository;
  watchlistRepository: IWatchlistRepository;
  getVesselDetails: GetVesselDetails;
  crawlFleetPositions: CrawlFleetPositions;
  scanArea: ScanArea;
  manageWatchlist: ManageWatchlist;
  enrichVesselTypes: EnrichVesselTypes;
  cleanupStalePositions: CleanupStalePositions;
}

export interface LegacyBootstrapDependencies extends LegacyDependencies {
  detailsSource: VesselFinderHtmlSource;
  mapSource: VesselFinderMapSource;
}

export interface LegacyBootstrapOptions {
  /** ProductionRuntime owns connection order; legacy callers retain current behavior. */
  connectMongo?: boolean;
}

/**
 * Wires the compatibility path that still serves the legacy VesselFinder
 * model and its HTTP/CLI workflows. It performs no crawl or network request.
 */
export async function createLegacyDependencies(
  config: AppConfig,
  options: LegacyBootstrapOptions = {}
): Promise<LegacyBootstrapDependencies> {
  const httpClient = new HttpClient({ timeoutMs: 10000 });
  const detailsSource = new VesselFinderHtmlSource(httpClient);

  let cache: ICache;
  if (config.redisUrl) {
    console.log("⚡ Cache: Redis");
    cache = new RedisCache(config.redisUrl);
  } else {
    console.log("⚡ Cache: RAM (đặt REDIS_URL để dùng Redis)");
    cache = new InMemoryCache();
  }

  let repository: IVesselRepository;
  let watchlistRepository: IWatchlistRepository;
  if (config.mongoUri) {
    if (options.connectMongo !== false) await connectMongo(config.mongoUri);
    repository = new MongoVesselRepository();
    watchlistRepository = new MongoWatchlistRepository();
  } else {
    console.log("💾 Dùng file JSON (đặt MONGODB_URI để chuyển sang MongoDB)");
    repository = new JsonFileVesselRepository(config.dataDir);
    watchlistRepository = new JsonWatchlistRepository(config.dataDir);
  }

  const current = await watchlistRepository.getAll();
  if (current.length === 0 && config.watchlist.length > 0) {
    for (const id of config.watchlist) await watchlistRepository.add(id);
    console.log(`🌱 Seed watchlist từ .env: ${config.watchlist.join(", ")}`);
  }

  const getVesselDetails = new GetVesselDetails({
    detailsSource,
    repository,
    cache,
    cacheTtlMs: config.cacheTtlMs,
  });
  const crawlFleetPositions = new CrawlFleetPositions({
    detailsSource,
    repository,
    delayMs: config.crawlDelayMs,
  });
  const mapSource = new VesselFinderMapSource(httpClient);
  const scanArea = new ScanArea({
    mapSource,
    repository,
    minMs: config.scanMinMs,
    maxMs: config.scanMaxMs,
    zoom: config.scanZoom,
    tileDelayMinMs: config.scanTileDelayMinMs,
    tileDelayMaxMs: config.scanTileDelayMaxMs,
    subdivideThreshold: config.scanSubdivideThreshold,
    minTileDeg: config.scanMinTileDeg,
    blockCooldownMs: config.scanBlockCooldownMs,
  });
  const manageWatchlist = new ManageWatchlist(watchlistRepository);
  const enrichVesselTypes = new EnrichVesselTypes({
    detailsSource,
    repository,
    batchSize: config.enrichBatchSize,
    delayMs: config.enrichDelayMs,
    intervalMs: config.enrichIntervalMs,
  });
  const cleanupStalePositions = new CleanupStalePositions({
    repo: repository,
    staleAfterMs: config.positionStaleAfterMs,
  });

  return {
    repository,
    watchlistRepository,
    getVesselDetails,
    crawlFleetPositions,
    scanArea,
    manageWatchlist,
    enrichVesselTypes,
    cleanupStalePositions,
    detailsSource,
    mapSource,
  };
}
