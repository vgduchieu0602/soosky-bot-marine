// ============================================================================
//  TEST · validators/identifiers — MMSI format + IMO checksum (ISO 8713)
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidMmsi, isValidImo, imoCheckDigit } from "./identifiers";

test("MMSI hợp lệ khi đúng 9 chữ số, chữ số đầu 1-9", () => {
  assert.equal(isValidMmsi("305803000"), true);
  assert.equal(isValidMmsi(305803000), true);
  assert.equal(isValidMmsi("  305803000  "), true);
});

test("MMSI sai độ dài bị loại", () => {
  assert.equal(isValidMmsi("30580300"), false); // 8 số
  assert.equal(isValidMmsi("3058030000"), false); // 10 số
  assert.equal(isValidMmsi(""), false);
});

test("MMSI bắt đầu bằng 0 bị loại (coast station / group call, không phải tàu)", () => {
  assert.equal(isValidMmsi("005803000"), false);
});

test("MMSI không phải chữ số bị loại", () => {
  assert.equal(isValidMmsi("30580300X"), false);
  assert.equal(isValidMmsi(null), false);
  assert.equal(isValidMmsi(undefined), false);
  assert.equal(isValidMmsi(3.14), false);
  assert.equal(isValidMmsi(-305803000), false);
});

test("IMO thật (đang dùng làm mẫu trong detectHtmlDrift) khớp checksum", () => {
  // 9*7 + 0*6 + 7*5 + 4*4 + 7*3 + 2*2 = 139 -> chữ số kiểm tra 9
  assert.equal(imoCheckDigit("9074729"), 9);
  assert.equal(isValidImo("9074729"), true);
  assert.equal(isValidImo("9384198"), true);
  assert.equal(isValidImo(9811983), true);
});

test("IMO sai checksum bị loại", () => {
  assert.equal(isValidImo("9074728"), false);
  assert.equal(isValidImo("9384190"), false);
  assert.equal(isValidImo("0000000"), true); // checksum đúng nhưng vô nghĩa
});

test("checksum chỉ chứng minh chuỗi hợp lệ về mặt hình thức, không chứng minh tàu có thật", () => {
  // 1*7+2*6+3*5+4*4+5*3+6*2 = 77 -> chữ số kiểm tra 7 -> "1234567" HỢP LỆ.
  // Ghi lại ở đây để lần sau không ai tưởng đây là bug.
  assert.equal(imoCheckDigit("1234567"), 7);
  assert.equal(isValidImo("1234567"), true);
});

test("IMO sai độ dài bị loại", () => {
  assert.equal(isValidImo("907472"), false);
  assert.equal(isValidImo("90747299"), false);
  assert.equal(isValidImo("abcdefg"), false);
  assert.equal(imoCheckDigit("907472"), null);
});

test("MMSI 9 số không phải IMO và ngược lại", () => {
  assert.equal(isValidImo("305803000"), false);
  assert.equal(isValidMmsi("9074729"), false);
});
