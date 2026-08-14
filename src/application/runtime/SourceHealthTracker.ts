// ============================================================================
//  APPLICATION · SourceHealthTracker — nguồn này còn khoẻ không
// ----------------------------------------------------------------------------
//  Audit A0 (D-11): hệ thống hiện KHÔNG có metric nào. Parse fail bị nuốt,
//  desync chỉ warn một dòng. Multi-source mà không đo được thì không so sánh
//  được chất lượng giữa các nguồn.
//
//  Giữ trong RAM. P4 KHÔNG ghi MongoDB — persist hay không là quyết định của
//  phase sau (xem CRAWL_RUNTIME.md §8).
//
//  KHÔNG có background timer: cooldown hết hạn được phát hiện LÚC CÓ NGƯỜI HỎI,
//  không phải bằng setInterval chạy nền. Tiến trình không bị giữ sống vô cớ.
// ============================================================================

import { VesselSource } from "../../domain/value-objects/VesselSource";
import { SourceErrorCategory } from "./SourceError";
import { SourceRuntimeConfig } from "./SourceRuntimeConfig";

export const SourceHealthState = {
  /** Lần gần nhất thành công, không có chuỗi hỏng. */
  HEALTHY: "HEALTHY",
  /** Có hỏng nhưng chưa đủ ngưỡng hạ nhiệt — vẫn được gọi. */
  DEGRADED: "DEGRADED",
  /** Hỏng liên tiếp quá ngưỡng — CHẶN request tới khi hết hạn. */
  COOLDOWN: "COOLDOWN",
  /** Tắt thủ công. Chỉ người vận hành bật lại được. */
  DISABLED: "DISABLED",
} as const;

export type SourceHealthState = (typeof SourceHealthState)[keyof typeof SourceHealthState];

export interface SourceHealthSnapshot {
  readonly source: VesselSource;
  readonly state: SourceHealthState;

  readonly totalRequests: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly consecutiveFailures: number;

  readonly notFoundCount: number;
  readonly timeoutCount: number;
  readonly blockedCount: number;
  readonly rateLimitedCount: number;
  readonly serverErrorCount: number;
  readonly networkErrorCount: number;
  readonly parseErrorCount: number;
  readonly unknownErrorCount: number;

  readonly lastSuccessAt?: Date;
  readonly lastFailureAt?: Date;
  readonly cooldownUntil?: Date;

  /** Trung bình cộng độ trễ của các lần THÀNH CÔNG. Chưa có -> 0. */
  readonly averageLatencyMs: number;
}

export interface SourceHealthTrackerDeps {
  source: VesselSource;
  config: SourceRuntimeConfig;
  /** Tiêm được để test không phụ thuộc đồng hồ thật. */
  now?: () => Date;
}

/** Category -> tên bộ đếm trong snapshot. */
const COUNTER_BY_CATEGORY: Readonly<Record<SourceErrorCategory, keyof MutableCounters>> =
  Object.freeze({
    [SourceErrorCategory.NOT_FOUND]: "notFoundCount",
    [SourceErrorCategory.TIMEOUT]: "timeoutCount",
    [SourceErrorCategory.BLOCKED]: "blockedCount",
    [SourceErrorCategory.RATE_LIMITED]: "rateLimitedCount",
    [SourceErrorCategory.SERVER_ERROR]: "serverErrorCount",
    [SourceErrorCategory.NETWORK_ERROR]: "networkErrorCount",
    [SourceErrorCategory.PARSE_ERROR]: "parseErrorCount",
    [SourceErrorCategory.UNKNOWN]: "unknownErrorCount",
  });

interface MutableCounters {
  notFoundCount: number;
  timeoutCount: number;
  blockedCount: number;
  rateLimitedCount: number;
  serverErrorCount: number;
  networkErrorCount: number;
  parseErrorCount: number;
  unknownErrorCount: number;
}

export class SourceHealthTracker {
  private readonly source: VesselSource;
  private readonly config: SourceRuntimeConfig;
  private readonly now: () => Date;

  private state: SourceHealthState = SourceHealthState.HEALTHY;
  private totalRequests = 0;
  private successCount = 0;
  private failureCount = 0;
  private consecutiveFailures = 0;
  private latencySum = 0;
  private lastSuccessAt?: Date;
  private lastFailureAt?: Date;
  private cooldownUntil?: Date;
  private readonly counters: MutableCounters = {
    notFoundCount: 0,
    timeoutCount: 0,
    blockedCount: 0,
    rateLimitedCount: 0,
    serverErrorCount: 0,
    networkErrorCount: 0,
    parseErrorCount: 0,
    unknownErrorCount: 0,
  };

