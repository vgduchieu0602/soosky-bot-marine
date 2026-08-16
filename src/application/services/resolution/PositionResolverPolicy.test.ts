// ============================================================================
//  TEST · Chính sách độ tươi POSITION
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POSITION_RESOLVER_POLICY,
  PositionFreshness,
  classifyPositionFreshness,
  freshnessRank,
} from "./PositionResolverPolicy";

const NOW = new Date("2026-08-14T16:40:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

test("ngưỡng mặc định khớp hằng số hệ thống đã có", () => {
  const p = DEFAULT_POSITION_RESOLVER_POLICY;
  assert.equal(p.liveMaxAgeMs, 30 * MINUTE);
  assert.equal(p.recentMaxAgeMs, 6 * HOUR, "= SCAN_INTERVAL_MS mặc định");
  assert.equal(p.staleMaxAgeMs, 24 * HOUR, "= POSITION_STALE_AFTER_MS");
  // Cửa sổ nạp ứng viên phải RỘNG HƠN ngưỡng STALE, nếu không EXPIRED và
  // NO_SOURCE_TIME không bao giờ tới được resolver.
  assert.ok(p.candidateWindowMs > p.staleMaxAgeMs);
  assert.equal(Object.isFrozen(p), true);
});

test("xếp bậc theo tuổi", () => {
  assert.equal(classifyPositionFreshness(ago(0), NOW), PositionFreshness.LIVE);
  assert.equal(classifyPositionFreshness(ago(29 * MINUTE), NOW), PositionFreshness.LIVE);
  assert.equal(classifyPositionFreshness(ago(30 * MINUTE), NOW), PositionFreshness.LIVE);
  assert.equal(classifyPositionFreshness(ago(31 * MINUTE), NOW), PositionFreshness.RECENT);
  assert.equal(classifyPositionFreshness(ago(6 * HOUR), NOW), PositionFreshness.RECENT);
  assert.equal(classifyPositionFreshness(ago(6 * HOUR + 1), NOW), PositionFreshness.STALE);
  assert.equal(classifyPositionFreshness(ago(24 * HOUR), NOW), PositionFreshness.STALE);
  assert.equal(classifyPositionFreshness(ago(24 * HOUR + 1), NOW), PositionFreshness.EXPIRED);
});

test("số đo THẬT của hai nguồn rơi vào hai bậc khác nhau", () => {
  // ShipFinder 0.02h, ShipInfo 14.49h — đúng số liệu POC.
  assert.equal(
    classifyPositionFreshness(new Date("2026-08-14T16:39:41.000Z"), NOW),
    PositionFreshness.LIVE
  );
  assert.equal(
    classifyPositionFreshness(new Date("2026-08-13T20:11:07.000Z"), NOW),
    PositionFreshness.STALE
  );
});

test("thiếu mốc nguồn -> NO_SOURCE_TIME, KHÔNG rơi về fetchedAt", () => {
  assert.equal(classifyPositionFreshness(null, NOW), PositionFreshness.NO_SOURCE_TIME);
  assert.equal(classifyPositionFreshness(undefined, NOW), PositionFreshness.NO_SOURCE_TIME);
  assert.equal(
    classifyPositionFreshness(new Date("không phải ngày"), NOW),
    PositionFreshness.NO_SOURCE_TIME
  );
});

test("NO_SOURCE_TIME xếp THẤP HƠN cả EXPIRED", () => {
  assert.ok(
    freshnessRank(PositionFreshness.NO_SOURCE_TIME) > freshnessRank(PositionFreshness.EXPIRED),
    "không biết tuổi phải tệ hơn biết là đã quá hạn"
  );
  assert.deepEqual(
    [
      PositionFreshness.LIVE,
      PositionFreshness.RECENT,
      PositionFreshness.STALE,
      PositionFreshness.EXPIRED,
      PositionFreshness.NO_SOURCE_TIME,
    ].map(freshnessRank),
    [0, 1, 2, 3, 4]
  );
});

test("policy tuỳ chỉnh được, resolver không ghim số nào", () => {
  const strict = {
    liveMaxAgeMs: MINUTE,
    recentMaxAgeMs: 5 * MINUTE,
    staleMaxAgeMs: 10 * MINUTE,
    candidateWindowMs: HOUR,
  };
  assert.equal(classifyPositionFreshness(ago(2 * MINUTE), NOW, strict), PositionFreshness.RECENT);
  assert.equal(classifyPositionFreshness(ago(20 * MINUTE), NOW, strict), PositionFreshness.EXPIRED);
});
