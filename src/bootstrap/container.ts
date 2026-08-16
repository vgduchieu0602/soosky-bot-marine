// ============================================================================
//  COMPOSITION ROOT · container.ts — nơi DUY NHẤT ráp mọi mảnh lại
// ----------------------------------------------------------------------------
//  Tạo các adapter cụ thể và tiêm vào use case (Dependency Injection).
//  Muốn đổi công nghệ (Redis / MongoDB / nguồn khác) -> chỉ sửa file này.
// ============================================================================

import { config, AppConfig } from "../config";

import { HttpClient } from "../infrastructure/http/HttpClient";
import { VesselFinderHtmlSource } from "../infrastructure/integrations/vesselfinder/VesselFinderHtmlSource";
import { VesselFinderMapSource } from "../infrastructure/integrations/vesselfinder/VesselFinderMapSource";
import { InMemoryCache } from "../infrastructure/cache/InMemoryCache";
import { RedisCache } from "../infrastructure/cache/RedisCache";
import { ICache } from "../application/contracts/providers/ICache";
import { JsonFileVesselRepository } from "../infrastructure/persistence/file/JsonFileVesselRepository";
import { MongoVesselRepository } from "../infrastructure/persistence/mongo/MongoVesselRepository";
import { JsonWatchlistRepository } from "../infrastructure/persistence/file/JsonWatchlistRepository";
import { MongoWatchlistRepository } from "../infrastructure/persistence/mongo/MongoWatchlistRepository";
import { connectMongo } from "../infrastructure/persistence/mongo/connection";

import { ProviderRegistry } from "../application/services/acquisition/ProviderRegistry";
import { SourceRuntimeManager } from "../application/services/crawl-runtime/SourceRuntimeManager";
import { IVesselObservationRepository } from "../application/contracts/repositories/IVesselObservationRepository";
import { ObservationRecorder } from "../application/services/observation/ObservationRecorder";
import { ICurrentVesselRepository } from "../application/contracts/repositories/ICurrentVesselRepository";
import { InMemoryVesselObservationRepository } from "../infrastructure/persistence/memory/InMemoryVesselObservationRepository";
import { MongoVesselObservationRepository } from "../infrastructure/persistence/mongo/MongoVesselObservationRepository";
import { InMemoryCurrentVesselRepository } from "../infrastructure/persistence/memory/InMemoryCurrentVesselRepository";
import { MongoCurrentVesselRepository } from "../infrastructure/persistence/mongo/MongoCurrentVesselRepository";
import { VesselFinderProvider } from "../infrastructure/integrations/vesselfinder/VesselFinderProvider";
import { ShipInfoClient } from "../infrastructure/integrations/shipinfo/ShipInfoClient";
import { ShipInfoProvider } from "../infrastructure/integrations/shipinfo/ShipInfoProvider";
import { SHIPINFO_PARSER_VERSION } from "../infrastructure/integrations/shipinfo/ShipInfoParser";
import { ShipFinderClient } from "../infrastructure/integrations/shipfinder/ShipFinderClient";
import { ShipFinderProvider } from "../infrastructure/integrations/shipfinder/ShipFinderProvider";
import { SHIPFINDER_PARSER_VERSION } from "../infrastructure/integrations/shipfinder/ShipFinderParser";
import { CollectVesselObservations } from "../application/use-cases/CollectVesselObservations";
import { ResolveCurrentVessel } from "../application/use-cases/ResolveCurrentVessel";
import { ResolveAndStoreCurrentVessel } from "../application/use-cases/ResolveAndStoreCurrentVessel";
import { CheckLocalVesselSufficiency } from "../application/use-cases/CheckLocalVesselSufficiency";
import { AcquireFreeVesselData } from "../application/use-cases/AcquireFreeVesselData";
import { FreeSourceSelector } from "../application/services/acquisition/FreeSourceSelector";
import { SourceHealthState } from "../application/services/crawl-runtime/SourceHealthTracker";
import { usesCrawlRuntime } from "../application/services/crawl-runtime/SourceRuntimeConfig";
import { VesselSource } from "../domain/enums/VesselSource";

