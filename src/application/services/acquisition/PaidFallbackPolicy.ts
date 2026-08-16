// ============================================================================
//  APPLICATION · Chính sách cổng trả tiền
// ----------------------------------------------------------------------------
//  Mọi ngưỡng ở ĐÂY. Cổng chỉ áp luật, không giữ số.
// ============================================================================

import { VesselFieldGroup } from "../../../domain/enums/VesselField";
import { DEFAULT_POSITION_RESOLVER_POLICY } from "../resolution/PositionResolverPolicy";

const HOUR = 60 * 60 * 1000;

export interface PaidFallbackPolicy {
  /**
   * Số lần gọi nguồn trả tiền tối đa cho MỘT yêu cầu.
   *
   * 1. Endpoint `extended` trả về identity + vị trí + lý lịch + chuyến đi trong
   * MỘT response, nên không có lý do nào để xâu chuỗi nhiều endpoint. Cho phép
   * lần thứ hai chỉ mở đường cho vòng lặp tốn tiền.
   */
  readonly maxPaidAttemptsPerRequest: number;

  /**
   * Cửa sổ chặn sau một lần gọi trả tiền cho CHÍNH con tàu này, nhóm VỊ TRÍ.
   *
   * 30 phút = `liveMaxAgeMs`. Trước mốc đó, vị trí vừa mua VẪN còn ở bậc `LIVE`
   * — mua lại không đổi được bậc, chỉ đổi được số dư tài khoản.
   */
  readonly paidPositionTtlMs: number;

  /**
   * Cửa sổ chặn cho mọi nhóm khác (identity / particulars / voyage).
   *
   * 24 giờ = `POSITION_STALE_AFTER_MS`, hằng mà hệ thống đã dùng. Dài hơn nhóm
   * vị trí có chủ ý: `builtYear` không đổi trong ngày, nên gọi lại trong ngày
   * chắc chắn nhận về đúng con số cũ.
   */
  readonly paidStaticTtlMs: number;
}

export const DEFAULT_PAID_FALLBACK_POLICY: Readonly<PaidFallbackPolicy> = Object.freeze({
  maxPaidAttemptsPerRequest: 1,
  paidPositionTtlMs: DEFAULT_POSITION_RESOLVER_POLICY.liveMaxAgeMs,
  paidStaticTtlMs: 24 * HOUR,
});

/** Nhóm vị trí dùng cửa sổ ngắn; còn lại dùng cửa sổ dài. */
export function paidTtlForGroups(
  groups: Iterable<VesselFieldGroup>,
  policy: PaidFallbackPolicy
): number {
  for (const group of groups) {
    if (group === VesselFieldGroup.POSITION) return policy.paidPositionTtlMs;
  }
  return policy.paidStaticTtlMs;
}

/**
 * Ảnh chụp ngân sách. Cổng chỉ ĐỌC — nó không đếm, không trừ, không ghi sổ.
 *
 * ⛔ Cố ý KHÔNG có `costPerCall`, `spentToday`, `invoice`. Đây không phải hệ
 * thống tính tiền; tầng tài khoản chịu trách nhiệm con số, cổng chỉ hỏi
 * "còn được tiêu không".
 */
export interface PaidBudgetSnapshot {
  /** Tài khoản trả tiền có đang dùng được không. */
  readonly enabled: boolean;
  /**
   * Số lần gọi còn lại.
   *
   * `null` = **KHÔNG BIẾT**, và không biết thì KHÔNG tiêu (xem
   * `PaidGateReason.BUDGET_UNKNOWN`). Tuyệt đối không quy ước `null` là vô hạn:
   * MyShipTracking không công bố giá, nên "chắc là còn" là một canh bạc bằng
   * tiền thật.
   */
  readonly remainingCalls: number | null;
}
