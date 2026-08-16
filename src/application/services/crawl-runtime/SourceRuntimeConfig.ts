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

import { VesselSource } from "../../../domain/enums/VesselSource";

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
  // ShipInfo — số liệu lấy từ đo đạc thật (docs/sources/SHIPINFO_AUDIT.md §6):
  //   • trang tàu nặng 250–295 KB, server Apache/PHP mỏng (input xấu -> fatal
  //     error "memory exhausted") -> timeout rộng hơn mặc định.
  //   • nghỉ dài hơn mặc định: không quan sát thấy rate-limit ở nhịp 1 req/2–4s,
  //     nhưng KHÔNG dò ngưỡng nên phải nhường về phía an toàn.
  //   • maxRetries thấp: trang nặng, thử lại tốn nhiều mà cơ hội khác lần đầu ít.
  //   • cooldown dài gấp 3 mặc định: nguồn không công bố hạn mức nào, bị chặn
  //     rồi thì im lặng lâu là phản ứng đúng.
  // Mục tiêu POC là crawl LỊCH SỰ, không phải thông lượng.
  [VesselSource.SHIPINFO]: Object.freeze({
    maxConcurrency: 1,
    minDelayMs: 3000,
    maxDelayMs: 8000,
    timeoutMs: 20_000,
    maxRetries: 1,
    initialBackoffMs: 5000,
    maxBackoffMs: 30_000,
    consecutiveFailuresBeforeCooldown: 3,
    cooldownMs: 15 * 60 * 1000,
  }),
  // ShipFinder — số liệu từ audit P7.1 (docs/sources/SHIPFINDER_AUDIT.md §"Anti-bot"):
  //   • trang chi tiết chỉ ~59 KB (nhẹ hơn ShipInfo ~5 lần) -> timeout 15s là đủ
  //     rộng; không cần 20s như ShipInfo.
  //   • ~30 request ở nhịp 2–4s KHÔNG gặp 403/429, robots.txt `Allow: /` và
  //     không có Crawl-delay. Nhưng CỐ Ý không dò ngưỡng, nên vẫn giữ nhịp nghỉ
  //     y như ShipInfo: nhường về phía an toàn thay vì tối ưu thông lượng.
  //   • maxRetries 1: trang server-render, hỏng lần đầu thì lần hai hiếm khác.
  //   • cooldown 15 phút: nguồn không công bố hạn mức nào.
  [VesselSource.SHIPFINDER]: Object.freeze({
    maxConcurrency: 1,
    minDelayMs: 3000,
    maxDelayMs: 8000,
    timeoutMs: 15_000,
    maxRetries: 1,
    initialBackoffMs: 5000,
    maxBackoffMs: 30_000,
    consecutiveFailuresBeforeCooldown: 3,
    cooldownMs: 15 * 60 * 1000,
  }),
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
