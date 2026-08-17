import { config } from "../config";
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
      await connectMongo(config.mongoUri);
    },
    buildWorkers: async () => {
      const container = await buildContainer({ connectMongo: false });
      const schedulerInstances = [
        new IntervalScheduler({
          label: "crawl watchlist",
          everyMs: config.crawlEveryMs,
          task: async () => {
            const ids = await container.manageWatchlist.list();
            if (ids.length > 0) await container.crawlFleetPositions.execute(ids);
          },
        }),
        new IntervalScheduler({
          label: "cleanup stale positions",
          everyMs: config.positionCleanupEveryMs,
          task: async () => { await container.cleanupStalePositions.execute(); },
        }),
      ];

      const schedulers = schedulerInstances.map((scheduler) => ({
        start: () => scheduler.start(),
        stop: () => scheduler.stop(),
        stats: () => scheduler.getStats(),
      }));

      if (!config.marineAisWsUrl) return { schedulers };

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
