// ============================================================================
//  TEST · RegionSchedulePolicy — nhịp quét phải nằm trong khoảng, và phải
//  phân biệt được "vùng vắng tàu" với "nguồn hỏng"
// ----------------------------------------------------------------------------
//  `random` được TIÊM vào nên mọi khoảng thời gian ở đây là tất định.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RegionScanOutcome,
  RegionSchedulePolicy,
  RegionScheduleState,
} from "./RegionSchedulePolicy";
import {
  ABSOLUTE_MAX_INTERVAL_MS,
  ABSOLUTE_MIN_INTERVAL_MS,
  DEFAULT_TIER_INTERVALS,
  RegionTrafficTier,
} from "../../../config/maritimeRegions";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** random cố định -> khoảng thời gian tất định. */
const fixed = (value: number) => () => value;

function policy(random = fixed(0.5)): RegionSchedulePolicy {
  return new RegionSchedulePolicy({ random });
}

function stateWith(overrides: Partial<RegionScheduleState> = {}): RegionScheduleState {
  return {
    regionId: "uk-english-channel",
    tier: RegionTrafficTier.MEDIUM,
    intervalMs: 45 * MINUTE,
    lastScanAt: null,
    nextScanAt: NOW,
    lastVesselCount: null,
    averageVesselCount: null,
    newVesselCount: null,
    consecutiveEmptyScans: 0,
    lastOutcome: null,
    lastErrorAt: null,
    ...overrides,
  };
}

/** Quét thành công `times` lần với cùng số tàu. */
function scanRepeatedly(
  p: RegionSchedulePolicy,
  start: RegionScheduleState,
  vesselCount: number,
  times: number
): RegionScheduleState {
  let state = start;
  for (let i = 0; i < times; i++) {
    state = p.next(state, { outcome: RegionScanOutcome.SUCCESS, vesselCount }, NOW);
  }
  return state;
}

// ---------------------------------------------------------------------------
//  §38–§41 — phân bậc theo mật độ đo được
// ---------------------------------------------------------------------------

test("§38 vùng đông tàu liên tục -> HIGH, nhịp trong khoảng HIGH", () => {
  const p = policy();
  const state = scanRepeatedly(p, stateWith(), 120, 4);
  assert.equal(state.tier, RegionTrafficTier.HIGH);
  assert.ok(state.intervalMs >= 10 * MINUTE && state.intervalMs <= 20 * MINUTE,
    `nhịp ${state.intervalMs}ms phải nằm trong 10–20 phút`);
});

test("§39 mật độ trung bình -> MEDIUM, nhịp 30–60 phút", () => {
  const p = policy();
  const state = scanRepeatedly(p, stateWith(), 25, 4);
  assert.equal(state.tier, RegionTrafficTier.MEDIUM);
  assert.ok(state.intervalMs >= 30 * MINUTE && state.intervalMs <= 60 * MINUTE,
    `nhịp ${state.intervalMs}ms phải nằm trong 30–60 phút`);
});

test("§40 mật độ thấp -> LOW, nhịp 2–4 giờ", () => {
  const p = policy();
  const state = scanRepeatedly(p, stateWith(), 3, 4);
  assert.equal(state.tier, RegionTrafficTier.LOW);
  assert.ok(state.intervalMs >= 2 * HOUR && state.intervalMs <= 4 * HOUR,
    `nhịp ${state.intervalMs}ms phải nằm trong 2–4 giờ`);
});

test("§41 rỗng liên tiếp -> streak tăng, lùi DẦN rồi mới tới EMPTY_OR_RARE", () => {
  const p = policy();
  let state = stateWith();

  // Lần rỗng ĐẦU TIÊN chỉ được xuống LOW — không nhảy thẳng 12 tiếng (§11).
  state = p.next(state, { outcome: RegionScanOutcome.SUCCESS, vesselCount: 0 }, NOW);
  assert.equal(state.consecutiveEmptyScans, 1);
  assert.equal(state.tier, RegionTrafficTier.LOW);
  assert.ok(state.intervalMs <= 4 * HOUR, "một lần rỗng chưa được đẩy lên 6–12 giờ");

  state = p.next(state, { outcome: RegionScanOutcome.SUCCESS, vesselCount: 0 }, NOW);
  assert.equal(state.consecutiveEmptyScans, 2);
  assert.equal(state.tier, RegionTrafficTier.LOW);

  state = p.next(state, { outcome: RegionScanOutcome.SUCCESS, vesselCount: 0 }, NOW);
  assert.equal(state.consecutiveEmptyScans, 3);
  assert.equal(state.tier, RegionTrafficTier.EMPTY_OR_RARE);
  assert.ok(state.intervalMs >= 6 * HOUR && state.intervalMs <= 12 * HOUR,
    `nhịp ${state.intervalMs}ms phải nằm trong 6–12 giờ`);
});

