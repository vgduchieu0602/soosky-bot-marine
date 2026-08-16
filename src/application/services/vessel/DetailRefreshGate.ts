// ============================================================================
//  APPLICATION · DetailRefreshGate — chặn bão request lên nguồn ngoài
// ----------------------------------------------------------------------------
//  HAI cơ chế KHÁC NHAU, đừng lẫn:
//
//    SINGLE-FLIGHT  10 người bấm CÙNG LÚC vào MMSI A -> đúng MỘT lượt crawl,
//                   9 người còn lại chờ chung cái Promise đó.
//    COOLDOWN       Vừa crawl A xong, 5 giây sau bấm lại -> KHÔNG crawl lại.
//
//  Single-flight gộp request ĐỒNG THỜI; cooldown chặn request LẶP LẠI SAU ĐÓ.
//  Thiếu cái nào cũng để lọt một đường đánh nguồn ngoài.
//
//  ⛔ Không Redis, không thư viện ngoài. Bộ nhớ trong tiến trình, CÓ TRẦN.
//     Nhiều tiến trình thì mỗi tiến trình có gate riêng — chấp nhận được vì
//     runtime P4 (rate limit/cooldown theo nguồn) mới là hàng rào cuối cùng.
// ============================================================================

import { DetailGroup } from "./VesselDetailProjector";

const MINUTE = 60 * 1000;

export interface DetailRefreshGatePolicy {
  /** Vừa lấy được dữ liệu mới -> nghỉ ngần này trước khi hỏi nguồn lại. */
  readonly successCooldownMs: number;
  /**
   * Vừa thử mà KHÔNG ra gì -> nghỉ ngắn hơn.
   *
   * Ngắn hơn có chủ ý: hỏng có thể là tạm thời (nguồn nghẽn một lúc), còn dữ
   * liệu vừa lấy được thì chắc chắn chưa đổi trong vài phút.
   */
  readonly failureCooldownMs: number;
  /**
   * Trần số khoá (tàu × nhóm) nhớ được.
   *
   * Có trần vì đây là bộ nhớ theo NGƯỜI DÙNG BẤM: một đợt truy cập bất thường
   * không được phép biến map này thành rò rỉ.
   */
  readonly maxEntries: number;
}

export const DEFAULT_DETAIL_REFRESH_GATE_POLICY: Readonly<DetailRefreshGatePolicy> = Object.freeze({
  successCooldownMs: 5 * MINUTE,
  failureCooldownMs: 1 * MINUTE,
  maxEntries: 20_000,
});

export interface DetailRefreshGateStats {
  readonly trackedKeys: number;
  readonly inFlight: number;
  readonly singleFlightJoins: number;
  readonly suppressedGroups: number;
  readonly evictions: number;
}

interface GateEntry {
  lastAttemptAt: number;
  /** Lần thử gần nhất có lấy được dữ liệu mới không. */
  succeeded: boolean;
}

export interface DetailRefreshGateDeps {
  policy?: DetailRefreshGatePolicy;
  now?: () => Date;
}

export class DetailRefreshGate {
  private readonly policy: DetailRefreshGatePolicy;
  private readonly now: () => Date;

  /**
   * ⚠️ Thứ tự chèn của `Map` LÀ cơ chế đuổi (cùng thủ thuật với
   * `AisCoalescingBuffer`): touch = delete + set, nạn nhân = khoá đầu bảng.
   */
  private readonly entries = new Map<string, GateEntry>();
  /** Lượt refresh ĐANG CHẠY, khoá theo TÀU (không theo nhóm). */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  private singleFlightJoins = 0;
  private suppressedGroups = 0;
  private evictions = 0;

  constructor(deps: DetailRefreshGateDeps = {}) {
    this.policy = deps.policy ?? DEFAULT_DETAIL_REFRESH_GATE_POLICY;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Lọc nhóm nào còn được phép hỏi nguồn ngoài.
   *
   * @param force bỏ qua cooldown của ỨNG DỤNG. ⚠️ KHÔNG bỏ qua được cooldown
   *        của runtime P4 — hàng rào chống bị chặn nằm ở đó và không ai được
   *        phép đi vòng.
   */
  filterAllowed(
    vesselKey: string,
    groups: readonly DetailGroup[],
    force = false
  ): { allowed: readonly DetailGroup[]; suppressed: readonly DetailGroup[] } {
    if (force) return { allowed: [...groups], suppressed: [] };

    const now = this.now().getTime();
    const allowed: DetailGroup[] = [];
    const suppressed: DetailGroup[] = [];

    for (const group of groups) {
      const entry = this.entries.get(DetailRefreshGate.key(vesselKey, group));
      if (entry === undefined) {
        allowed.push(group);
        continue;
      }
      const cooldown = entry.succeeded
        ? this.policy.successCooldownMs
        : this.policy.failureCooldownMs;
      if (now - entry.lastAttemptAt >= cooldown) allowed.push(group);
      else {
        suppressed.push(group);
        this.suppressedGroups += 1;
      }
    }

    return { allowed, suppressed };
  }

  /** Ghi lại là ĐÃ THỬ — kể cả khi không ra gì, để không thử lại ngay. */
  recordAttempt(vesselKey: string, groups: readonly DetailGroup[], succeeded: boolean): void {
    const now = this.now().getTime();
    for (const group of groups) {
      const key = DetailRefreshGate.key(vesselKey, group);
      this.entries.delete(key);
      this.entries.set(key, { lastAttemptAt: now, succeeded });
    }
    this.evictIfNeeded();
  }

  /**
   * Gộp mọi lời gọi ĐỒNG THỜI cho cùng một tàu về một lượt chạy.
   *
   * Người tới sau nhận CHÍNH cái Promise của người đầu tiên — nên tất cả đều
   * thấy cùng một kết quả cuối, và nguồn ngoài chỉ bị hỏi một lần.
   */
  async runSingleFlight<T>(vesselKey: string, work: () => Promise<T>): Promise<T> {
    const running = this.inFlight.get(vesselKey);
    if (running !== undefined) {
      this.singleFlightJoins += 1;
      return running as Promise<T>;
    }

    // `finally` chứ không phải `then`: hỏng cũng phải nhả khoá, nếu không một
    // lần lỗi sẽ khoá vĩnh viễn con tàu đó.
    const promise = work().finally(() => this.inFlight.delete(vesselKey));
    this.inFlight.set(vesselKey, promise);
    return promise;
  }

  getStats(): DetailRefreshGateStats {
    return {
      trackedKeys: this.entries.size,
      inFlight: this.inFlight.size,
      singleFlightJoins: this.singleFlightJoins,
      suppressedGroups: this.suppressedGroups,
      evictions: this.evictions,
    };
  }

  /** Xoá trạng thái. Bộ đếm GIỮ NGUYÊN — chúng là số liệu vận hành. */
  clear(): void {
    this.entries.clear();
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.policy.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  private static key(vesselKey: string, group: DetailGroup): string {
    return `${vesselKey}|${group}`;
  }
}
