// ============================================================================
//  APPLICATION · RegionSchedulePolicy — "vùng này quét lại lúc nào"
// ----------------------------------------------------------------------------
//  HÀM THUẦN. Không mạng, không DB, không đồng hồ ngầm: `now` và `random` đều
//  được TIÊM vào, nên cùng đầu vào luôn cho cùng đầu ra và test kiểm được từng
//  mili giây.
//
//  Ba luật quan trọng nhất, tất cả đều học từ sự cố thật ở các phase trước:
//
//    1. HỎNG KHÔNG PHẢI VẮNG TÀU. Timeout/403/429/cooldown KHÔNG được ghi
//       `vesselCount = 0`. Nếu ghi, một vùng đông đúc sẽ bị hạ bậc xuống
//       EMPTY_OR_RARE chỉ vì nguồn chặn ta trong 20 phút.
//
//    2. LÙI DẦN, KHÔNG NHẢY CÓC. Một lần quét rỗng không đủ để đẩy vùng từ
//       10 phút sang 12 giờ — cần một CHUỖI lần rỗng liên tiếp.
//
//    3. CÓ TRẦN VÀ CÓ SÀN. Mọi khoảng thời gian tính ra đều bị kẹp về
//       [ABSOLUTE_MIN, ABSOLUTE_MAX]; không có đường nào quét vài giây một lần
//       và cũng không có đường nào bỏ quên một vùng mãi mãi.
// ============================================================================

import {
  ABSOLUTE_MAX_INTERVAL_MS,
  ABSOLUTE_MIN_INTERVAL_MS,
  DEFAULT_TIER_INTERVALS,
  RegionTrafficTier,
  TierInterval,
} from "../../../config/maritimeRegions";

/** Kết quả một lần quét vùng, nhìn từ góc lập lịch. */
export const RegionScanOutcome = {
  /** Quét xong, số tàu đọc được là THẬT (kể cả khi bằng 0). */
  SUCCESS: "SUCCESS",
  /** Nguồn hỏng/chặn/hết giờ. KHÔNG nói lên điều gì về mật độ vùng. */
  FAILED: "FAILED",
  /** Nguồn đang hạ nhiệt — thậm chí còn chưa gửi request. */
  SKIPPED_COOLDOWN: "SKIPPED_COOLDOWN",
} as const;

export type RegionScanOutcome = (typeof RegionScanOutcome)[keyof typeof RegionScanOutcome];

/** Trạng thái lập lịch của MỘT vùng. Không dính gì tới dữ liệu tàu. */
export interface RegionScheduleState {
  readonly regionId: string;
  readonly tier: RegionTrafficTier;
  readonly intervalMs: number;
  readonly lastScanAt: Date | null;
  readonly nextScanAt: Date;
  readonly lastVesselCount: number | null;
  readonly averageVesselCount: number | null;
  readonly newVesselCount: number | null;
  readonly consecutiveEmptyScans: number;
  readonly lastOutcome: RegionScanOutcome | null;
  readonly lastErrorAt: Date | null;
}

export interface RegionScanReport {
  readonly outcome: RegionScanOutcome;
  /** Chỉ có ý nghĩa khi `outcome === SUCCESS`. */
  readonly vesselCount?: number;
  readonly newVesselCount?: number;
}

export interface RegionSchedulePolicyDeps {
  intervals?: Readonly<Record<RegionTrafficTier, TierInterval>>;
  /** Trả về [0,1). Tiêm vào để test sinh ra khoảng thời gian tất định. */
  random?: () => number;
  /** Số lần rỗng LIÊN TIẾP trước khi rơi hẳn xuống EMPTY_OR_RARE. */
  emptyScansBeforeRare?: number;
  /** Sau khi hỏng thì thử lại sau bao lâu (vẫn bị kẹp về sàn tuyệt đối). */
  failureRetryMs?: number;
}

/** Ngưỡng phân bậc theo số tàu TRUNG BÌNH đo được. Cố ý đơn giản, đọc là hiểu. */
const HIGH_AVERAGE = 50;
const MEDIUM_AVERAGE = 15;

/** Vùng đang "rỗng" mà bỗng có ngần này tàu -> coi như sống lại ngay (§12). */
const RECOVERY_VESSEL_COUNT = 10;

/** Trọng số của lần đo MỚI trong trung bình trượt. Càng nhỏ càng ì. */
const NEW_SAMPLE_WEIGHT = 0.4;

export class RegionSchedulePolicy {
  private readonly intervals: Readonly<Record<RegionTrafficTier, TierInterval>>;
  private readonly random: () => number;
  private readonly emptyScansBeforeRare: number;
  private readonly failureRetryMs: number;

  constructor(deps: RegionSchedulePolicyDeps = {}) {
    this.intervals = deps.intervals ?? DEFAULT_TIER_INTERVALS;
    this.random = deps.random ?? Math.random;
    this.emptyScansBeforeRare = deps.emptyScansBeforeRare ?? 3;
    this.failureRetryMs = deps.failureRetryMs ?? ABSOLUTE_MIN_INTERVAL_MS;
  }