test("§12 vùng đang rỗng bỗng có tàu -> quay lại ngay, không chờ 12 giờ", () => {
  const p = policy();
  let state = scanRepeatedly(p, stateWith(), 0, 4);
  assert.equal(state.tier, RegionTrafficTier.EMPTY_OR_RARE);

  state = p.next(state, { outcome: RegionScanOutcome.SUCCESS, vesselCount: 40 }, NOW);
  assert.equal(state.consecutiveEmptyScans, 0, "streak phải được reset");
  assert.notEqual(state.tier, RegionTrafficTier.EMPTY_OR_RARE);
  assert.ok(state.intervalMs <= 4 * HOUR, "phải quay về nhịp LOW/MEDIUM trở lên");
});

// ---------------------------------------------------------------------------
//  §42 — HỎNG KHÔNG PHẢI VẮNG TÀU
// ---------------------------------------------------------------------------

test("§42 quét hỏng KHÔNG làm tăng streak rỗng, KHÔNG hạ bậc vùng", () => {
  const p = policy();
  const busy = scanRepeatedly(p, stateWith(), 120, 3);
  assert.equal(busy.tier, RegionTrafficTier.HIGH);

  for (const outcome of [RegionScanOutcome.FAILED, RegionScanOutcome.SKIPPED_COOLDOWN]) {
    const after = p.next(busy, { outcome }, NOW);
    assert.equal(after.consecutiveEmptyScans, 0, `${outcome} không được tăng streak`);
    assert.equal(after.tier, RegionTrafficTier.HIGH, `${outcome} không được hạ bậc`);
    assert.equal(after.lastVesselCount, busy.lastVesselCount, "số tàu đo được phải giữ nguyên");
    assert.equal(after.averageVesselCount, busy.averageVesselCount, "trung bình phải giữ nguyên");
    // Lần quét này KHÔNG diễn ra -> không được coi là đã quét.
    assert.equal(after.lastScanAt, busy.lastScanAt);
  }
});

test("§42 timeout liên tiếp cũng không bao giờ biến vùng đông thành EMPTY", () => {
  const p = policy();
  let state = scanRepeatedly(p, stateWith(), 120, 3);
  for (let i = 0; i < 10; i++) {
    state = p.next(state, { outcome: RegionScanOutcome.FAILED }, NOW);
  }
  assert.equal(state.tier, RegionTrafficTier.HIGH);
  assert.equal(state.consecutiveEmptyScans, 0);
});

// ---------------------------------------------------------------------------
//  §43 — biên jitter
// ---------------------------------------------------------------------------

test("§43 mọi bậc: nhịp sinh ra luôn nằm trong [min,max] của bậc đó", () => {
  const tiers = Object.values(RegionTrafficTier);
  // Quét cả biên: random = 0 và random -> gần 1.
  for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
    const p = policy(fixed(r));
    for (const tier of tiers) {
      const ms = p.intervalFor(tier);
      const range = DEFAULT_TIER_INTERVALS[tier];
      assert.ok(ms >= range.minMs, `${tier} @${r}: ${ms} < min ${range.minMs}`);
      assert.ok(ms <= range.maxMs, `${tier} @${r}: ${ms} > max ${range.maxMs}`);
    }
  }
});

test("§13 nhịp luôn bị kẹp trong chặn tuyệt đối, kể cả khi cấu hình sai", () => {
  // Cấu hình cố tình vô lý: 1 giây và 30 ngày.
  const p = new RegionSchedulePolicy({
    random: fixed(0),
    intervals: {
      ...DEFAULT_TIER_INTERVALS,
      [RegionTrafficTier.HIGH]: { minMs: 1000, maxMs: 1000 },
      [RegionTrafficTier.EMPTY_OR_RARE]: { minMs: 30 * 24 * HOUR, maxMs: 30 * 24 * HOUR },
    },
  });
  assert.equal(p.intervalFor(RegionTrafficTier.HIGH), ABSOLUTE_MIN_INTERVAL_MS);
  assert.equal(p.intervalFor(RegionTrafficTier.EMPTY_OR_RARE), ABSOLUTE_MAX_INTERVAL_MS);
});

test("§14 hai vùng cùng bậc, random khác nhau -> nextScanAt KHÔNG trùng nhau", () => {
  const a = policy(fixed(0.1)).next(stateWith({ regionId: "a" }), { outcome: RegionScanOutcome.SUCCESS, vesselCount: 120 }, NOW);
  const b = policy(fixed(0.9)).next(stateWith({ regionId: "b" }), { outcome: RegionScanOutcome.SUCCESS, vesselCount: 120 }, NOW);
  assert.equal(a.tier, b.tier);
  assert.notEqual(a.nextScanAt.getTime(), b.nextScanAt.getTime(), "jitter phải rải hai vùng ra");
});
