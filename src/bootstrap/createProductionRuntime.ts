import { config } from "../config";
import { assertProductionDatabase } from "../config/databaseSafety";
import { MARITIME_REGIONS } from "../config/maritimeRegions";
import { AdaptiveRegionScheduler } from "../infrastructure/scheduler/AdaptiveRegionScheduler";
import { MongoCrawlRegionStateRepository } from "../infrastructure/persistence/mongo/MongoCrawlRegionStateRepository";
import { VesselSource } from "../domain/enums/VesselSource";
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
      console.log(`[bot] Region poll       : ${Math.round(config.regionPollMs / 1000)}s`);
      console.log(`[bot] Adaptive crawler  : ${config.adaptiveCrawlerEnabled ? "enabled" : "disabled (set ADAPTIVE_CRAWLER_ENABLED=true)"}`);
      console.log(`[bot] VesselFinder      : enabled`);
      console.log(`[bot] AIS               : ${config.botAisEnabled ? "ON" : "OFF"}`);
      console.log(`[bot] Paid              : ${config.paidFallbackEnabled ? "ON" : "OFF"}`);
      await connectMongo(config.mongoUri);
    },
    buildWorkers: async () => {
      const container = await buildContainer({ connectMongo: false });
      const schedulerInstances: IntervalScheduler[] = [];

      // ---- vòng quét vùng thích ứng --------------------------------------
      // MỘT instance duy nhất cho mỗi tiến trình (§8). Nó KHÔNG tự crawl theo
      // nhịp poll: poll chỉ hỏi "có vùng nào tới hạn chưa", còn traffic thật
      // vẫn do `nextScanAt` của từng vùng quyết định (§7).
      if (config.adaptiveCrawlerEnabled) {
        const provider = container.providerRegistry.get(VesselSource.VESSELFINDER);
        if (provider?.scanArea === undefined) {
          throw new Error("VesselFinder provider with scanArea is required for the adaptive crawler.");
        }
        const adaptive = new AdaptiveRegionScheduler({
          provider,
          runtime: container.crawlRuntime,
          recorder: container.observationRecorder,
          resolveAndStore: container.resolveAndStoreCurrentVessel,
          regionStates: new MongoCrawlRegionStateRepository(),
          currentVesselRepository: container.currentVesselRepository,
          completeBasics: container.completeVesselBasics,
        });
        schedulerInstances.push(
          new IntervalScheduler({
            label: "adaptive region scan",
            everyMs: config.regionPollMs,
            task: async () => { await adaptive.tick(); },
          })
        );
      }

      // ---- watchlist (đường LEGACY) ---------------------------------------
      // Chỉ chạy khi thực sự có tàu được theo dõi. Nó dùng đường legacy và ghi
      // vào `vessels`/`latestpositions`, đồng thời cũng gọi VesselFinder — tức
      // là TRÙNG traffic với vòng quét vùng. Xem báo cáo §9: để WATCHLIST rỗng
      // khi bật adaptive, trừ khi thực sự cần theo dõi tàu chỉ định.
      if (config.watchlist.length > 0) {
        schedulerInstances.push(
          new IntervalScheduler({
            label: "crawl watchlist",
            everyMs: config.crawlEveryMs,
            task: async () => {
              const ids = await container.manageWatchlist.list();
              if (ids.length > 0) await container.crawlFleetPositions.execute(ids);
            },
          })
        );
      }

      schedulerInstances.push(
        new IntervalScheduler({
          label: "cleanup stale positions",
          everyMs: config.positionCleanupEveryMs,
          task: async () => { await container.cleanupStalePositions.execute(); },
        })
      );

      const schedulers = schedulerInstances.map((scheduler) => ({
        start: () => scheduler.start(),
        stop: () => scheduler.stop(),
        stats: () => scheduler.getStats(),
      }));

      // The bot never owns the paid upstream AISStream connection.  Its
      // optional client is useful only for explicit canonical-ingestion tests
      // and staging; default production deployment leaves it disabled.
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
