// ============================================================================
//  TEST · validators/geo — giữ NGUYÊN hành vi BR-03 sau khi tách khỏi entity
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidLatitude, isValidLongitude, isValidCoordinates } from "./geo";

test("nhận toạ độ trong phạm vi, kể cả biên", () => {
  assert.equal(isValidLatitude(0), true);
  assert.equal(isValidLatitude(-90), true);
  assert.equal(isValidLatitude(90), true);
  assert.equal(isValidLongitude(-180), true);
  assert.equal(isValidLongitude(180), true);
  assert.equal(isValidLongitude(103.85), true);
});

test("loại toạ độ ngoài phạm vi trái đất", () => {
  assert.equal(isValidLatitude(90.1), false);
  assert.equal(isValidLatitude(-91), false);
  assert.equal(isValidLongitude(181), false);
  assert.equal(isValidLongitude(-180.5), false);
});

test("loại NaN / Infinity / kiểu sai — khớp hành vi cũ của VesselPosition", () => {
  for (const bad of [NaN, Infinity, -Infinity, null, undefined, "1.0", {}]) {
    assert.equal(isValidLatitude(bad), false);
    assert.equal(isValidLongitude(bad), false);
  }
});

test("isValidCoordinates cần CẢ HAI hợp lệ", () => {
  assert.equal(isValidCoordinates(1.29, 103.85), true);
  assert.equal(isValidCoordinates(1.29, null), false);
  assert.equal(isValidCoordinates(null, 103.85), false);
  assert.equal(isValidCoordinates(91, 103.85), false);
});
