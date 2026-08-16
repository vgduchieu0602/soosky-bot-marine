// ============================================================================
//  APPLICATION · SourceRuntimeManager — mỗi nguồn một bộ runtime, tạo khi cần
// ----------------------------------------------------------------------------
//  Giữ đúng 3 thứ cho mỗi nguồn: config, limiter, health tracker — và cái
//  executor ghép chúng lại. Không service locator, không DI framework, không
//  đăng ký động. Một Map và một hàm khởi tạo lười.
//
//  Điểm mấu chốt: KHÔNG có limiter dùng chung. ShipInfo hạ nhiệt thì BoatNerd
//  vẫn chạy, vì chúng là hai bộ hoàn toàn tách rời.
// ============================================================================

import { VesselSource } from "../../../domain/enums/VesselSource";
import { SourceHealthSnapshot, SourceHealthTracker } from "./SourceHealthTracker";
import { SourceRequestExecutor } from "./SourceRequestExecutor";
import { SourceRequestLimiter } from "./SourceRequestLimiter";
import { RetryPolicy } from "./retryPolicy";
import {
  SourceRuntimeConfig,
  resolveSourceRuntimeConfig,
  usesCrawlRuntime,
} from "./SourceRuntimeConfig";

export interface SourceRuntimeManagerDeps {
  /** Override config theo nguồn, đến từ composition root. */
  configOverrides?: Partial<Record<VesselSource, Partial<SourceRuntimeConfig>>>;
  retryPolicy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

interface SourceRuntime {
  config: Readonly<SourceRuntimeConfig>;
  limiter: SourceRequestLimiter;
  health: SourceHealthTracker;
  executor: SourceRequestExecutor;
}

export class SourceRuntimeManager {
  private readonly runtimes = new Map<VesselSource, SourceRuntime>();
  private readonly deps: SourceRuntimeManagerDeps;

  constructor(deps: SourceRuntimeManagerDeps = {}) {
    this.deps = deps;
  }

  /**
   * @throws Error với nguồn không dùng crawl runtime (AISSTREAM là stream dài
   *         hạn, UNKNOWN không phải nguồn thật) — im lặng trả về một limiter vô
   *         nghĩa còn tệ hơn.
   */
  getExecutor(source: VesselSource): SourceRequestExecutor {
    return this.getRuntime(source).executor;
  }

  getHealth(source: VesselSource): SourceHealthSnapshot {
    return this.getRuntime(source).health.snapshot();
  }

  getHealthTracker(source: VesselSource): SourceHealthTracker {
    return this.getRuntime(source).health;
  }

  getConfig(source: VesselSource): Readonly<SourceRuntimeConfig> {
    return this.getRuntime(source).config;
  }

  /** Chỉ những nguồn ĐÃ được dùng ít nhất một lần (runtime tạo lười). */
  getAllHealth(): readonly SourceHealthSnapshot[] {
    return Object.freeze(
      [...this.runtimes.values()].map((runtime) => runtime.health.snapshot())
    );
  }

  getInitializedSources(): readonly VesselSource[] {
    return Object.freeze([...this.runtimes.keys()]);
  }

  private getRuntime(source: VesselSource): SourceRuntime {
    const existing = this.runtimes.get(source);
    if (existing) return existing;

    if (!usesCrawlRuntime(source)) {
      throw new Error(
        `Nguồn "${source}" không dùng crawl runtime (stream dài hạn hoặc không phải nguồn thật)`
      );
    }

    const config = resolveSourceRuntimeConfig(source, this.deps.configOverrides?.[source] ?? {});
    const limiter = new SourceRequestLimiter({
      source,
      config,
      sleep: this.deps.sleep,
      now: this.deps.now,
      random: this.deps.random,
    });
    const health = new SourceHealthTracker({
      source,
      config,
      now: this.deps.now ? () => new Date(this.deps.now!()) : undefined,
    });
    const executor = new SourceRequestExecutor({
      source,
      config,
      limiter,
      health,
      retryPolicy: this.deps.retryPolicy,
      sleep: this.deps.sleep,
      now: this.deps.now,
      random: this.deps.random,
    });

    const runtime: SourceRuntime = { config, limiter, health, executor };
    this.runtimes.set(source, runtime);
    return runtime;
  }
}
