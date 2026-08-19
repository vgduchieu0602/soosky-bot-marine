import { config } from "../config";
import { assertProductionDatabase } from "../config/databaseSafety";
import { MARITIME_REGIONS } from "../config/maritimeRegions";
import { createAdaptiveRegionWorker, REGION_DUE_CHECK_EVERY_MS } from "./createAdaptiveRegionWorker";
import { MarineAisIngestionCoordinator } from "../infrastructure/integrations/marine-ais/MarineAisIngestionCoordinator";
import { MarineAisLifecycleState, MarineAisWebSocketClient } from "../infrastructure/integrations/marine-ais/MarineAisWebSocketClient";
import { connectMongo, disconnectMongo } from "../infrastructure/persistence/mongo/connection";
import { IntervalScheduler } from "../infrastructure/scheduler/IntervalScheduler";
import { AisCoalescingBuffer } from "../application/services/ingestion/AisCoalescingBuffer";
import { buildContainer } from "./container";
import { ProductionRuntime } from "./ProductionRuntime";

/** Builds the single production bot process. No HTTP server is started here. */
export function createProductionRuntime(): ProductionRuntime {
  return new ProductionRuntime({
    connectMongo: async () => {
      if (!config.mongoUri) {
        throw new Error("MONGODB_URI is required for the production runtime; JSON fallback is for legacy/dev only.");
      }
      // §13: production ĐƯỢC PHÉP chạm DB production, nên KHÔNG gọi
      // `assertSafeBotDatabase(proofMode: true)` ở đây. Nhưng vẫn bắt buộc URI
      // phải nói rõ tên database — im lặng rơi về default là cách nhanh nhất
      // để ghi nhầm chỗ.
      const { dbName: database } = assertProductionDatabase(config.mongoUri);
      const kind = /mongodb\.net/i.test(config.mongoUri) ? "Atlas" : "local";
      console.log(`[bot] production runtime started`);
      console.log(`[bot] Mongo             : ${database} (${kind})`);
      console.log(`[bot] Adaptive regions  : ${config.adaptiveCrawlerEnabled ? MARITIME_REGIONS.length : 0}`);
      console.log(`[bot] Region due check  : ${Math.round(REGION_DUE_CHECK_EVERY_MS / 1000)}s (not the scan interval)`);
      console.log(`[bot] Adaptive crawler  : ${config.adaptiveCrawlerEnabled ? "enabled" : "disabled (ADAPTIVE_CRAWLER_ENABLED=false)"}`);
      console.log(`[bot] VesselFinder      : enabled`);
      console.log(`[bot] AIS               : ${config.botAisEnabled ? "ON" : "OFF"}`);
      console.log(`[bot] Paid              : ${config.paidFallbackEnabled ? "ON" : "OFF"}`);
      await connectMongo(config.mongoUri);
    },
    buildWorkers: async () => {
      // `seedWatchlist: false` — bot không còn chạy crawler watchlist, nên
      // không được ghi document legacy nào lúc khởi động (TASK 5).
      const container = await buildContainer({ connectMongo: false, seedWatchlist: false });

      // PHASE 6.2: bot production chỉ chạy MỘT workload — quét vùng thích ứng.
      //
      // `crawl watchlist` và `cleanup stale positions` CỐ Ý không còn tự khởi
      // động ở đây. Cả hai đi đường LEGACY và ghi vào `vessels` /
      // `latestpositions` / `vesselpositions`, tức là dựng song song một pipeline
      // dữ liệu thứ hai bên cạnh canonical trên chính Atlas production. Code của
      // chúng KHÔNG bị xoá — CLI/HTTP còn dùng — chỉ là bot không tự chạy nữa.
      const schedulers = config.adaptiveCrawlerEnabled
        ? [createAdaptiveRegionWorker(container)]
        : [];

      // Bot KHÔNG sở hữu kết nối AISStream trả tiền. Client tuỳ chọn này chỉ
      // hữu ích cho test ingestion canonical và staging; triển khai production
      // mặc định để tắt. Không bật cờ -> KHÔNG mở socket nào.
      if (!config.botAisEnabled || !config.marineAisWsUrl) return { schedulers };

      const client = new MarineAisWebSocketClient({
        url: config.marineAisWsUrl,
        initialReconnectDelayMs: config.aisReconnectInitialMs,
        maxReconnectDelayMs: config.aisReconnectMaxMs,
        reconnectJitterRatio: config.aisReconnectJitterRatio,
      });
      const buffer = new AisCoalescingBuffer({
        maxVessels: config.aisMaxBufferedVessels,
        batchSize: config.aisFlushBatchSize,
      });
      const coordinator = new MarineAisIngestionCoordinator({
        client,
        buffer,
        ingest: container.ingestAisBatch,
        windowMs: config.aisCoalesceWindowMs,
      });
      return {
        schedulers,
        ais: {
          start: () => coordinator.start(),
          stop: () => coordinator.stop(),
          health: () => ({
            connected: client.getLifecycleState() === MarineAisLifecycleState.CONNECTED,
            pending: buffer.pendingCount(),
            state: client.getLifecycleState(),
            lastMessageAt: client.getLastMessageAt(),
          }),
          stats: () => ({
            client: client.getStats(),
            buffer: buffer.getStats(),
            persistence: coordinator.getPersistenceStats(),
          }),
        },
      };
    },
    disconnectMongo: async () => {
      await disconnectMongo();
    },
    shutdownTimeoutMs: config.runtimeShutdownTimeoutMs,
    logger: {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
    },
  });
}
