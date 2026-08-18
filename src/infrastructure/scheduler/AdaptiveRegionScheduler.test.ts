// ============================================================================
//  TEST · AdaptiveRegionScheduler — cooldown thắng lịch, không chạy chồng,
//  không vùng nào bị bỏ đói, và hoàn thiện VesselBasics luôn có TRẦN
// ----------------------------------------------------------------------------
//  Không mạng, không Mongo: repository trạng thái vùng là in-memory, provider
//  và runtime được giả lập. `now`/`random`/`sleep` đều tiêm vào.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { AdaptiveRegionScheduler } from "./AdaptiveRegionScheduler";
import { ICrawlRegionStateRepository } from "../../application/contracts/repositories/ICrawlRegionStateRepository";
import {
  RegionScanOutcome,
  RegionScheduleState,
} from "../../application/services/crawl-runtime/RegionSchedulePolicy";
import { SourceHealthState } from "../../application/services/crawl-runtime/SourceHealthTracker";
import { MaritimeRegion, RegionTrafficTier } from "../../config/maritimeRegions";

const NOW = new Date("2026-08-19T12:00:00.000Z");

const REGIONS: MaritimeRegion[] = [
  { id: "r1", name: "R1", country: "UK", bbox: { minLat: 50, minLon: 0, maxLat: 51, maxLon: 1 }, baseTier: RegionTrafficTier.HIGH },
  { id: "r2", name: "R2", country: "UK", bbox: { minLat: 51, minLon: 0, maxLat: 52, maxLon: 1 }, baseTier: RegionTrafficTier.LOW },
  { id: "r3", name: "R3", country: "US", bbox: { minLat: 40, minLon: -74, maxLat: 41, maxLon: -73 }, baseTier: RegionTrafficTier.MEDIUM },
];

class MemoryRegionStates implements ICrawlRegionStateRepository {
  readonly saved = new Map<string, RegionScheduleState>();
  constructor(seed: RegionScheduleState[] = []) {
    for (const s of seed) this.saved.set(s.regionId, s);
  }
  async findAll() { return [...this.saved.values()]; }
  async findByRegionId(id: string) { return this.saved.get(id) ?? null; }
  async save(state: RegionScheduleState) { this.saved.set(state.regionId, state); }
}

function ships(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    position: { mmsi: String(200000000 + i), lat: 50.5, lng: 0.5, receivedAt: NOW, metadata: {} },
  }));
}

function build(options: {
  states?: MemoryRegionStates;
  health?: SourceHealthState;
  vessels?: number;
  scanArea?: () => Promise<unknown>;
  completionBudget?: number;
  onComplete?: (mmsi: string) => void;
  totalRequests?: () => number;
  currentVesselRepository?: unknown;
  savedStatuses?: string[];
} = {}) {
  const scanned: string[] = [];
  const completed: string[] = [];
  const states = options.states ?? new MemoryRegionStates();

  const scheduler = new AdaptiveRegionScheduler({
    regions: REGIONS,
    regionStates: states,
    now: () => NOW,
    random: () => 0.5,
    sleep: async () => undefined,
    skipRegionPause: true,
    completionBudget: options.completionBudget,
    provider: {
      source: "vesselfinder" as never,
      async scanArea(box: never) {
        if (options.scanArea) return (await options.scanArea()) as never;
        scanned.push(JSON.stringify(box));
        return ships(options.vessels ?? 60) as never;
      },
    } as never,
    currentVesselRepository: options.currentVesselRepository as never,
    runtime: {
      getHealth: () => ({
        state: options.health ?? SourceHealthState.HEALTHY,
        totalRequests: options.totalRequests ? options.totalRequests() : 0,
      }),
      getExecutor: () => ({ execute: async (task: () => Promise<unknown>) => task() }),
    } as never,
    recorder: {
      async recordPositions(rows: unknown[]) {
        return rows.map((_, i) => ({ status: options.savedStatuses?.[i] ?? "SAVED" }));
      },
    } as never,
    resolveAndStore: { async execute() { return {} as never; } } as never,
    completeBasics: {
      async execute(mmsi: string) {
        completed.push(mmsi);
        options.onComplete?.(mmsi);
        return { requests: 1 } as never;
      },
    } as never,
  });

  return { scheduler, states, scanned, completed };
}

test("§20/§21 nguồn đang cooldown -> KHÔNG quét vùng nào", async () => {
  const { scheduler, scanned } = build({ health: SourceHealthState.COOLDOWN });
  const metrics = await scheduler.tick();

  assert.deepEqual(scanned, [], "không được gửi request nào khi nguồn hạ nhiệt");
  assert.equal(metrics[0].outcome, RegionScanOutcome.SKIPPED_COOLDOWN);
  // Dừng cả lượt, không lê la thử từng vùng.
  assert.equal(metrics.length, 1);
});

