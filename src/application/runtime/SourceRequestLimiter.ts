// ============================================================================
//  APPLICATION · SourceRequestLimiter — hàng đợi RIÊNG cho MỘT nguồn
// ----------------------------------------------------------------------------
//  Mỗi nguồn một limiter. KHÔNG có limiter toàn cục: ShipInfo chậm không được
//  phép làm BoatNerd đứng chờ. Đây là lý do limiter nhận `source` và runtime
//  manager giữ Map<VesselSource, limiter>.
//
//  Hai ràng buộc:
//    1. Tối đa `maxConcurrency` request đang chạy cùng lúc.
//    2. Hai lần BẮT ĐẦU liên tiếp cách nhau một khoảng ngẫu nhiên trong
//       [minDelayMs, maxDelayMs] — nhịp đều tăm tắp là dấu hiệu máy móc.
//
//  Không dùng thư viện ngoài (Bottleneck/PQueue): một hàng đợi + một bộ đếm là
//  đủ, thêm dependency chỉ để làm việc này là không đáng.
//
//  sleep/now/random đều tiêm được -> unit test không ngủ thật.
// ============================================================================

import { VesselSource } from "../../domain/value-objects/VesselSource";
import { SourceRuntimeConfig } from "./SourceRuntimeConfig";

export interface SourceRequestLimiterDeps {
  source: VesselSource;
  config: SourceRuntimeConfig;
  /** Mặc định setTimeout thật. Test tiêm hàm trả về ngay. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** [0,1). Mặc định Math.random. */
  random?: () => number;
}

const realSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export class SourceRequestLimiter {
  readonly source: VesselSource;
  private readonly config: SourceRuntimeConfig;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  private active = 0;
  private readonly waiting: Array<() => void> = [];
  /** Mốc sớm nhất được phép BẮT ĐẦU request kế tiếp (ms epoch). */
  private nextStartAt = 0;

  constructor(deps: SourceRequestLimiterDeps) {
    this.source = deps.source;
    this.config = deps.config;
    this.sleep = deps.sleep ?? realSleep;
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
  }

  /** Chạy `task` dưới ràng buộc concurrency + nhịp nghỉ của nguồn này. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await this.pace();
      return await task();
    } finally {
      this.release();
    }
  }

  /** Số request đang chạy — dùng cho test/observability. */
  get activeCount(): number {
    return this.active;
  }

  /** Số request đang xếp hàng. */
  get pendingCount(): number {
    return this.waiting.length;
  }

  private acquire(): Promise<void> {
    if (this.active < this.config.maxConcurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }

  /**
   * Chờ tới lượt theo nhịp, rồi ĐẶT TRƯỚC mốc cho request kế tiếp.
   * Đặt trước (chứ không đặt sau khi task xong) để nhiều slot đồng thời vẫn
   * bị giãn ra, không cùng bắn một lúc.
   */
  private async pace(): Promise<void> {
    const wait = this.nextStartAt - this.now();
    if (wait > 0) await this.sleep(wait);
    this.nextStartAt = this.now() + this.nextDelayMs();
  }

  /** Ngẫu nhiên trong [minDelayMs, maxDelayMs]. min === max -> cố định. */
  private nextDelayMs(): number {
    const { minDelayMs, maxDelayMs } = this.config;
    if (maxDelayMs <= minDelayMs) return minDelayMs;
    return minDelayMs + this.random() * (maxDelayMs - minDelayMs);
  }
}
