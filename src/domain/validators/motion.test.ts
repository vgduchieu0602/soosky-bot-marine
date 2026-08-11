// ============================================================================
//  TEST · validators/motion — ngưỡng theo AIS message 1/2/3
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidSpeed, isValidCourse, isValidHeading } from "./motion";

test("SOG nhận 0..102.2 knots", () => {
  assert.equal(isValidSpeed(0), true);
  assert.equal(isValidSpeed(12.4), true);
  assert.equal(isValidSpeed(102.2), true);
});

test("SOG loại giá trị âm, quá ngưỡng và mã 'not available' (1023)", () => {
  assert.equal(isValidSpeed(-0.1), false);
  assert.equal(isValidSpeed(102.3), false);
  assert.equal(isValidSpeed(1023), false);
  assert.equal(isValidSpeed(NaN), false);
  assert.equal(isValidSpeed(null), false);
});

test("COG nhận [0, 360) — 360 bị loại vì trùng 0", () => {
  assert.equal(isValidCourse(0), true);
  assert.equal(isValidCourse(359.9), true);
  assert.equal(isValidCourse(360), false);
  assert.equal(isValidCourse(-1), false);
  assert.equal(isValidCourse(3600), false);
  assert.equal(isValidCourse("90"), false);
});

test("heading phải là số nguyên [0, 359]", () => {
  assert.equal(isValidHeading(0), true);
  assert.equal(isValidHeading(359), true);
  assert.equal(isValidHeading(360), false);
  assert.equal(isValidHeading(180.5), false);
  assert.equal(isValidHeading(511), false); // mã 'not available'
});
