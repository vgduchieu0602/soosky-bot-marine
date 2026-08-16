// ============================================================================
//  TEST · SourceHealthTracker — NOT_FOUND không được giết một nguồn khoẻ
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { SourceErrorCategory } from "./SourceError";
import { SourceHealthState, SourceHealthTracker } from "./SourceHealthTracker";
import { DEFAULT_CRAWL_RUNTIME_CONFIG, SourceRuntimeConfig } from "./SourceRuntimeConfig";

/** Đồng hồ giả điều khiển tay — cooldown test được mà không chờ 5 phút. */
function fakeNow(): { advance: (ms: number) => void; now: () => Date } {
  let current = 0;
  return {
    advance: (ms) => {
      current += ms;
    },
    now: () => new Date(current),
  };
}

function trackerWith(
  overrides: Partial<SourceRuntimeConfig> = {},
  clock = fakeNow()
): { tracker: SourceHealthTracker; clock: ReturnType<typeof fakeNow> } {
  const config = { ...DEFAULT_CRAWL_RUNTIME_CONFIG, ...overrides };
  return {
    tracker: new SourceHealthTracker({
      source: VesselSource.SHIPINFO,
      config,
      now: clock.now,
    }),
    clock,
  };
}

test("khởi tạo là HEALTHY, mọi bộ đếm bằng 0", () => {
  const { tracker } = trackerWith();
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.state, SourceHealthState.HEALTHY);
  assert.equal(snapshot.totalRequests, 0);
  assert.equal(snapshot.averageLatencyMs, 0);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("success reset chuỗi hỏng và đưa về HEALTHY", () => {
  const { tracker } = trackerWith({ consecutiveFailuresBeforeCooldown: 5 });

  tracker.recordFailure(SourceErrorCategory.TIMEOUT);
  tracker.recordFailure(SourceErrorCategory.TIMEOUT);
  assert.equal(tracker.snapshot().consecutiveFailures, 2);
  assert.equal(tracker.getState(), SourceHealthState.DEGRADED);

  tracker.recordSuccess(120);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.consecutiveFailures, 0);
  assert.equal(snapshot.state, SourceHealthState.HEALTHY);
  assert.equal(snapshot.successCount, 1);
  assert.equal(snapshot.failureCount, 2);
  assert.ok(snapshot.lastSuccessAt instanceof Date);
});

test("NOT_FOUND KHÔNG tăng chuỗi hỏng, KHÔNG kích hoạt cooldown", () => {
  const { tracker } = trackerWith({ consecutiveFailuresBeforeCooldown: 3 });

  for (let i = 0; i < 50; i += 1) tracker.recordNotFound();
  // Đi qua recordFailure cũng phải rơi về đúng nhánh không-tính-hỏng.
  for (let i = 0; i < 50; i += 1) tracker.recordFailure(SourceErrorCategory.NOT_FOUND);

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.notFoundCount, 100);
  assert.equal(snapshot.consecutiveFailures, 0);
  assert.equal(snapshot.failureCount, 0);
  assert.equal(snapshot.state, SourceHealthState.HEALTHY);
  assert.equal(tracker.isAvailable(), true);
});

test("hỏng liên tiếp đủ ngưỡng -> COOLDOWN, có mốc hết hạn", () => {
  const { tracker } = trackerWith({ consecutiveFailuresBeforeCooldown: 3, cooldownMs: 60_000 });

  tracker.recordFailure(SourceErrorCategory.SERVER_ERROR);
  assert.equal(tracker.getState(), SourceHealthState.DEGRADED);
  tracker.recordFailure(SourceErrorCategory.SERVER_ERROR);
  assert.equal(tracker.getState(), SourceHealthState.DEGRADED);
  tracker.recordFailure(SourceErrorCategory.BLOCKED);

  assert.equal(tracker.getState(), SourceHealthState.COOLDOWN);
  assert.equal(tracker.isInCooldown(), true);
  assert.equal(tracker.isAvailable(), false);
  assert.equal(tracker.getCooldownUntil()?.getTime(), 60_000);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.serverErrorCount, 2);
  assert.equal(snapshot.blockedCount, 1);
});

test("cooldown hết hạn -> DEGRADED (được thử lại), không cần timer nền", () => {
  const { tracker, clock } = trackerWith({
    consecutiveFailuresBeforeCooldown: 1,
    cooldownMs: 60_000,
  });

  tracker.recordFailure(SourceErrorCategory.TIMEOUT);
  assert.equal(tracker.isAvailable(), false);

  clock.advance(59_999);
  assert.equal(tracker.isAvailable(), false);

  clock.advance(1);
  // Chỉ nhờ HỎI mà trạng thái đổi — không có setInterval nào chạy.
  assert.equal(tracker.getState(), SourceHealthState.DEGRADED);
  assert.equal(tracker.isAvailable(), true);
  assert.equal(tracker.getCooldownUntil(), undefined);
});

test("success sau cooldown -> HEALTHY", () => {
  const { tracker, clock } = trackerWith({
    consecutiveFailuresBeforeCooldown: 1,
    cooldownMs: 1000,
  });

  tracker.recordFailure(SourceErrorCategory.NETWORK_ERROR);
  clock.advance(1000);
  assert.equal(tracker.getState(), SourceHealthState.DEGRADED);

  tracker.recordSuccess(50);
  assert.equal(tracker.getState(), SourceHealthState.HEALTHY);
  assert.equal(tracker.snapshot().consecutiveFailures, 0);
});

test("averageLatencyMs chỉ tính lần thành công", () => {
  const { tracker } = trackerWith();
  tracker.recordSuccess(100);
  tracker.recordSuccess(300);
  tracker.recordFailure(SourceErrorCategory.TIMEOUT);
  assert.equal(tracker.snapshot().averageLatencyMs, 200);
});

test("DISABLED không tự thoát bằng thời gian, chỉ bật lại bằng tay", () => {
  const { tracker, clock } = trackerWith({ cooldownMs: 1000 });

  tracker.disable();
  assert.equal(tracker.getState(), SourceHealthState.DISABLED);
  assert.equal(tracker.isAvailable(), false);

  clock.advance(10_000);
  tracker.recordSuccess(10);
  assert.equal(tracker.getState(), SourceHealthState.DISABLED, "success không được tự bật lại");

  tracker.enable();
  assert.equal(tracker.getState(), SourceHealthState.DEGRADED);
  tracker.recordSuccess(10);
  assert.equal(tracker.getState(), SourceHealthState.HEALTHY);
});

test("mọi category có bộ đếm riêng", () => {
  const { tracker } = trackerWith({ consecutiveFailuresBeforeCooldown: 100 });
  tracker.recordFailure(SourceErrorCategory.TIMEOUT);
  tracker.recordFailure(SourceErrorCategory.BLOCKED);
  tracker.recordFailure(SourceErrorCategory.RATE_LIMITED);
  tracker.recordFailure(SourceErrorCategory.SERVER_ERROR);
  tracker.recordFailure(SourceErrorCategory.NETWORK_ERROR);
  tracker.recordFailure(SourceErrorCategory.PARSE_ERROR);
  tracker.recordFailure(SourceErrorCategory.UNKNOWN);

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.timeoutCount, 1);
  assert.equal(snapshot.blockedCount, 1);
  assert.equal(snapshot.rateLimitedCount, 1);
  assert.equal(snapshot.serverErrorCount, 1);
  assert.equal(snapshot.networkErrorCount, 1);
  assert.equal(snapshot.parseErrorCount, 1);
  assert.equal(snapshot.unknownErrorCount, 1);
  assert.equal(snapshot.failureCount, 7);
});
