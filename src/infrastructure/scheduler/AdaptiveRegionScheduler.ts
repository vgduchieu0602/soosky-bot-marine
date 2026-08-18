// ============================================================================
//  INFRASTRUCTURE · AdaptiveRegionScheduler — quét vùng theo mật độ đo được
// ----------------------------------------------------------------------------
//      vùng đến hạn -> quét map (1 vùng MỘT LÚC) -> ghi observation
//                   -> phân xử canonical -> cập nhật lịch cho vùng đó
//                   -> hoàn thiện VesselBasics cho MỘT SỐ ÍT tàu
//
//  Thứ tự ưu tiên an toàn (§19), từ cao xuống thấp:
//      1. cooldown của nguồn   <- KHÔNG BAO GIỜ bị scheduler ghi đè
//      2. rate limit của nguồn
//      3. vùng đã đến hạn chưa
//      4. nghỉ giữa tile
//      5. jitter
//
//  Scheduler này KHÔNG tự quyết định nhịp: `RegionSchedulePolicy` (thuần, đã
//  test) quyết. Ở đây chỉ có vòng lặp, khoá chống chạy chồng, và ghi DB.
// ============================================================================

import { ICrawlRegionStateRepository } from "../../application/contracts/repositories/ICrawlRegionStateRepository";
import { ICurrentVesselRepository } from "../../application/contracts/repositories/ICurrentVesselRepository";
import { ProviderPositionResult } from "../../application/contracts/providers/ProviderResults";
import { VesselDataProvider } from "../../application/contracts/providers/VesselDataProvider";
import { ProviderOperation } from "../../application/contracts/providers/VesselDataProvider";
import { ObservationRecorder } from "../../application/services/observation/ObservationRecorder";
import { SourceRuntimeManager } from "../../application/services/crawl-runtime/SourceRuntimeManager";
import { SourceHealthState } from "../../application/services/crawl-runtime/SourceHealthTracker";
import {
  RegionScanOutcome,
  RegionSchedulePolicy,
  RegionScheduleState,
  jitteredDelay,
} from "../../application/services/crawl-runtime/RegionSchedulePolicy";
import { ResolveAndStoreCurrentVessel } from "../../application/use-cases/resolution/ResolveAndStoreCurrentVessel";
import { CompleteVesselBasics } from "../../application/use-cases/vessel/CompleteVesselBasics";
import {
  COMPLETION_BUDGET_PER_CYCLE,
  MARITIME_REGIONS,
  MaritimeRegion,
  REGION_PAUSE_MS,
} from "../../config/maritimeRegions";
import { isValidMmsi } from "../../domain/validators/identifiers";
import { VesselSource } from "../../domain/enums/VesselSource";

/** Chỉ VesselFinder có `scanArea` — xem PHASE 4 §26. */
const SCAN_SOURCE = VesselSource.VESSELFINDER;

/** Chuyển động cũ hơn mốc này thì đáng đi lấy lại. Dùng lại ngưỡng RECENT. */
const STALE_MOTION_MS = 6 * 60 * 60 * 1000;

export interface RegionCycleMetrics {
  regionId: string;
  outcome: RegionScanOutcome;
  vesselCount: number;
  newVesselCount: number;
  /**
   * Số lần GỌI `scanArea`, KHÔNG phải số request HTTP.
   *
   * Một lần gọi có thể nở ra nhiều request nếu provider chia nhỏ vùng. Gọi nó
   * là "mapRequests" như trước là nói quá — nên tên này nói đúng thứ nó đếm.
   */
  scanAreaCalls: number;
  /**
   * Số request upstream ĐO ĐƯỢC, lấy từ chính bộ đếm của crawl runtime
   * (`SourceHealthTracker.totalRequests`), không phải ước lượng. Đã bao gồm
   * cả các lần retry mà người gọi không nhìn thấy.
   */
  httpRequests: number;
  completionRequests: number;
  completionVessels: number;
  durationMs: number;
  error?: string;
}

