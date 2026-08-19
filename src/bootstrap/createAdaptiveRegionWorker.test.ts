// ============================================================================
//  TEST · createAdaptiveRegionWorker — vòng đời worker trong production runtime
// ----------------------------------------------------------------------------
//  Container được giả lập ở đúng bề mặt mà factory dùng. Không Mongo, không mạng.
//  Trọng tâm: worker nằm trong lifecycle của ProductionRuntime, tôn trọng
//  `nextScanAt` đã lưu, không quét chồng, và không đụng gì khi đang tắt máy.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { createAdaptiveRegionWorker } from "./createAdaptiveRegionWorker";
import { Container } from "./container";
import { ProductionRuntime, ProductionRuntimeStatus } from "./ProductionRuntime";
import { ICrawlRegionStateRepository } from "../application/contracts/repositories/ICrawlRegionStateRepository";
import {
  RegionScanOutcome,
  RegionScheduleState,
} from "../application/services/crawl-runtime/RegionSchedulePolicy";
import { SourceHealthState } from "../application/services/crawl-runtime/SourceHealthTracker";
import { MARITIME_REGIONS, RegionTrafficTier } from "../config/maritimeRegions";
import { VesselSource } from "../domain/enums/VesselSource";

const NOW = new Date("2026-08-19T12:00:00.000Z");

class MemoryStates implements ICrawlRegionStateRepository {
  readonly saved: RegionScheduleState[] = [];
  constructor(private readonly seed: RegionScheduleState[] = []) {}
  async findAll() { return this.seed; }
  async findByRegionId(id: string) { return this.seed.find((s) => s.regionId === id) ?? null; }
  async save(state: RegionScheduleState) { this.saved.push(state); }
}

/** Trạng thái đã lưu: vùng vừa quét xong, còn lâu mới tới hạn. */
function notDue(regionId: string): RegionScheduleState {
  return {
    regionId,
    tier: RegionTrafficTier.HIGH,
    intervalMs: 17 * 60_000,
    lastScanAt: new Date(NOW.getTime() - 60_000),
    nextScanAt: new Date(NOW.getTime() + 16 * 60_000),
    lastVesselCount: 120,
    averageVesselCount: 118,
    newVesselCount: 4,
    consecutiveEmptyScans: 0,
    lastOutcome: RegionScanOutcome.SUCCESS,
    lastErrorAt: null,
  };
}

function fakeContainer(scans: string[], health = SourceHealthState.HEALTHY): Container {
  return {
    providerRegistry: {
      get: (source: VesselSource) =>
        source === VesselSource.VESSELFINDER
          ? {
              source,
              async scanArea() { scans.push("scan"); return []; },
            }
          : undefined,
    },
    crawlRuntime: {
      getHealth: () => ({ state: health, totalRequests: 0 }),
      getExecutor: () => ({ execute: async (task: () => Promise<unknown>) => task() }),
    },
    observationRecorder: { async recordPositions() { return []; } },
    resolveAndStoreCurrentVessel: { async execute() { return {}; } },
    currentVesselRepository: { async findManyByMmsi() { return []; } },
    completeVesselBasics: { async execute() { return { requests: 0 }; } },
  } as unknown as Container;
}

function runtimeWith(worker: ReturnType<typeof createAdaptiveRegionWorker>): ProductionRuntime {
  return new ProductionRuntime({
    connectMongo: async () => undefined,
    disconnectMongo: async () => undefined,
    shutdownTimeoutMs: 5_000,
    logger: { info: () => undefined, warn: () => undefined },
    buildWorkers: async () => ({ schedulers: [worker] }),
  });
}

