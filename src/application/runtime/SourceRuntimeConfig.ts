// ============================================================================
//  APPLICATION · SourceRuntimeConfig — "được phép nện nguồn này mạnh tới đâu"
// ----------------------------------------------------------------------------
//  Audit A0 (CURRENT_ARCHITECTURE.md §6 D-5) ghi nhận: sleep/jitter/cooldown
//  đang bị viết lại RIÊNG trong 4 chỗ (ScanArea, EnrichVesselTypes,
//  CrawlFleetPositions, detectHtmlDrift). Thêm nguồn thứ 3 là bản sao thứ 5.
//  File này gom tham số về một chỗ, MỖI NGUỒN một bộ.
//
//  KHÔNG đọc process.env ở đây. Config đi vào từ composition root — runtime
//  class không được tự quyết định môi trường của nó.
// ============================================================================

import { VesselSource } from "../../domain/value-objects/VesselSource";

export interface SourceRuntimeConfig {
  /** Số request ĐỒNG THỜI tối đa tới nguồn này. */
  maxConcurrency: number;
  /** Nghỉ giữa 2 request, chọn ngẫu nhiên trong [min, max] — nhịp không đều như máy. */
  minDelayMs: number;
  maxDelayMs: number;
  /** Chặn trên cho MỘT lần thử. Hết giờ -> TIMEOUT. */
  timeoutMs: number;
  /** Số lần thử LẠI (0 = chỉ thử một lần). */
  maxRetries: number;
  /** Backoff = initial × 2^attempt, chặn trên maxBackoffMs. */
  initialBackoffMs: number;
  maxBackoffMs: number;
  /** Bao nhiêu lần hỏng LIÊN TIẾP thì hạ nhiệt. */
  consecutiveFailuresBeforeCooldown: number;
  cooldownMs: number;
}

/**
 * Mặc định BẢO THỦ. Đây không phải cấu hình tối ưu — nó là cấu hình khó gây
 * hại nhất khi chưa biết gì về nguồn. Nguồn nào chịu được nhanh hơn thì override.
 */
export const DEFAULT_CRAWL_RUNTIME_CONFIG: Readonly<SourceRuntimeConfig> = Object.freeze({
  maxConcurrency: 1,
  minDelayMs: 2000,
  maxDelayMs: 5000,
  timeoutMs: 10_000,
  maxRetries: 2,
  initialBackoffMs: 1000,
  maxBackoffMs: 10_000,
  consecutiveFailuresBeforeCooldown: 3,
  cooldownMs: 5 * 60 * 1000,
});

/**
 * Override theo nguồn. CỐ Ý gần như rỗng: P4 không có crawler nào cho các nguồn
 * này, nên mọi con số "production thật" ở đây đều là bịa. Điền khi có POC.
 *
 * MYSHIPTRACKING là API TRẢ TIỀN, không phải crawl web -> không áp nhịp nghỉ
 * kiểu chống-ban; giới hạn của nó là hạn mức gọi, không phải rủi ro bị chặn.
 */
export const SOURCE_RUNTIME_OVERRIDES: Readonly<
  Partial<Record<VesselSource, Partial<SourceRuntimeConfig>>>
> = Object.freeze({
  [VesselSource.VESSELFINDER]: Object.freeze({}),
  [VesselSource.SHIPINFO]: Object.freeze({}),
  [VesselSource.SHIPFINDER]: Object.freeze({}),
  [VesselSource.BOATNERD]: Object.freeze({}),
  [VesselSource.SHIPTRAFFIC]: Object.freeze({}),
  [VesselSource.VESSELTRACKER]: Object.freeze({}),
  [VesselSource.MARINETRAFFIC_LIVE]: Object.freeze({}),
  [VesselSource.MYSHIPTRACKING]: Object.freeze({
    minDelayMs: 0,
    maxDelayMs: 0,
    maxRetries: 1,
  }),
});

/**
 * Nguồn KHÔNG đi qua crawl runtime.
 *  • AISSTREAM là stream WebSocket dài hạn, không phải chuỗi request rời rạc —
 *    "nghỉ 2s giữa 2 request" vô nghĩa với nó.
 *  • UNKNOWN không phải nguồn thật.
 */
const SOURCES_WITHOUT_CRAWL_RUNTIME: ReadonlySet<VesselSource> = new Set([
  VesselSource.AISSTREAM,
  VesselSource.UNKNOWN,
]);

export function usesCrawlRuntime(source: VesselSource): boolean {
  return !SOURCES_WITHOUT_CRAWL_RUNTIME.has(source);
}

/**
 * Kiểm mọi ràng buộc. Sai -> ném NGAY lúc dựng, không để giá trị rác (NaN,
 * maxDelay < minDelay) lặng lẽ chạy rồi sinh nhịp nghỉ vô nghĩa.
 */
export function validateSourceRuntimeConfig(config: SourceRuntimeConfig): void {
  const finite = (name: keyof SourceRuntimeConfig): number => {
    const value = config[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`SourceRuntimeConfig.${name} phải là số hữu hạn, nhận ${String(value)}`);
    }
    return value;
  };

  const rules: Array<[keyof SourceRuntimeConfig, (v: number) => boolean, string]> = [
    ["maxConcurrency", (v) => Number.isInteger(v) && v >= 1, "phải là số nguyên >= 1"],
    ["minDelayMs", (v) => v >= 0, "phải >= 0"],
    ["timeoutMs", (v) => v > 0, "phải > 0"],
    ["maxRetries", (v) => Number.isInteger(v) && v >= 0, "phải là số nguyên >= 0"],
    ["initialBackoffMs", (v) => v >= 0, "phải >= 0"],
    ["consecutiveFailuresBeforeCooldown", (v) => Number.isInteger(v) && v >= 1, "phải là số nguyên >= 1"],
    ["cooldownMs", (v) => v >= 0, "phải >= 0"],
  ];

  for (const [name, ok, message] of rules) {
    const value = finite(name);
    if (!ok(value)) throw new Error(`SourceRuntimeConfig.${name} ${message}, nhận ${value}`);
  }

  const minDelay = finite("minDelayMs");
  const maxDelay = finite("maxDelayMs");
  if (maxDelay < minDelay) {
    throw new Error(
      `SourceRuntimeConfig.maxDelayMs (${maxDelay}) phải >= minDelayMs (${minDelay})`
    );
  }

  const initialBackoff = finite("initialBackoffMs");
  const maxBackoff = finite("maxBackoffMs");
  if (maxBackoff < initialBackoff) {
    throw new Error(
      `SourceRuntimeConfig.maxBackoffMs (${maxBackoff}) phải >= initialBackoffMs (${initialBackoff})`
    );
  }
}

/** Ghép default + override theo nguồn + override của người gọi, rồi validate. */
export function resolveSourceRuntimeConfig(
  source: VesselSource,
  overrides: Partial<SourceRuntimeConfig> = {}
): Readonly<SourceRuntimeConfig> {
  const config: SourceRuntimeConfig = {
    ...DEFAULT_CRAWL_RUNTIME_CONFIG,
    ...(SOURCE_RUNTIME_OVERRIDES[source] ?? {}),
    ...overrides,
  };
  validateSourceRuntimeConfig(config);
  return Object.freeze(config);
}
