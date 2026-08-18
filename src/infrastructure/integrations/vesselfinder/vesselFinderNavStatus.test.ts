// ============================================================================
//  TEST · VesselFinder "Navigation Status" -> mã AIS
// ----------------------------------------------------------------------------
//  Trọng tâm: mã 0 là GIÁ TRỊ, không phải "thiếu". Mọi kiểm tra kiểu
//  `code || null` sẽ làm test này đỏ.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isUsableVesselFinderNavStatusText,
  parseVesselFinderNavStatusCode,
  toVesselFinderNavigationStatus,
} from "./vesselFinderNavStatus";

test("mã 0 (under way using engine) được giữ nguyên là 0", () => {
  assert.equal(parseVesselFinderNavStatusCode("Under way using engine"), 0);
  const status = toVesselFinderNavigationStatus("Under way using engine");
  assert.notEqual(status, null);
  assert.equal(status!.code, 0);
  // Bẫy kinh điển: 0 là falsy. Nhóm phải TỒN TẠI chứ không bị nuốt.
  assert.ok(status!.code !== null && status!.code !== undefined);
});

test("các mã hợp lệ khác, gồm 5 và 15", () => {
  const cases: Array<[string, number]> = [
    ["At anchor", 1],
    ["Not under command", 2],
    ["Restricted manoeuvrability", 3],
    ["Constrained by her draught", 4],
    ["Moored", 5],
    ["Aground", 6],
    ["Engaged in fishing", 7],
    ["Under way sailing", 8],
    ["Undefined", 15],
  ];
  for (const [text, code] of cases) {
    assert.equal(parseVesselFinderNavStatusCode(text), code, `nhãn "${text}"`);
  }
});

test("hoa/thường và khoảng trắng thừa không đổi kết quả", () => {
  assert.equal(parseVesselFinderNavStatusCode("  MOORED  "), 5);
  assert.equal(parseVesselFinderNavStatusCode("under  way   using engine"), 0);
});

test("ô trống của nguồn KHÔNG phải trạng thái", () => {
  for (const text of [null, undefined, "", "  ", "-", "--", "---", "Unknown", "N/A"]) {
    assert.equal(isUsableVesselFinderNavStatusText(text), false, `nhãn ${JSON.stringify(text)}`);
    assert.equal(parseVesselFinderNavStatusCode(text), null);
    assert.equal(toVesselFinderNavigationStatus(text), null);
  }
});

test("nhãn lạ nhưng CÓ nội dung: giữ chữ, mã null", () => {
  const status = toVesselFinderNavigationStatus("Power-driven vessel towing astern");
  assert.notEqual(status, null);
  assert.equal(status!.code, null);
  assert.equal(status!.text, "Power-driven vessel towing astern");
});
