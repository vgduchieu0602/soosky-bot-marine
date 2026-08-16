// ============================================================================
//  APPLICATION · SourceRequestExecutor — chạy MỘT callback mạng cho an toàn
// ----------------------------------------------------------------------------
//  Đây là tầng CHÍNH SÁCH. Nó không biết Vessel, MMSI, IMO, MongoDB,
//  ProviderRegistry, resolver, FE hay Marine là gì. Nó nhận một callback và
//  bọc quanh callback đó: cổng cooldown, hàng đợi, nhịp nghỉ, timeout, phân
//  loại lỗi, retry, cập nhật health.
//
//      await executor.execute(() => httpClient.getText(url))
//
//  RETRY CHỈ Ở ĐÂY. HttpClient là transport thuần (nó vẫn giữ timeout riêng của
//  nó, nhưng KHÔNG retry) — hai nơi cùng retry sẽ nhân số request lên bội số mà
//  không ai nhìn thấy. Xem CRAWL_RUNTIME.md §9.
//
//  Thứ tự có chủ ý: retry nằm NGOÀI limiter. Mỗi lần thử tự xin slot lại, nên
//  khoảng backoff KHÔNG giữ chỗ của request khác.
// ============================================================================

import { VesselSource } from "../../../domain/enums/VesselSource";
import {
  SourceErrorCategory,
  SourceRequestError,
  SourceUnavailableError,
  classifyError,
} from "./SourceError";
import { SourceHealthSnapshot, SourceHealthTracker } from "./SourceHealthTracker";
import { SourceRequestLimiter } from "./SourceRequestLimiter";
import { DEFAULT_RETRY_POLICY, RetryPolicy, backoffDelayMs, isRetryableCategory } from "./retryPolicy";
import { SourceRuntimeConfig } from "./SourceRuntimeConfig";

/**
 * Callback được nhận một AbortSignal đã gắn timeout của runtime.
 * Transport nào hỗ trợ signal thì huỷ được thật; transport không hỗ trợ (VD
 * HttpClient hiện tại, tự quản timeout riêng) thì bỏ qua — executor vẫn dừng
 * chờ đúng hạn, chỉ là request nền chưa bị cắt.
 */
export type SourceTask<T> = (signal: AbortSignal) => Promise<T>;

export interface SourceRequestExecutorDeps {
  source: VesselSource;
  config: SourceRuntimeConfig;
  limiter: SourceRequestLimiter;
  health: SourceHealthTracker;
  retryPolicy?: RetryPolicy;
  /** Mặc định setTimeout thật. Test tiêm hàm trả về ngay + ghi lại ms. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface ExecuteOptions {
  /** Nhãn cho log/lỗi, VD "getDetails". Không ảnh hưởng chính sách. */
  operation?: string;
  /** Ghi đè timeout cho riêng lần gọi này (VD tải binary lớn). */
  timeoutMs?: number;
}

const realSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export class SourceRequestExecutor {
  readonly source: VesselSource;
  private readonly config: SourceRuntimeConfig;
  private readonly limiter: SourceRequestLimiter;
  private readonly health: SourceHealthTracker;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(deps: SourceRequestExecutorDeps) {
    this.source = deps.source;
    this.config = deps.config;
    this.limiter = deps.limiter;
    this.health = deps.health;
    this.retryPolicy = deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.sleep = deps.sleep ?? realSleep;
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
  }

  getHealth(): SourceHealthSnapshot {
    return this.health.snapshot();
  }

  /**
   * @throws SourceUnavailableError khi nguồn đang cooldown/bị tắt — FAIL FAST,
   *         không ngủ chờ hết cooldown và không chạm mạng.
   * @throws SourceRequestError đã phân loại khi hết lượt thử.
   */
  async execute<T>(task: SourceTask<T>, options: ExecuteOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const maxAttempts = this.config.maxRetries + 1;
    let attempt = 0;

    for (;;) {
      // Kiểm lại mỗi vòng: một request song song có thể vừa làm nguồn cooldown.
      this.assertAvailable();

      const startedAt = this.now();
      try {
        const value = await this.limiter.run(() => this.runWithTimeout(task, timeoutMs));
        this.health.recordSuccess(this.now() - startedAt);
        return value;
      } catch (err) {
        const category = classifyError(err);
        attempt += 1;

        // "Không có tàu này" là câu trả lời hợp lệ của nguồn khoẻ mạnh.
        if (category === SourceErrorCategory.NOT_FOUND) {
          this.health.recordNotFound();
          throw this.wrap(err, category, attempt, options.operation);
        }

        this.health.recordFailure(category);

        const canRetry =
          attempt < maxAttempts && isRetryableCategory(category, this.retryPolicy);
        if (!canRetry) {
          throw this.wrap(err, category, attempt, options.operation);
        }

        // Hỏng lần này có thể vừa đẩy nguồn vào cooldown -> đừng ngủ vô ích.
        this.assertAvailable();
        await this.sleep(backoffDelayMs(attempt - 1, this.config, this.random));
      }
    }
  }

  /** Cổng chặn: cooldown / disabled -> ném ngay, chưa chạm mạng. */
  private assertAvailable(): void {
    if (this.health.isInCooldown()) {
      throw new SourceUnavailableError({
        code: "SOURCE_COOLDOWN",
        source: this.source,
        retryAt: this.health.getCooldownUntil(),
      });
    }
    if (!this.health.isAvailable()) {
      throw new SourceUnavailableError({ code: "SOURCE_DISABLED", source: this.source });
    }
  }

  /**
   * Chạy task với hạn giờ. Luôn `clearTimeout` -> không giữ tiến trình sống.
   * Task không tôn trọng signal thì vẫn chạy nền, nhưng executor đã đi tiếp —
   * đó là đánh đổi có ý thức để không phụ thuộc transport cụ thể.
   */
  private async runWithTimeout<T>(task: SourceTask<T>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(this.timeoutError(timeoutMs));
      }, timeoutMs);
    });

    try {
      return await Promise.race([task(controller.signal), timeout]);
    } catch (err) {
      // Task nghe signal và tự reject bằng lỗi riêng của nó thì lỗi ĐÓ về đích
      // trước. Nhưng nguyên nhân gốc vẫn là ta hết giờ và huỷ -> phải báo
      // TIMEOUT, không để nó bị xếp nhầm thành UNKNOWN (và mất quyền retry).
      if (timedOut) throw this.timeoutError(timeoutMs);
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private timeoutError(timeoutMs: number): Error {
    const error = new Error(`Nguồn "${this.source}" không phản hồi trong ${timeoutMs}ms`);
    error.name = "TimeoutError";
    return error;
  }

  /**
   * Luôn bọc lại: thông điệp lỗi có định dạng thống nhất `[CATEGORY] source.op`
   * và `attempts` luôn đúng. Lỗi gốc giữ nguyên trong `cause`.
   */
  private wrap(
    err: unknown,
    category: SourceErrorCategory,
    attempts: number,
    operation?: string
  ): SourceRequestError {
    const detail = err instanceof Error ? err.message : String(err);
    const label = operation ? `${this.source}.${operation}` : this.source;
    return new SourceRequestError({
      category,
      source: this.source,
      message: `[${category}] ${label}: ${detail}`,
      attempts,
      cause: err,
    });
  }
}
