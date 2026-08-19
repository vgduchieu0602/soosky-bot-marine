// ============================================================================
//  TEST · Vòng quét vùng trong runtime production — vòng đời và số lượng
// ----------------------------------------------------------------------------
//  Không Mongo, không mạng: dựng đúng hình dạng worker mà `createProductionRuntime`
//  đưa cho `ProductionRuntime`, rồi kiểm vòng đời qua chính `ProductionRuntime`
//  thật (start -> READY -> stop -> STOPPED).
//
//  Trọng tâm: MỘT tiến trình chỉ được có MỘT scheduler vùng, và nhịp poll
//  KHÔNG được tự sinh ra request nguồn.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { ProductionRuntime, ProductionRuntimeStatus } from "./ProductionRuntime";
import { AdaptiveRegionScheduler } from "../infrastructure/scheduler/AdaptiveRegionScheduler";
import { IntervalScheduler } from "../infrastructure/scheduler/IntervalScheduler";
import { ICrawlRegionStateRepository } from "../application/contracts/repositories/ICrawlRegionStateRepository";
import { RegionScanOutcome, RegionScheduleState } from "../application/services/crawl-runtime/RegionSchedulePolicy";
import { SourceHealthState } from "../application/services/crawl-runtime/SourceHealthTracker";
import { MaritimeRegion, RegionTrafficTier } from "../config/maritimeRegions";

const NOW = new Date("2026-08-19T12:00:00.000Z");

const REGION: MaritimeRegion = {
  id: "uk-english-channel",
  name: "English Channel",
  country: "UK",
  bbox: { minLat: 50.8, minLon: 0.8, maxLat: 51.3, maxLon: 1.6 },
  baseTier: RegionTrafficTier.HIGH,
};

class MemoryStates implements ICrawlRegionStateRepository {
  constructor(private readonly seed: RegionScheduleState[] = []) {}
  async findAll() { return this.seed; }
  async findByRegionId(id: string) { return this.seed.find((s) => s.regionId === id) ?? null; }
  async save() { /* not asserted here */ }
}

function notDueState(): RegionScheduleState {
  return {
    regionId: REGION.id,
    tier: RegionTrafficTier.HIGH,
    intervalMs: 15 * 60_000,
    lastScanAt: new Date(NOW.getTime() - 60_000),
    nextScanAt: new Date(NOW.getTime() + 30 * 60_000), // còn lâu mới tới hạn
    lastVesselCount: 80,
    averageVesselCount: 80,
    newVesselCount: 0,
    consecutiveEmptyScans: 0,
    lastOutcome: RegionScanOutcome.SUCCESS,
    lastErrorAt: null,
  };
}

function buildAdaptive(options: { health?: SourceHealthState; states?: RegionScheduleState[] } = {}) {
  const scans: string[] = [];
  const scheduler = new AdaptiveRegionScheduler({
    regions: [REGION],
    regionStates: new MemoryStates(options.states ?? []),
    now: () => NOW,
    random: () => 0.5,
    sleep: async () => undefined,
    skipRegionPause: true,
    provider: {
      source: "vesselfinder" as never,
      async scanArea() { scans.push("scan"); return [] as never; },
    } as never,
    runtime: {
      getHealth: () => ({ state: options.health ?? SourceHealthState.HEALTHY, totalRequests: 0 }),
      getExecutor: () => ({ execute: async (task: () => Promise<unknown>) => task() }),
    } as never,
    recorder: { async recordPositions() { return []; } } as never,
    resolveAndStore: { async execute() { return {} as never; } } as never,
  });
  return { scheduler, scans };
}

/** Đúng hình dạng worker mà createProductionRuntime dựng quanh IntervalScheduler. */
function runtimeWith(schedulers: IntervalScheduler[]): ProductionRuntime {
  return new ProductionRuntime({
    connectMongo: async () => undefined,
    disconnectMongo: async () => undefined,
    shutdownTimeoutMs: 5_000,
    logger: { info: () => undefined, warn: () => undefined },
    buildWorkers: async () => ({
      schedulers: schedulers.map((s) => ({
        start: () => s.start(),
        stop: () => s.stop(),
        stats: () => s.getStats(),
      })),
    }),
  });
}

test("runtime khởi động scheduler vùng và dừng sạch khi shutdown", async () => {
  const { scheduler } = buildAdaptive();
  const poll = new IntervalScheduler({
    label: "adaptive region scan",
    everyMs: 60_000,
    task: async () => { await scheduler.tick(); },
  });
  const runtime = runtimeWith([poll]);

  await runtime.start();
  assert.equal(runtime.health().status, ProductionRuntimeStatus.READY);
  assert.equal(runtime.health().workers.schedulers, 1);
  assert.equal(poll.getStats().scheduled, true, "timer phải đang chạy");

  await runtime.stop();
  assert.equal(runtime.health().status, ProductionRuntimeStatus.STOPPED);
  // §17: không được để lại timer mồ côi.
  assert.equal(poll.getStats().scheduled, false);
});

test("§8 một runtime chỉ dựng MỘT scheduler vùng", async () => {
  const { scheduler } = buildAdaptive();
  const poll = new IntervalScheduler({
    label: "adaptive region scan",
    everyMs: 60_000,
    task: async () => { await scheduler.tick(); },
  });
  const runtime = runtimeWith([poll]);
  await runtime.start();

  const labels = runtime.stats().schedulers as { label?: string }[];
  assert.equal(runtime.health().workers.schedulers, 1);
  assert.equal(labels.length, 1);

  await runtime.stop();
});

test("§7 poll khi KHÔNG vùng nào tới hạn -> không sinh request nguồn nào", async () => {
  const { scheduler, scans } = buildAdaptive({ states: [notDueState()] });

  // Ba nhịp poll liên tiếp, giống ba lần setInterval nổ.
  await scheduler.tick();
  await scheduler.tick();
  await scheduler.tick();

  assert.deepEqual(scans, [], "poll chỉ được HỎI, không được crawl");
});

test("§10 nguồn đang cooldown -> poll cũng không sinh request nào", async () => {
  const { scheduler, scans } = buildAdaptive({ health: SourceHealthState.COOLDOWN });
  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(scans, [], "cooldown của nguồn đứng trên lịch quét");
});

// ---------------------------------------------------------------------------
//  E. AIS tắt -> runtime KHÔNG dựng worker AIS nào
// ---------------------------------------------------------------------------

test("E. BOT_AIS_ENABLED=false -> không có AIS worker trong runtime", async () => {
  const runtime = new ProductionRuntime({
    connectMongo: async () => undefined,
    disconnectMongo: async () => undefined,
    shutdownTimeoutMs: 5_000,
    logger: { info: () => undefined, warn: () => undefined },
    // Đúng hình dạng `createProductionRuntime` trả về khi AIS tắt: chỉ schedulers.
    buildWorkers: async () => ({ schedulers: [] }),
  });

  await runtime.start();
  const health = runtime.health();
  assert.equal(health.ais.enabled, false, "AIS phải vắng mặt hoàn toàn");
  assert.equal(health.ais.connected, false);
  // AIS tắt KHÔNG được kéo runtime xuống DEGRADED.
  assert.equal(health.status, ProductionRuntimeStatus.READY);

  await runtime.stop();
});
