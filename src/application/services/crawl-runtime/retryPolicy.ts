// ============================================================================
//  APPLICATION · Retry policy — thử lại CÁI GÌ, và chờ bao lâu
// ----------------------------------------------------------------------------
//  Nguyên tắc: chỉ thử lại khi lần sau CÓ CƠ HỘI khác lần trước.
//
//    TIMEOUT / SERVER_ERROR / NETWORK_ERROR  -> thử lại. Sự cố nhất thời.
//    NOT_FOUND    -> KHÔNG. Tàu không tồn tại thì hỏi 3 lần vẫn không tồn tại.
//    PARSE_ERROR  -> KHÔNG. Tải lại đúng trang HTML đó rồi bóc lại bằng đúng
//                    regex đó sẽ hỏng y hệt. Đây là drift, phải sửa mapper —
//                    xem `npm run check-drift`.
//    BLOCKED(403) -> KHÔNG thử ngay. Nguồn vừa nói "đừng gửi nữa"; gửi tiếp
//                    làm tình hình xấu đi. Đường xử lý đúng là: health ghi nhận
//                    hỏng -> đủ ngưỡng -> COOLDOWN -> dừng hẳn một lúc.
//    RATE_LIMITED(429) -> KHÔNG thử ngay, cùng lý do.
//    UNKNOWN      -> KHÔNG. Không biết là gì thì không đoán.
//
//  Không có thuật toán thích nghi, không học theo thời gian. Nhân đôi + trần.
// ============================================================================

import { SourceErrorCategory } from "./SourceError";
import { SourceRuntimeConfig } from "./SourceRuntimeConfig";

export interface RetryPolicy {
  /** Category được phép thử lại. */
  readonly retryableCategories: ReadonlySet<SourceErrorCategory>;
}

/** Mặc định: chỉ 3 loại sự cố nhất thời. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  retryableCategories: new Set<SourceErrorCategory>([
    SourceErrorCategory.TIMEOUT,
    SourceErrorCategory.SERVER_ERROR,
    SourceErrorCategory.NETWORK_ERROR,
  ]),
});

/**
 * Policy nới lỏng: CHO PHÉP thử lại 429 sau backoff. Chỉ dùng khi nguồn có tài
 * liệu nói rõ hạn mức và ta chắc backoff đủ dài. KHÔNG phải mặc định.
 * 403 vẫn không thử lại — bị chặn khác vượt hạn mức.
 */
export const RETRY_RATE_LIMITED_POLICY: RetryPolicy = Object.freeze({
  retryableCategories: new Set<SourceErrorCategory>([
    ...DEFAULT_RETRY_POLICY.retryableCategories,
    SourceErrorCategory.RATE_LIMITED,
  ]),
});

export function isRetryableCategory(
  category: SourceErrorCategory,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): boolean {
  return policy.retryableCategories.has(category);
}

/**
 * Backoff cho lần thử lại thứ `attempt` (0-based: lần thử lại ĐẦU TIÊN là 0).
 *   initialBackoffMs × 2^attempt, chặn trên maxBackoffMs.
 * Cộng jitter tối đa +25% để nhiều tiến trình cùng hỏng không đồng loạt gọi lại.
 */
export function backoffDelayMs(
  attempt: number,
  config: SourceRuntimeConfig,
  random: () => number = Math.random
): number {
  const exponent = Math.max(0, Math.floor(attempt));
  const raw = config.initialBackoffMs * 2 ** exponent;
  const capped = Math.min(raw, config.maxBackoffMs);
  return capped + capped * 0.25 * random();
}