  constructor(deps: SourceHealthTrackerDeps) {
    this.source = deps.source;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
  }

  /** Reset chuỗi hỏng, cập nhật độ trễ, quay lại HEALTHY (trừ khi bị tắt tay). */
  recordSuccess(latencyMs: number): void {
    this.totalRequests += 1;
    this.successCount += 1;
    this.consecutiveFailures = 0;
    if (Number.isFinite(latencyMs) && latencyMs >= 0) this.latencySum += latencyMs;
    this.lastSuccessAt = this.now();
    this.cooldownUntil = undefined;
    if (this.state !== SourceHealthState.DISABLED) {
      this.state = SourceHealthState.HEALTHY;
    }
  }

  /**
   * "Nguồn không có tàu này" — nguồn TRẢ LỜI ĐÚNG, chỉ là câu trả lời rỗng.
   * KHÔNG tăng chuỗi hỏng, KHÔNG kích hoạt cooldown. Tra 500 mmsi lạ không
   * được phép làm một nguồn khoẻ bị khoá.
   */
  recordNotFound(): void {
    this.totalRequests += 1;
    this.counters.notFoundCount += 1;
  }

  /** Hỏng thật. Đủ ngưỡng liên tiếp -> COOLDOWN, chưa đủ -> DEGRADED. */
  recordFailure(category: SourceErrorCategory): void {
    if (category === SourceErrorCategory.NOT_FOUND) {
      this.recordNotFound();
      return;
    }

    this.totalRequests += 1;
    this.failureCount += 1;
    this.consecutiveFailures += 1;
    this.counters[COUNTER_BY_CATEGORY[category]] += 1;
    this.lastFailureAt = this.now();

    if (this.state === SourceHealthState.DISABLED) return;

    if (this.consecutiveFailures >= this.config.consecutiveFailuresBeforeCooldown) {
      this.enterCooldown();
    } else {
      this.state = SourceHealthState.DEGRADED;
    }
  }

  /** Hạ nhiệt thủ công (VD nguồn báo Retry-After). */
  enterCooldown(durationMs: number = this.config.cooldownMs): void {
    if (this.state === SourceHealthState.DISABLED) return;
    this.state = SourceHealthState.COOLDOWN;
    this.cooldownUntil = new Date(this.now().getTime() + durationMs);
  }

  /** Tắt/bật thủ công. DISABLED không tự thoát bằng thời gian. */
  disable(): void {
    this.state = SourceHealthState.DISABLED;
    this.cooldownUntil = undefined;
  }

  enable(): void {
    if (this.state !== SourceHealthState.DISABLED) return;
    this.state = SourceHealthState.DEGRADED;
    this.consecutiveFailures = 0;
  }

  /**
   * Trạng thái HIỆN TẠI. Đây là nơi cooldown hết hạn được phát hiện: COOLDOWN
   * quá hạn -> DEGRADED (được thử lại, nhưng chưa coi là khoẻ cho tới khi có
   * một lần thành công thật).
   */
  getState(): SourceHealthState {
    if (
      this.state === SourceHealthState.COOLDOWN &&
      this.cooldownUntil !== undefined &&
      this.now().getTime() >= this.cooldownUntil.getTime()
    ) {
      this.state = SourceHealthState.DEGRADED;
      this.cooldownUntil = undefined;
    }
    return this.state;
  }

  isInCooldown(): boolean {
    return this.getState() === SourceHealthState.COOLDOWN;
  }

  /** Có được phép gửi request lúc này không. */
  isAvailable(): boolean {
    const state = this.getState();
    return state !== SourceHealthState.COOLDOWN && state !== SourceHealthState.DISABLED;
  }

  getCooldownUntil(): Date | undefined {
    this.getState(); // dọn cooldown đã hết hạn trước khi trả lời
    return this.cooldownUntil;
  }

  snapshot(): SourceHealthSnapshot {
    return Object.freeze({
      source: this.source,
      state: this.getState(),
      totalRequests: this.totalRequests,
      successCount: this.successCount,
      failureCount: this.failureCount,
      consecutiveFailures: this.consecutiveFailures,
      ...this.counters,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      cooldownUntil: this.cooldownUntil,
      averageLatencyMs: this.successCount === 0 ? 0 : this.latencySum / this.successCount,
    });
  }
}
