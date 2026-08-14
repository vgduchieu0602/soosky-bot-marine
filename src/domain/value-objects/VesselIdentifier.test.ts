// ============================================================================
//  TEST · VesselIdentifier — định danh rác phải chết ngay tại chỗ dựng
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatVesselIdentifier,
  imoIdentifier,
  isVesselIdentifier,
  mmsiIdentifier,
  parseVesselIdentifier,
} from "./VesselIdentifier";

test("MMSI hợp lệ dựng được, giữ nguyên giá trị, đóng băng", () => {
  const identifier = mmsiIdentifier("305803000");
  assert.equal(identifier.type, "MMSI");
  assert.equal(identifier.value, "305803000");
  assert.equal(Object.isFrozen(identifier), true);
  // Nhận cả số, và cắt khoảng trắng thừa.
  assert.equal(mmsiIdentifier(305803000).value, "305803000");
  assert.equal(mmsiIdentifier("  305803000  ").value, "305803000");
});

test("IMO hợp lệ (đúng checksum ISO 8713) dựng được", () => {
  assert.equal(imoIdentifier("9074729").type, "IMO");
  assert.equal(imoIdentifier("9384198").value, "9384198");
});

test("MMSI không hợp lệ bị từ chối", () => {
  assert.throws(() => mmsiIdentifier("12345"), /MMSI không hợp lệ/); // quá ngắn
  assert.throws(() => mmsiIdentifier("012345678"), /MMSI không hợp lệ/); // bắt đầu bằng 0
  assert.throws(() => mmsiIdentifier("3058030001"), /MMSI không hợp lệ/); // quá dài
  assert.throws(() => mmsiIdentifier("30580300a"), /MMSI không hợp lệ/); // có chữ
  assert.throws(() => mmsiIdentifier(""), /MMSI không hợp lệ/);
});

test("IMO sai checksum bị từ chối, không chỉ kiểm độ dài", () => {
  // 9074729 hợp lệ; đổi đúng chữ số kiểm tra -> phải hỏng.
  assert.throws(() => imoIdentifier("9074728"), /IMO không hợp lệ/);
  assert.throws(() => imoIdentifier("9384199"), /IMO không hợp lệ/);
  assert.throws(() => imoIdentifier("907472"), /IMO không hợp lệ/); // 6 chữ số
  // Đủ 7 chữ số + đúng checksum thì hợp lệ, dù trông như số đếm.
  assert.equal(imoIdentifier("1234567").value, "1234567");
});

test("parseVesselIdentifier đoán trục: MMSI trước, IMO sau, không đoán được thì null", () => {
  assert.deepEqual(parseVesselIdentifier("305803000"), { type: "MMSI", value: "305803000" });
  assert.deepEqual(parseVesselIdentifier("9074729"), { type: "IMO", value: "9074729" });
  // Không ném — dữ liệu cũ trong DB không được phép làm sập tiến trình.
  assert.equal(parseVesselIdentifier("9074728"), null); // 7 số nhưng sai checksum
  assert.equal(parseVesselIdentifier("abc"), null);
  assert.equal(parseVesselIdentifier(null), null);
  assert.equal(parseVesselIdentifier(undefined), null);
});

test("isVesselIdentifier kiểm tra CẢ hình dạng LẪN tính hợp lệ", () => {
  assert.equal(isVesselIdentifier(mmsiIdentifier("305803000")), true);
  assert.equal(isVesselIdentifier({ type: "MMSI", value: "12345" }), false);
  assert.equal(isVesselIdentifier({ type: "IMO", value: "9074728" }), false);
  assert.equal(isVesselIdentifier({ type: "NAME", value: "EVER GIVEN" }), false);
  assert.equal(isVesselIdentifier("305803000"), false);
  assert.equal(isVesselIdentifier(null), false);
});

test("format dùng cho log", () => {
  assert.equal(formatVesselIdentifier(mmsiIdentifier("305803000")), "MMSI:305803000");
  assert.equal(formatVesselIdentifier(imoIdentifier("9074729")), "IMO:9074729");
});
