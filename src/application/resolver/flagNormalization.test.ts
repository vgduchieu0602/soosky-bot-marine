// ============================================================================
//  TEST · Chuẩn hoá mã cờ
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_ALPHA3_CODES, normalizeFlagCode } from "./flagNormalization";

test("alpha-2 giữ nguyên, chuẩn hoá hoa/thường và khoảng trắng", () => {
  assert.deepEqual(normalizeFlagCode("LR"), { code: "LR", known: true });
  assert.deepEqual(normalizeFlagCode(" lr "), { code: "LR", known: true });
});

test("alpha-3 CÓ bằng chứng -> quy đổi được", () => {
  assert.equal(normalizeFlagCode("LBR").code, "LR", "Liberia — AGIA DOXA");
  assert.equal(normalizeFlagCode("USA").code, "US", "MMSI 367452710");
  assert.equal(normalizeFlagCode("CHN").code, "CN", "QI XIAN LING");
});

test("alpha-3 LẠ -> không nhận dạng được, KHÔNG đoán bừa", () => {
  assert.deepEqual(normalizeFlagCode("ZWE"), { code: null, known: false });
  assert.deepEqual(normalizeFlagCode("PAN"), { code: null, known: false });
});

test("KHÔNG suy bằng tiền tố — CH (Thuỵ Sĩ) khác CHN (Trung Quốc)", () => {
  // Nếu dùng tiền tố, "CH" sẽ khớp "CHN" và hợp nhất hai quốc gia khác nhau.
  assert.equal(normalizeFlagCode("CH").code, "CH");
  assert.equal(normalizeFlagCode("CHN").code, "CN");
  assert.notEqual(normalizeFlagCode("CH").code, normalizeFlagCode("CHN").code);
});

test("đầu vào rác -> không nhận dạng được", () => {
  for (const bad of ["", "L", "LIBERIA", null, undefined, "  "]) {
    assert.deepEqual(normalizeFlagCode(bad as string), { code: null, known: false }, String(bad));
  }
});

test("bảng CHỈ chứa mã đã quan sát thật — không phải database quốc gia", () => {
  // Giữ nhỏ là CHỦ Ý. Thêm dòng khi và chỉ khi gặp mã đó trong dữ liệu thật.
  assert.ok(KNOWN_ALPHA3_CODES.length <= 10, `bảng đang có ${KNOWN_ALPHA3_CODES.length} dòng`);
  for (const code of KNOWN_ALPHA3_CODES) assert.equal(code.length, 3);
});