test("§9 trạng thái đã lưu còn hạn -> KHÔNG quét lại chỉ vì tiến trình khởi động lại", async () => {
  const future = new Date(NOW.getTime() + 30 * 60_000);
  const states = new MemoryRegionStates(
    REGIONS.map((r) => ({
      regionId: r.id,
      tier: RegionTrafficTier.HIGH,
      intervalMs: 15 * 60_000,
      lastScanAt: new Date(NOW.getTime() - 60_000),
      nextScanAt: future,
      lastVesselCount: 80,
      averageVesselCount: 80,
      newVesselCount: 0,
      consecutiveEmptyScans: 0,
      lastOutcome: RegionScanOutcome.SUCCESS,
      lastErrorAt: null,
    }))
  );

  const { scheduler, scanned } = build({ states });
  const due = await scheduler.dueRegions();
  const metrics = await scheduler.tick();

  assert.deepEqual(due, [], "chưa tới hạn thì không vùng nào due");
  assert.deepEqual(scanned, [], "restart không được kích hoạt quét sớm");
  assert.deepEqual(metrics, []);
});

test("§44 mọi vùng đã đến hạn đều được quét — không vùng nào bị bỏ đói", async () => {
  const { scheduler, states } = build({ vessels: 60 });
  const metrics = await scheduler.tick();

  assert.equal(metrics.length, REGIONS.length);
  for (const region of REGIONS) {
    assert.ok(states.saved.has(region.id), `vùng ${region.id} phải được quét và lưu lại`);
  }
});

test("§45 tick chồng lên tick đang chạy -> lượt thứ hai bị bỏ qua", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  const { scheduler } = build({
    scanArea: async () => { await gate; return ships(10); },
  });

  const first = scheduler.tick();
  const second = await scheduler.tick(); // chạy trong khi first còn dở
  assert.deepEqual(second, [], "tick chồng phải trả về rỗng, không quét lại");

  release!();
  const firstMetrics = await first;
  assert.equal(firstMetrics.length, REGIONS.length);
});

test("§24 hoàn thiện VesselBasics luôn bị chặn TRẦN, không chạy hết mọi tàu", async () => {
  const { scheduler, completed } = build({ vessels: 500, completionBudget: 15 });
  const metrics = await scheduler.tick();

  // 3 vùng × trần 15 = tối đa 45, KHÔNG phải 1500.
  assert.equal(completed.length, REGIONS.length * 15);
  for (const m of metrics) {
    assert.ok(m.completionRequests <= 15, `vùng ${m.regionId} vượt trần: ${m.completionRequests}`);
  }
});

test("§22 quét hỏng -> ghi FAILED, KHÔNG ghi vesselCount = 0", async () => {
  const { scheduler, states } = build({
    scanArea: async () => { throw new Error("[TIMEOUT] vesselfinder.SCAN_AREA"); },
  });
  const metrics = await scheduler.tick();

  assert.equal(metrics[0].outcome, RegionScanOutcome.FAILED);
  const saved = states.saved.get("r1")!;
  assert.equal(saved.consecutiveEmptyScans, 0, "hỏng không được tính là vùng rỗng");
  assert.equal(saved.lastVesselCount, null, "không được bịa ra số tàu bằng 0");
});


test("§13/§14 httpRequests đo từ runtime, KHÔNG phải đếm số lần gọi scanArea", async () => {
  // Một lần gọi scanArea nhưng runtime ghi nhận 3 request (2 lần retry).
  let counter = 0;
  const { scheduler } = build({
    vessels: 5,
    totalRequests: () => counter,
    scanArea: async () => { counter += 3; return ships(5); },
  });
  const metrics = await scheduler.tick();

  assert.equal(metrics[0].scanAreaCalls, 1, "đúng một lần gọi scanArea");
  assert.equal(metrics[0].httpRequests, 3, "phải lấy con số THẬT của runtime");
  assert.notEqual(metrics[0].scanAreaCalls, metrics[0].httpRequests);
});

test("§15 ứng viên hoàn thiện: tàu MỚI được ưu tiên trước tàu đã đủ dùng", async () => {
  const fresh = new Date(NOW.getTime() - 60_000);
  // 3 tàu: chỉ tàu thứ 3 là mới; hai tàu đầu đã đủ dùng.
  const sufficient = (mmsi: string) => ({
    vesselKey: { mmsi },
    identity: { vesselTypeCode: { value: 70 } },
    position: { position: { lat: 1, lng: 1 }, motion: { speed: 1, observedAt: fresh } },
  });
  const { scheduler, completed } = build({
    vessels: 3,
    completionBudget: 1,
    savedStatuses: ["SKIPPED_DUPLICATE", "SKIPPED_DUPLICATE", "SAVED"],
    currentVesselRepository: {
      async findManyByMmsi() {
        return [sufficient("200000000"), sufficient("200000001")];
      },
    },
  });
  await scheduler.tick();

  // Trần = 1, nên chỉ con tàu ĐƯỢC ƯU TIÊN NHẤT mới được gọi.
  assert.equal(completed.length, REGIONS.length);
  assert.ok(
    completed.every((m) => m === "200000002"),
    `phải chọn tàu mới, nhận: ${completed.join(",")}`
  );
});