export interface AdaptiveRegionSchedulerDeps {
  provider: VesselDataProvider;
  runtime: SourceRuntimeManager;
  recorder: ObservationRecorder;
  resolveAndStore: ResolveAndStoreCurrentVessel;
  regionStates: ICrawlRegionStateRepository;
  /** Chỉ dùng để XẾP HẠNG ứng viên hoàn thiện. Không có -> giữ nguyên thứ tự quét. */
  currentVesselRepository?: ICurrentVesselRepository;
  policy?: RegionSchedulePolicy;
  completeBasics?: CompleteVesselBasics;
  regions?: readonly MaritimeRegion[];
  completionBudget?: number;
  now?: () => Date;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Bỏ nghỉ giữa vùng — CHỈ dùng trong test. */
  skipRegionPause?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AdaptiveRegionScheduler {
  private readonly deps: AdaptiveRegionSchedulerDeps;
  private readonly policy: RegionSchedulePolicy;
  private readonly regions: readonly MaritimeRegion[];
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Khoá chống chạy chồng (§45): một vùng không thể có hai lượt quét cùng lúc. */
  private readonly running = new Set<string>();
  private tickInFlight = false;

  constructor(deps: AdaptiveRegionSchedulerDeps) {
    this.deps = deps;
    this.policy = deps.policy ?? new RegionSchedulePolicy({ random: deps.random });
    this.regions = deps.regions ?? MARITIME_REGIONS;
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /** Vùng đã đến hạn, cũ nhất trước để không vùng nào bị bỏ đói (§44). */
  async dueRegions(): Promise<{ region: MaritimeRegion; state: RegionScheduleState }[]> {
    const now = this.now();
    const stored = await this.deps.regionStates.findAll();
    const byId = new Map(stored.map((s) => [s.regionId, s]));

    return this.regions
      .map((region) => ({
        region,
        state: byId.get(region.id) ?? this.policy.initialState(region.id, region.baseTier, now),
      }))
      .filter(({ state }) => state.nextScanAt.getTime() <= now.getTime())
      .sort((a, b) => a.state.nextScanAt.getTime() - b.state.nextScanAt.getTime());
  }

  /**
   * Một lượt: quét MỌI vùng đã đến hạn, tuần tự (§15 — concurrency 1).
   * Tick chồng lên tick trước sẽ bị bỏ qua, giống `IntervalScheduler` hiện có.
   */
  async tick(): Promise<RegionCycleMetrics[]> {
    if (this.tickInFlight) return [];
    this.tickInFlight = true;
    const metrics: RegionCycleMetrics[] = [];
    try {
      const due = await this.dueRegions();
      for (const { region, state } of due) {
        // Sức khoẻ nguồn ĐỨNG TRÊN lịch: nguồn đang hạ nhiệt thì dừng cả lượt,
        // không đi lê la thử từng vùng cho tới khi bị chặn nặng hơn (§20/§21).
        if (!this.sourceUsable()) {
          metrics.push(this.skipped(region.id, state));
          await this.deps.regionStates.save(
            this.policy.next(state, { outcome: RegionScanOutcome.SKIPPED_COOLDOWN }, this.now())
          );
          break;
        }
        if (this.running.has(region.id)) continue;
        metrics.push(await this.scanRegion(region, state));
        if (this.deps.skipRegionPause !== true) {
          await this.sleep(jitteredDelay(REGION_PAUSE_MS, this.random));
        }
      }
    } finally {
      this.tickInFlight = false;
    }
    return metrics;
  }

  private sourceUsable(): boolean {
    const health = this.deps.runtime.getHealth(SCAN_SOURCE);
    return health.state !== SourceHealthState.COOLDOWN && health.state !== SourceHealthState.DISABLED;
  }

  /**
   * Xếp thứ tự ứng viên hoàn thiện VesselBasics (§15).
   *
   *   1. tàu VỪA phát hiện          — chưa biết gì về nó
   *   2. thiếu field VesselBasics cốt lõi (vType / toạ độ / motion)
   *   3. chuyển động đã ôi
   *   4. đã đủ dùng                 — xếp cuối, thường bị trần cắt mất
   *
   * Đọc canonical bằng MỘT truy vấn cho cả mẻ, không phải N truy vấn: xếp hạng
   * không được đắt hơn chính việc nó tiết kiệm.
   */
  private async prioritiseCandidates(
    mmsis: readonly string[],
    newMmsis: ReadonlySet<string>
  ): Promise<string[]> {
    const known = this.deps.currentVesselRepository
      ? await this.deps.currentVesselRepository.findManyByMmsi(mmsis)
      : [];
    const byMmsi = new Map(known.map((v) => [v.vesselKey.mmsi ?? "", v]));
    const staleBefore = this.now().getTime() - STALE_MOTION_MS;

    const rank = (mmsi: string): number => {
      if (newMmsis.has(mmsi)) return 0;
      const vessel = byMmsi.get(mmsi);
      if (vessel === undefined) return 1; // chưa có canonical -> gần như mới
      const motion = vessel.position?.motion ?? null;
      const missingCore =
        vessel.identity?.vesselTypeCode == null ||
        vessel.position?.position == null ||
        motion?.speed == null;
      if (missingCore) return 2;
      const observedAt = motion?.observedAt ?? null;
      if (observedAt === null || observedAt.getTime() < staleBefore) return 3;
      return 4; // đã đủ dùng
    };

    return [...mmsis].sort((a, b) => rank(a) - rank(b));
  }

  private skipped(regionId: string, state: RegionScheduleState): RegionCycleMetrics {
    return {
      regionId,
      outcome: RegionScanOutcome.SKIPPED_COOLDOWN,
      vesselCount: 0,
      newVesselCount: 0,
      scanAreaCalls: 0,
      httpRequests: 0,
      completionRequests: 0,
      completionVessels: 0,
      durationMs: 0,
      error: `${SCAN_SOURCE} unavailable`,
    };
  }

  private async scanRegion(
    region: MaritimeRegion,
    state: RegionScheduleState
  ): Promise<RegionCycleMetrics> {
    this.running.add(region.id);
    const startedAt = Date.now();
    // Đọc bộ đếm request TRƯỚC/SAU và lấy hiệu — đây là con số thật của runtime,
    // không phải ta tự đếm song song một hệ metric khác (§13).
    const requestsBefore = this.deps.runtime.getHealth(SCAN_SOURCE).totalRequests;
    let scanAreaCalls = 0;
    let vesselCount = 0;
    let newVesselCount = 0;
    let completionRequests = 0;
    let completionVessels = 0;
    let outcome: RegionScanOutcome = RegionScanOutcome.SUCCESS;
    let error: string | undefined;

    try {
      const executor = this.deps.runtime.getExecutor(SCAN_SOURCE);
      scanAreaCalls = 1;
      const rows = await executor.execute<readonly ProviderPositionResult[]>(
        () => this.deps.provider.scanArea!(region.bbox),
        { operation: ProviderOperation.SCAN_AREA }
      );
      vesselCount = rows.length;

      const saved = await this.deps.recorder.recordPositions(rows, {
        parserVersion: "vesselfinder-map-v1",
      });
      newVesselCount = saved.filter((s) => s.status === "SAVED").length;

      const mmsis = Array.from(
        new Set(
          rows
            .map((r) => r.position?.mmsi ?? null)
            .filter((m): m is string => isValidMmsi(m))
        )
      );
      // `recordPositions` trả kết quả THEO ĐÚNG THỨ TỰ đầu vào -> ghép được
      // "bản ghi này có phải mới không" về đúng con tàu.
      const newMmsis = new Set<string>();
      rows.forEach((row, index) => {
        const mmsi = row.position?.mmsi ?? null;
        if (isValidMmsi(mmsi) && saved[index]?.status === "SAVED") newMmsis.add(mmsi!);
      });
      for (const mmsi of mmsis) await this.deps.resolveAndStore.execute({ mmsi });

      // Hoàn thiện VesselBasics là công việc RIÊNG và CÓ TRẦN (§23/§24):
      // quét ra 500 tàu không có nghĩa là bắn 500 lượt tra cứu.
      if (this.deps.completeBasics !== undefined) {
        const budget = this.deps.completionBudget ?? COMPLETION_BUDGET_PER_CYCLE;
        const ordered = await this.prioritiseCandidates(mmsis, newMmsis);
        for (const mmsi of ordered.slice(0, budget)) {
          const result = await this.deps.completeBasics.execute(mmsi);
          completionRequests += result.requests;
          if (result.requests > 0) completionVessels += 1;
        }
      }
    } catch (err) {
      // ⛔ Hỏng KHÔNG phải vắng tàu (§22). Không ghi vesselCount = 0.
      outcome = RegionScanOutcome.FAILED;
      error = (err as Error).message?.slice(0, 200);
    } finally {
      this.running.delete(region.id);
    }

    const report =
      outcome === RegionScanOutcome.SUCCESS
        ? { outcome, vesselCount, newVesselCount }
        : { outcome };
    await this.deps.regionStates.save(this.policy.next(state, report, this.now()));

    return {
      regionId: region.id,
      outcome,
      vesselCount,
      newVesselCount,
      scanAreaCalls,
      httpRequests: Math.max(
        0,
        this.deps.runtime.getHealth(SCAN_SOURCE).totalRequests - requestsBefore
      ),
      completionRequests,
      completionVessels,
      durationMs: Date.now() - startedAt,
      error,
    };
  }
}