  /**
   * Khoảng thời gian cho một bậc, có jitter trong đúng khoảng của bậc đó.
   *
   * Jitter ở đây là SAN TẢI: 9 vùng HIGH không được cùng đến hạn ở đúng một
   * phút. Nó KHÔNG phải công cụ né chặn — không có gì về IP/UA/header ở đây.
   */
  intervalFor(tier: RegionTrafficTier): number {
    const { minMs, maxMs } = this.intervals[tier];
    const span = Math.max(0, maxMs - minMs);
    const raw = minMs + this.random() * span;
    return RegionSchedulePolicy.clamp(Math.round(raw));
  }

  /** Trạng thái ban đầu cho một vùng chưa từng quét: đến hạn NGAY. */
  initialState(regionId: string, baseTier: RegionTrafficTier, now: Date): RegionScheduleState {
    return {
      regionId,
      tier: baseTier,
      intervalMs: this.intervalFor(baseTier),
      lastScanAt: null,
      nextScanAt: now,
      lastVesselCount: null,
      averageVesselCount: null,
      newVesselCount: null,
      consecutiveEmptyScans: 0,
      lastOutcome: null,
      lastErrorAt: null,
    };
  }

  /**
   * Trạng thái kế tiếp sau một lần quét.
   *
   * @param report Kết quả quét. `vesselCount` CHỈ được dùng khi SUCCESS.
   */
  next(state: RegionScheduleState, report: RegionScanReport, now: Date): RegionScheduleState {
    if (report.outcome !== RegionScanOutcome.SUCCESS) {
      // ⛔ Đây là luật số 1. Không đụng vào vesselCount, average, streak, tier.
      // Nguồn hỏng nói lên điều gì đó về NGUỒN, không phải về vùng biển.
      const retryAt = new Date(now.getTime() + this.failureRetryMs);
      return {
        ...state,
        lastOutcome: report.outcome,
        lastErrorAt: report.outcome === RegionScanOutcome.FAILED ? now : state.lastErrorAt,
        // Không đổi `lastScanAt`: lần quét này KHÔNG diễn ra.
        nextScanAt: retryAt > state.nextScanAt ? retryAt : state.nextScanAt,
      };
    }

    const vesselCount = Math.max(0, Math.round(report.vesselCount ?? 0));
    const average =
      state.averageVesselCount === null
        ? vesselCount
        : Math.round(
            state.averageVesselCount * (1 - NEW_SAMPLE_WEIGHT) + vesselCount * NEW_SAMPLE_WEIGHT
          );

    const consecutiveEmptyScans = vesselCount === 0 ? state.consecutiveEmptyScans + 1 : 0;
    const tier = this.classify(vesselCount, average, consecutiveEmptyScans);
    const intervalMs = this.intervalFor(tier);

    return {
      ...state,
      tier,
      intervalMs,
      lastScanAt: now,
      nextScanAt: new Date(now.getTime() + intervalMs),
      lastVesselCount: vesselCount,
      averageVesselCount: average,
      newVesselCount: report.newVesselCount ?? 0,
      consecutiveEmptyScans,
      lastOutcome: RegionScanOutcome.SUCCESS,
    };
  }

  /**
   * Bậc mới từ số đo.
   *
   * Lùi dần (§11): rỗng lần đầu chỉ xuống LOW; phải rỗng liên tiếp đủ
   * `emptyScansBeforeRare` lần mới rơi xuống EMPTY_OR_RARE.
   *
   * Sống lại nhanh (§12): vùng vừa có >= `RECOVERY_VESSEL_COUNT` tàu thì bậc
   * tính theo SỐ ĐO MỚI NHẤT chứ không chờ trung bình trượt bò lên.
   */
  private classify(
    vesselCount: number,
    average: number,
    consecutiveEmptyScans: number
  ): RegionTrafficTier {
    if (consecutiveEmptyScans > 0) {
      return consecutiveEmptyScans >= this.emptyScansBeforeRare
        ? RegionTrafficTier.EMPTY_OR_RARE
        : RegionTrafficTier.LOW;
    }
    // Vùng vừa hồi sinh: đừng để trung bình cũ kéo nó nằm dưới.
    const basis = Math.max(average, vesselCount >= RECOVERY_VESSEL_COUNT ? vesselCount : 0);
    if (basis >= HIGH_AVERAGE) return RegionTrafficTier.HIGH;
    if (basis >= MEDIUM_AVERAGE) return RegionTrafficTier.MEDIUM;
    return RegionTrafficTier.LOW;
  }

  private static clamp(ms: number): number {
    if (ms < ABSOLUTE_MIN_INTERVAL_MS) return ABSOLUTE_MIN_INTERVAL_MS;
    if (ms > ABSOLUTE_MAX_INTERVAL_MS) return ABSOLUTE_MAX_INTERVAL_MS;
    return ms;
  }
}

/** Một giá trị trong [min,max] có jitter — dùng cho nghỉ giữa tile/vùng. */
export function jitteredDelay(range: TierInterval, random: () => number = Math.random): number {
  const span = Math.max(0, range.maxMs - range.minMs);
  return Math.round(range.minMs + random() * span);
}
