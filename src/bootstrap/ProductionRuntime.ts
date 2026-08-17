// ============================================================================
//  BOOTSTRAP · ProductionRuntime — one process lifecycle owner
// ----------------------------------------------------------------------------
//  Mongo -> dependencies/workers -> READY
//  stop schedulers -> stop AIS/reconnect -> drain -> close Mongo
//
//  This is lifecycle orchestration only. It contains no acquisition, mapping,
//  persistence, or resolver business rules.
// ============================================================================

export const ProductionRuntimeStatus = {
  STARTING: "STARTING",
  READY: "READY",
  DEGRADED: "DEGRADED",
  STOPPING: "STOPPING",
  STOPPED: "STOPPED",
} as const;

export type ProductionRuntimeStatus =
  (typeof ProductionRuntimeStatus)[keyof typeof ProductionRuntimeStatus];

export interface ProductionRuntimeWorker {
  start(): void | Promise<void>;
  stop(): Promise<void>;
  health?(): { connected?: boolean; pending?: number; [key: string]: unknown };
  stats?(): Record<string, unknown>;
}

export interface ProductionRuntimeWorkers {
  /** Work generators are stopped first so no new work enters the pipeline. */
  schedulers: readonly ProductionRuntimeWorker[];
  /** Stop must cancel reconnects and drain its final bounded batch. */
  ais?: ProductionRuntimeWorker;
}

export interface ProductionRuntimeOptions {
  connectMongo: () => Promise<void>;
  buildWorkers: () => Promise<ProductionRuntimeWorkers>;
  disconnectMongo: () => Promise<void>;
  shutdownTimeoutMs: number;
  logger?: { info(message: string): void; warn(message: string): void };
  memoryUsage?: () => NodeJS.MemoryUsage;
}

export interface ProductionRuntimeHealth {
  readonly status: ProductionRuntimeStatus;
  readonly mongo: { readonly connected: boolean };
  readonly ais: { readonly enabled: boolean; readonly connected: boolean; readonly pending: number };
  readonly workers: { readonly schedulers: number };
  readonly memory: NodeJS.MemoryUsage;
}

export class ProductionRuntime {
  private readonly options: ProductionRuntimeOptions;
  private readonly logger: { info(message: string): void; warn(message: string): void };
  private readonly memoryUsage: () => NodeJS.MemoryUsage;
  private status: ProductionRuntimeStatus = ProductionRuntimeStatus.STOPPED;
  private mongoConnected = false;
  private workers: ProductionRuntimeWorkers | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(options: ProductionRuntimeOptions) {
    if (!Number.isFinite(options.shutdownTimeoutMs) || options.shutdownTimeoutMs < 1) {
      throw new Error(`shutdownTimeoutMs must be positive, received ${options.shutdownTimeoutMs}`);
    }
    this.options = options;
    this.logger = options.logger ?? { info: (message) => console.log(message), warn: (message) => console.warn(message) };
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
  }

  start(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise.then(() => this.start());
    if (this.startPromise !== null) return this.startPromise;
    if (this.status === ProductionRuntimeStatus.READY || this.status === ProductionRuntimeStatus.DEGRADED) {
      return Promise.resolve();
    }
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    if (this.status === ProductionRuntimeStatus.STOPPED) return Promise.resolve();
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  health(): ProductionRuntimeHealth {
    const aisHealth = this.workers?.ais?.health?.() ?? {};
    const aisEnabled = this.workers?.ais !== undefined;
    const aisConnected = aisHealth.connected === true;
    const status =
      this.status === ProductionRuntimeStatus.READY && aisEnabled && !aisConnected
        ? ProductionRuntimeStatus.DEGRADED
        : this.status;
    return {
      status,
      mongo: { connected: this.mongoConnected },
      ais: { enabled: aisEnabled, connected: aisConnected, pending: Number(aisHealth.pending ?? 0) },
      workers: { schedulers: this.workers?.schedulers.length ?? 0 },
      memory: this.memoryUsage(),
    };
  }

  stats(): Record<string, unknown> {
    return {
      ...this.health(),
      ais: this.workers?.ais?.stats?.() ?? null,
      schedulers: this.workers?.schedulers.map((worker) => worker.stats?.() ?? {}) ?? [],
    };
  }

  private async startInternal(): Promise<void> {
    this.status = ProductionRuntimeStatus.STARTING;
    try {
      await this.options.connectMongo();
      this.mongoConnected = true;
      this.workers = await this.options.buildWorkers();
      await this.workers.ais?.start();
      for (const scheduler of this.workers.schedulers) await scheduler.start();
      this.status = ProductionRuntimeStatus.READY;
      this.logger.info("[runtime] READY");
    } catch (error) {
      this.status = ProductionRuntimeStatus.DEGRADED;
      await this.closeMongoSafely();
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    // A signal during startup must not close Mongo while dependency construction
    // is still creating workers. Finish (or observe failure of) that attempt,
    // then apply the normal stop order exactly once.
    await this.startPromise?.catch(() => undefined);
    this.status = ProductionRuntimeStatus.STOPPING;
    const graceful = (async (): Promise<void> => {
      const workers = this.workers;
      if (workers !== null) {
        for (const scheduler of workers.schedulers) await scheduler.stop();
        await workers.ais?.stop();
      }
      await this.closeMongoSafely();
      this.status = ProductionRuntimeStatus.STOPPED;
      this.logger.info("[runtime] STOPPED");
    })();

    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        graceful,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("runtime shutdown deadline exceeded")),
            this.options.shutdownTimeoutMs
          );
        }),
      ]);
    } catch (error) {
      this.logger.warn(`[runtime] ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  private async closeMongoSafely(): Promise<void> {
    if (!this.mongoConnected) return;
    await this.options.disconnectMongo();
    this.mongoConnected = false;
  }
}