test("A. production runtime khởi động và dừng adaptive worker trong lifecycle", async () => {
  const scans: string[] = [];
  // Seed "chưa tới hạn": test này kiểm VÒNG ĐỜI, không phải hành vi quét.
  // (IntervalScheduler chạy ngay khi start, nên state rỗng sẽ quét thật.)
  const worker = createAdaptiveRegionWorker(fakeContainer(scans), {
    regionStates: new MemoryStates(MARITIME_REGIONS.map((r) => notDue(r.id))),
    dueCheckEveryMs: 60_000,
  });
  const runtime = runtimeWith(worker);

  await runtime.start();
  assert.equal(runtime.health().status, ProductionRuntimeStatus.READY);
  assert.equal(runtime.health().workers.schedulers, 1);
  assert.equal((worker.stats?.() as { scheduled: boolean }).scheduled, true);
  assert.equal((worker.stats?.() as { regions: number }).regions, MARITIME_REGIONS.length);

  await runtime.stop();
  assert.equal(runtime.health().status, ProductionRuntimeStatus.STOPPED);
  // Không để lại timer mồ côi.
  assert.equal((worker.stats?.() as { scheduled: boolean }).scheduled, false);
});

test("B. vùng chưa tới hạn -> KHÔNG quét, dù due-check chạy nhiều lần", async () => {
  const scans: string[] = [];
  const states = new MemoryStates(MARITIME_REGIONS.map((r) => notDue(r.id)));
  const worker = createAdaptiveRegionWorker(fakeContainer(scans), {
    regionStates: states,
    dueCheckEveryMs: 5,
  });

  worker.start();
  await new Promise((r) => setTimeout(r, 60)); // vài nhịp due-check
  await worker.stop();

  assert.deepEqual(scans, [], "nextScanAt đã lưu phải được tôn trọng");
  assert.deepEqual(states.saved, [], "không có state nào bị ghi đè khi chưa tới hạn");
});

test("C. restart KHÔNG reset state — dùng lại state đã lưu, không dựng initial state", async () => {
  const scans: string[] = [];
  const seeded = MARITIME_REGIONS.map((r) => notDue(r.id));
  const states = new MemoryStates(seeded);

  // "Tiến trình" thứ nhất.
  const first = createAdaptiveRegionWorker(fakeContainer(scans), { regionStates: states, dueCheckEveryMs: 5 });
  first.start();
  await new Promise((r) => setTimeout(r, 30));
  await first.stop();

  // "Tiến trình" thứ hai đọc cùng repository.
  const second = createAdaptiveRegionWorker(fakeContainer(scans), { regionStates: states, dueCheckEveryMs: 5 });
  second.start();
  await new Promise((r) => setTimeout(r, 30));
  await second.stop();

  assert.deepEqual(scans, [], "restart không được kích hoạt quét sớm");
  // nextScanAt của state gốc phải còn nguyên.
  const state = await states.findByRegionId(MARITIME_REGIONS[0].id);
  assert.equal(state?.nextScanAt.getTime(), seeded[0].nextScanAt.getTime());
});

test("D. due-check chồng nhau -> không sinh lượt quét trùng", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  const scans: string[] = [];

  const container = {
    ...fakeContainer(scans),
    providerRegistry: {
      get: () => ({
        source: VesselSource.VESSELFINDER,
        async scanArea() { scans.push("scan"); await gate; return []; },
      }),
    },
  } as unknown as Container;

  const worker = createAdaptiveRegionWorker(container, {
    regionStates: new MemoryStates(), // tất cả vùng đều due
    dueCheckEveryMs: 5,
  });

  worker.start();
  await new Promise((r) => setTimeout(r, 40)); // nhiều nhịp trong khi lượt đầu còn kẹt
  assert.equal(scans.length, 1, `chỉ được đúng một lượt quét đang chạy, thấy ${scans.length}`);

  release!();
  await worker.stop();
});

test("registry thiếu provider quét vùng -> ném ngay lúc dựng worker", () => {
  const container = { providerRegistry: { get: () => undefined } } as unknown as Container;
  assert.throws(() => createAdaptiveRegionWorker(container), /scanArea/);
});
