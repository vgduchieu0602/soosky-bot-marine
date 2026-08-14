// ============================================================================
//  COMPOSITION ROOT · container.ts — nơi DUY NHẤT ráp mọi mảnh lại
// ----------------------------------------------------------------------------
//  Tạo các adapter cụ thể và tiêm vào use case (Dependency Injection).
//  Muốn đổi công nghệ (Redis / MongoDB / nguồn khác) -> chỉ sửa file này.
// ============================================================================

import { config, AppConfig } from "./config";

import { HttpClient } from "./infrastructure/http/HttpClient";
import { VesselFinderHtmlSource } from "./infrastructure/datasources/VesselFinderHtmlSource";
import { VesselFinderMapSource } from "./infrastructure/datasources/VesselFinderMapSource";
import { InMemoryCache } from "./infrastructure/cache/InMemoryCache";
import { RedisCache } from "./infrastructure/cache/RedisCache";
import { ICache } from "./application/ports/ICache";
import { JsonFileVesselRepository } from "./infrastructure/persistence/JsonFileVesselRepository";
import { MongoVesselRepository } from "./infrastructure/persistence/MongoVesselRepository";
import { JsonWatchlistRepository } from "./infrastructure/persistence/JsonWatchlistRepository";
import { MongoWatchlistRepository } from "./infrastructure/persistence/MongoWatchlistRepository";
import { connectMongo } from "./infrastructure/persistence/mongoose/connection";

import { ProviderRegistry } from "./application/providers/ProviderRegistry";
import { SourceRuntimeManager } from "./application/runtime/SourceRuntimeManager";
import { IVesselObservationRepository } from "./application/observations/IVesselObservationRepository";
import { ObservationRecorder } from "./application/observations/ObservationRecorder";
import { InMemoryVesselObservationRepository } from "./infrastructure/persistence/InMemoryVesselObservationRepository";
import { MongoVesselObservationRepository } from "./infrastructure/persistence/MongoVesselObservationRepository";
import { VesselFinderProvider } from "./infrastructure/providers/VesselFinderProvider";
import { ShipInfoClient } from "./infrastructure/providers/shipinfo/ShipInfoClient";
import { ShipInfoProvider } from "./infrastructure/providers/shipinfo/ShipInfoProvider";
import { SHIPINFO_PARSER_VERSION } from "./infrastructure/providers/shipinfo/ShipInfoParser";
import { CollectVesselObservations } from "./application/use-cases/CollectVesselObservations";
import { VesselSource } from "./domain/value-objects/VesselSource";

import { GetVesselDetails } from "./application/use-cases/GetVesselDetails";
import { CrawlFleetPositions } from "./application/use-cases/CrawlFleetPositions";
import { ScanArea } from "./application/use-cases/ScanArea";
import { ManageWatchlist } from "./application/use-cases/ManageWatchlist";
import { EnrichVesselTypes } from "./application/use-cases/EnrichVesselTypes";
import { CleanupStalePositions } from "./application/use-cases/CleanupStalePositions";
import { IVesselRepository } from "./application/ports/IVesselRepository";
import { IWatchlistRepository } from "./application/ports/IWatchlistRepository";

export interface Container {
  config: AppConfig;
  repository: IVesselRepository;
  watchlistRepository: IWatchlistRepository;
  getVesselDetails: GetVesselDetails;
  crawlFleetPositions: CrawlFleetPositions;
  scanArea: ScanArea;
  manageWatchlist: ManageWatchlist;
  enrichVesselTypes: EnrichVesselTypes;
  cleanupStalePositions: CleanupStalePositions;
  /**
   * Sổ đăng ký provider multi-source (P3). Hiện KHÔNG use case nào dùng — đường
   * legacy vẫn tiêm thẳng IVesselDetailsSource/IAreaScanner như cũ. Expose ra
   * đây để phase sau có chỗ cắm resolver. Xem PROVIDER_ARCHITECTURE.md §6.
   */
  providerRegistry: ProviderRegistry;
  /**
   * Crawl runtime dùng chung (P4): concurrency/delay/retry/cooldown theo TỪNG
   * nguồn. Hiện KHÔNG use case nào dùng — legacy vẫn tự sleep/cooldown như cũ.
   * Tạo lười: chưa ai gọi getExecutor thì không có timer, không có state.
   * Xem CRAWL_RUNTIME.md §9.
   */
  crawlRuntime: SourceRuntimeManager;
  /**
   * Kho lời khai của các nguồn (P5). SONG SONG với `repository` legacy, KHÔNG
   * thay thế: crawler hiện tại vẫn ghi thẳng vào vessels/latestpositions như cũ.
   * Xem OBSERVATION_STORAGE.md §10.
   */
  observationRepository: IVesselObservationRepository;
  /** Cửa duy nhất để provider mới ghi observation. Chưa ai gọi ở P5. */
  observationRecorder: ObservationRecorder;
  /**
   * P6.4: nối provider (P3) + crawl runtime (P4) + observation (P5) thành một
   * đường chạy. Chỉ được gọi TAY qua `npm run shipinfo:poc` — không scheduler,
   * không cron, không bulk crawl.
   */
  collectVesselObservations: CollectVesselObservations;
}

