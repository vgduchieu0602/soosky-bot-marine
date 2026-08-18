// ============================================================================
//  TEST · VesselFinder `lrpd` -> observedAt
// ----------------------------------------------------------------------------
//  Đồng hồ CỐ ĐỊNH ở mọi test: mốc suy ra phải phụ thuộc DUY NHẤT vào
//  (chuỗi nguồn, fetchedAt), không phụ thuộc lúc chạy test.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RELATIVE_AGE_MS,
  deriveVesselFinderObservedAt,
  parseVesselFinderRelativeAgeMs,
} from "./vesselFinderPositionTime";

const FETCHED_AT = new Date("2026-08-18T12:00:00.000Z");

test("tuổi tương đối '5 min ago' -> observedAt = fetchedAt - 5 phút", () => {
  const observedAt = deriveVesselFinderObservedAt("5 min ago", FETCHED_AT);
  assert.deepEqual(observedAt, new Date("2026-08-18T11:55:00.000Z"));
});

test("các cách viết phút/giờ/ngày đều ra đúng khoảng cách", () => {
  const cases: Array<[string, string]> = [
    ["1 min ago", "2026-08-18T11:59:00.000Z"],
    ["30 mins ago", "2026-08-18T11:30:00.000Z"],
    ["45 minutes ago", "2026-08-18T11:15:00.000Z"],
    ["1 hour ago", "2026-08-18T11:00:00.000Z"],
    ["2 hours ago", "2026-08-18T10:00:00.000Z"],
    ["3 hrs ago", "2026-08-18T09:00:00.000Z"],
    ["1 day ago", "2026-08-17T12:00:00.000Z"],
    ["2 days ago", "2026-08-16T12:00:00.000Z"],
    ["30 sec ago", "2026-08-18T11:59:30.000Z"],
  ];
  for (const [raw, expected] of cases) {
    assert.deepEqual(
      deriveVesselFinderObservedAt(raw, FETCHED_AT),
      new Date(expected),
      `chuỗi "${raw}"`
    );
  }
});

test("tuổi 0 GIỮ NGUYÊN là 0, không bị coi là thiếu", () => {
  // "0 min ago" nghĩa là bản tin vừa tới, KHÁC HẲN "nguồn không nói tuổi".
  assert.equal(parseVesselFinderRelativeAgeMs("0 min ago"), 0);
  assert.equal(parseVesselFinderRelativeAgeMs("just now"), 0);
  assert.deepEqual(deriveVesselFinderObservedAt("0 min ago", FETCHED_AT), FETCHED_AT);
  assert.deepEqual(deriveVesselFinderObservedAt("just now", FETCHED_AT), FETCHED_AT);
});

test("KHÔNG có tuổi -> null, tuyệt đối không rơi về fetchedAt", () => {
  for (const raw of [null, undefined, "", "   ", "-", "---", "n/a", "Unknown", "sometime"]) {
    const observedAt = deriveVesselFinderObservedAt(raw, FETCHED_AT);
    assert.equal(observedAt, null, `chuỗi ${JSON.stringify(raw)} phải cho null`);
    assert.notDeepEqual(observedAt, FETCHED_AT);
  }
});

test("tuổi vô lý (quá ngưỡng) -> null thay vì Date vô nghĩa", () => {
  assert.equal(parseVesselFinderRelativeAgeMs("400 days ago"), null);
  assert.equal(parseVesselFinderRelativeAgeMs("29 days ago"), 29 * 86_400_000);
  assert.ok(29 * 86_400_000 < MAX_RELATIVE_AGE_MS);
});

test("fetchedAt không hợp lệ -> null, không sinh Invalid Date", () => {
  assert.equal(deriveVesselFinderObservedAt("5 min ago", new Date("nonsense")), null);
});
