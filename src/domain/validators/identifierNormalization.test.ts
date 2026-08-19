// ============================================================================
//  TEST · normalizeImo / normalizeMmsi — sentinel của nguồn ngoài KHÔNG được
//  trở thành định danh canonical
// ----------------------------------------------------------------------------
//  Sự cố thật: ShipInfo trả `imo = "0"` cho tàu không có IMO. Chuỗi đó không
//  rỗng nên `imo ?? null` cho nó đi qua, rồi unique index `imo_1` coi MỌI tàu
//  không có IMO là cùng một con tàu -> E11000 làm hỏng cả lượt quét vùng.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { isValidImo, normalizeImo, normalizeMmsi } from "./identifiers";

test("A. IMO = \"0\" -> null", () => {
  assert.equal(normalizeImo("0"), null);
});

test("B. IMO = \"0000000\" -> null (checksum thoả nhưng không phải IMO được cấp)", () => {
  assert.equal(normalizeImo("0000000"), null);
  // Luật checksum thuần KHÔNG bị đổi — vẫn đúng như tài liệu hiện có.
  assert.equal(isValidImo("0000000"), true, "checksum rule giữ nguyên hành vi");
});

test("C. IMO rỗng -> null", () => {
  assert.equal(normalizeImo(""), null);
});

test("D. IMO toàn khoảng trắng -> null", () => {
  assert.equal(normalizeImo("   "), null);
  assert.equal(normalizeImo("\\t\\n"), null);
});

test("E. IMO hợp lệ được GIỮ NGUYÊN — không regression", () => {
  // 9074729 là IMO thật đang dùng trong fixture của repo.
  assert.equal(normalizeImo("9074729"), "9074729");
  assert.equal(normalizeImo(" 9074729 "), "9074729", "khoảng trắng thừa vẫn nhận");
  assert.equal(normalizeImo(9074729), "9074729", "nhận cả dạng số");
});

test("IMO sai checksum / sai độ dài -> null", () => {
  for (const value of ["9074720", "123456", "12345678", "abcdefg", null, undefined, "-1"]) {
    assert.equal(normalizeImo(value), null, `giá trị ${JSON.stringify(value)}`);
  }
});

test("MMSI: sentinel bị loại, giá trị thật được giữ", () => {
  assert.equal(normalizeMmsi("0"), null);
  assert.equal(normalizeMmsi("000000000"), null, "9 số 0 vẫn không phải MMSI");
  assert.equal(normalizeMmsi(""), null);
  assert.equal(normalizeMmsi("   "), null);
  assert.equal(normalizeMmsi("12345"), null, "thiếu chữ số");
  assert.equal(normalizeMmsi("235004461"), "235004461");
});