export async function buildContainer(): Promise<Container> {
  // 1) Adapter hạ tầng
  const httpClient = new HttpClient({ timeoutMs: 10000 });
  const detailsSource = new VesselFinderHtmlSource(httpClient); // có lat/lon (làm tròn)

  // Chọn cache: có REDIS_URL -> Redis, không thì RAM.
  let cache: ICache;
  if (config.redisUrl) {
    console.log("⚡ Cache: Redis");
    cache = new RedisCache(config.redisUrl);
  } else {
    console.log("⚡ Cache: RAM (đặt REDIS_URL để dùng Redis)");
    cache = new InMemoryCache();
  }

  // Chọn nơi lưu trữ: có MONGODB_URI -> MongoDB, không thì file JSON.
  // ĐÂY là điểm đổi công nghệ duy nhất — use case không hề biết.
  let repository: IVesselRepository;
  let watchlistRepository: IWatchlistRepository;
  if (config.mongoUri) {
    await connectMongo(config.mongoUri);
    repository = new MongoVesselRepository();
    watchlistRepository = new MongoWatchlistRepository();
  } else {
    console.log("💾 Dùng file JSON (đặt MONGODB_URI để chuyển sang MongoDB)");
    repository = new JsonFileVesselRepository(config.dataDir);
    watchlistRepository = new JsonWatchlistRepository(config.dataDir);
  }

  // Seed watchlist từ .env nếu DB còn trống (lần chạy đầu tiên).
  const current = await watchlistRepository.getAll();
  if (current.length === 0 && config.watchlist.length > 0) {
    for (const id of config.watchlist) await watchlistRepository.add(id);
    console.log(`🌱 Seed watchlist từ .env: ${config.watchlist.join(", ")}`);
  }

  // 2) Lắp vào use case
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
  // Dọn vị trí map hết hạn: chỉ latest_positions, giữ lý lịch + lịch sử.
  const cleanupStalePositions = new CleanupStalePositions({
    repo: repository,
    staleAfterMs: config.positionStaleAfterMs,
  });

  // 3) Sổ đăng ký provider (P3) — SONG SONG với wiring legacy ở trên, không
  //    thay thế nó. VesselFinderProvider BỌC lại đúng 2 source vừa tạo, nên
  //    không phát sinh thêm một request nào lên upstream.
  //    Chỉ đăng ký provider CÓ THẬT: AISStream (bot chưa nối) và MyShipTracking
  //    (chưa có client) cố ý vắng mặt — capability tồn tại không có nghĩa là có
  //    implementation. Xem PROVIDER_ARCHITECTURE.md §2.
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(
    new VesselFinderProvider({ detailsSource, areaScanner: mapSource })
  );

  // 4) Crawl runtime (P4). Config đi vào TỪ ĐÂY — runtime class không đọc
  //    process.env. Chưa truyền override nào: mặc định bảo thủ là đủ cho tới
  //    khi có crawler thật để đo. Không đụng nhịp nghỉ của legacy use case.
  const crawlRuntime = new SourceRuntimeManager();

  // 5) Kho observation (P5). Collection RIÊNG `vessel_observations` — không
  //    đụng vessels/latestpositions/vesselpositions, không backfill dữ liệu cũ.
  //    Không có MongoDB -> giữ RAM: đường JSON file là để chạy thử, nhật ký
  //    nhiều nguồn ghi ra file phẳng thì vừa chậm vừa vô dụng.
  const observationRepository: IVesselObservationRepository = config.mongoUri
    ? new MongoVesselObservationRepository()
    : new InMemoryVesselObservationRepository();
  const observationRecorder = new ObservationRecorder({ repository: observationRepository });

  // 6) ShipInfo (P6.4). Đăng ký provider là thao tác TRƠ: registry chỉ ghi sổ,
  //    không tự chạy gì. Mọi lời gọi mạng của ShipInfo bắt buộc đi qua
  //    CollectVesselObservations -> SourceRequestExecutor (P4).
  //    HttpClient RIÊNG với timeout lấy TỪ chính runtime config: nếu để chung
  //    client 10s, timeout 20s của ShipInfo sẽ không bao giờ có hiệu lực vì
  //    AbortSignal bên trong HttpClient bắn trước.
  const shipInfoTimeoutMs = crawlRuntime.getConfig(VesselSource.SHIPINFO).timeoutMs;
  providerRegistry.register(
    new ShipInfoProvider({
      client: new ShipInfoClient({ http: new HttpClient({ timeoutMs: shipInfoTimeoutMs }) }),
    })
  );

  const collectVesselObservations = new CollectVesselObservations({
    registry: providerRegistry,
    runtime: crawlRuntime,
    recorder: observationRecorder,
    parserVersionBySource: { [VesselSource.SHIPINFO]: SHIPINFO_PARSER_VERSION },
  });

  return {
    config,
    repository,
    watchlistRepository,
    getVesselDetails,
    crawlFleetPositions,
    scanArea,
    manageWatchlist,
    enrichVesselTypes,
    cleanupStalePositions,
    providerRegistry,
    crawlRuntime,
    observationRepository,
    observationRecorder,
    collectVesselObservations,
  };
}
