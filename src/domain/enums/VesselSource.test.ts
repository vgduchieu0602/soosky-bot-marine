// ============================================================================
//  TEST · VesselSource — mở rộng được NHƯNG không phá dữ liệu đang nằm trong DB
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VesselSource,
  VESSEL_SOURCES,
  isVesselSource,
  parseVesselSource,
} from "./VesselSource";

test("giá trị lưu xuống DB của 2 nguồn cũ KHÔNG đổi (backward compatibility)", () => {
  // Đây là 2 chuỗi duy nhất persistence hiện tại từng ghi.
  assert.equal(VesselSource.VESSELFINDER, "vesselfinder");
  assert.equal(VesselSource.UNKNOWN, "unknown");
  assert.equal(parseVesselSource("vesselfinder"), "vesselfinder");
  assert.equal(parseVesselSource("unknown"), "unknown");
});

test("đủ 10 nguồn canonical, mọi giá trị là chữ thường", () => {
  assert.equal(VESSEL_SOURCES.length, 10);
  for (const value of VESSEL_SOURCES) {
    assert.equal(value, value.toLowerCase());
  }
  for (const expected of [
    "aisstream",
    "vesselfinder",
    "shipinfo",
    "shipfinder",
    "boatnerd",
    "marinetraffic_live",
    "shiptraffic",
    "vesseltracker",
    "myshiptracking",
    "unknown",
  ]) {
    assert.equal(VESSEL_SOURCES.includes(expected as VesselSource), true, expected);
  }
});

test("parse chấp nhận dạng hằng viết hoa và dấu gạch ngang", () => {
  assert.equal(parseVesselSource("MARINETRAFFIC_LIVE"), VesselSource.MARINETRAFFIC_LIVE);
  assert.equal(parseVesselSource("marinetraffic-live"), VesselSource.MARINETRAFFIC_LIVE);
  assert.equal(parseVesselSource("  AISStream "), VesselSource.AISSTREAM);
});

test("giá trị lạ -> UNKNOWN, KHÔNG ném lỗi (dữ liệu cũ không được làm sập tiến trình đọc)", () => {
  assert.equal(parseVesselSource("nguon-la"), VesselSource.UNKNOWN);
  assert.equal(parseVesselSource(""), VesselSource.UNKNOWN);
  assert.equal(parseVesselSource(null), VesselSource.UNKNOWN);
  assert.equal(parseVesselSource(42), VesselSource.UNKNOWN);
});

test("isVesselSource chỉ nhận đúng giá trị chuẩn", () => {
  assert.equal(isVesselSource("vesselfinder"), true);
  assert.equal(isVesselSource("VESSELFINDER"), false); // chưa chuẩn hoá
  assert.equal(isVesselSource("nguon-la"), false);
});