import { GetVesselDetails } from "../application/use-cases/GetVesselDetails";
import { CrawlFleetPositions } from "../legacy/use-cases/CrawlFleetPositions";
import { ScanArea } from "../legacy/use-cases/ScanArea";
import { ManageWatchlist } from "../application/use-cases/ManageWatchlist";
import { EnrichVesselTypes } from "../legacy/use-cases/EnrichVesselTypes";
import { CleanupStalePositions } from "../application/use-cases/CleanupStalePositions";
import { IVesselRepository } from "../application/contracts/repositories/IVesselRepository";
import { IWatchlistRepository } from "../application/contracts/repositories/IWatchlistRepository";

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
  /** Kho canonical current (P8.5), tách hẳn observation append-only và legacy. */
  currentVesselRepository: ICurrentVesselRepository;
  /** Cửa duy nhất để provider mới ghi observation. Chưa ai gọi ở P5. */
  observationRecorder: ObservationRecorder;
  /**
   * P6.4: nối provider (P3) + crawl runtime (P4) + observation (P5) thành một
   * đường chạy. Chỉ được gọi TAY qua `npm run shipinfo:poc` — không scheduler,
   * không cron, không bulk crawl.
   */
  collectVesselObservations: CollectVesselObservations;
  /** Manual use case; container chỉ đăng ký, không tự resolve hay gọi provider. */
  resolveAndStoreCurrentVessel: ResolveAndStoreCurrentVessel;
  /**
   * P9.4: vòng acquisition free CÓ CHẶN — local-first, tối đa 2 lần chạm nguồn,
   * KHÔNG nguồn trả tiền. Chỉ gọi TAY qua `npm run acquire:free:poc`.
   */
  acquireFreeVesselData: AcquireFreeVesselData;
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

  // 5.5) Canonical current (P8.5). Chỉ có use case manual sử dụng dependency
  // này; khởi tạo không crawl, không resolve và không ghi legacy collection.
  const currentVesselRepository: ICurrentVesselRepository = config.mongoUri
    ? new MongoCurrentVesselRepository()
    : new InMemoryCurrentVesselRepository();
  const resolveAndStoreCurrentVessel = new ResolveAndStoreCurrentVessel({
    resolve: new ResolveCurrentVessel({ repository: observationRepository }),
    repository: currentVesselRepository,
  });

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

  // 7) ShipFinder (P7.4). Cũng đăng ký TRƠ; mọi request đi qua P4 y như ShipInfo.
  //    Timeout lấy từ chính runtime config để hai chỗ không trôi khỏi nhau.
  //    `sourceUtcOffsetMinutes` đến từ .env — KHÔNG có mặc định: chưa khai thì
  //    ShipFinder không phát nhóm position (xem AppConfig).
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

  // 8) Acquisition free (P9.2–P9.4). Đăng ký TRƠ: dựng xong không đọc, không
  //    ghi, không chạm mạng. Chỉ chạy khi có người gọi tay qua
  //    `npm run acquire:free:poc`. Không scheduler, không cron, không queue.
  const acquireFreeVesselData = new AcquireFreeVesselData({
    checkLocal: new CheckLocalVesselSufficiency({ repository: currentVesselRepository }),
    selector: new FreeSourceSelector(),
    collect: collectVesselObservations,
    resolveAndStore: resolveAndStoreCurrentVessel,
    // CHỈ ĐỌC sức khoẻ. `getHealth` tạo runtime lười và NÉM với nguồn không đi
    // qua crawl runtime (AISStream là stream dài hạn, UNKNOWN không phải nguồn
    // thật). Selector không bao giờ hỏi tới chúng — chúng rớt từ cổng chi phí —
    // nhưng chặn ở đây để một lần đổi thứ tự cổng sau này không làm nổ tiến trình.
    healthOf: (source) =>
      usesCrawlRuntime(source)
        ? crawlRuntime.getHealth(source).state
        : SourceHealthState.DISABLED,
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
    currentVesselRepository,
    observationRecorder,
    collectVesselObservations,
    resolveAndStoreCurrentVessel,
    acquireFreeVesselData,
  };
}
