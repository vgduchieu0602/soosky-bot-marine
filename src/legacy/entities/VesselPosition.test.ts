// ============================================================================
//  TEST · VesselPosition — CHỐT hành vi cũ không đổi sau A1
// ----------------------------------------------------------------------------
//  A1 đụng vào entity này 2 chỗ: dùng chung validator geo, và mở rộng
//  PositionSource. Test này tồn tại để chứng minh cả hai KHÔNG đổi hành vi
//  đang chạy production.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselPosition } from "./VesselPosition";
import { VesselSource } from "../../domain/enums/VesselSource";

test("source mặc định vẫn là 'unknown' — đúng chuỗi đang lưu trong DB", () => {
  const position = new VesselPosition({ mmsi: "305803000" });
  assert.equal(position.source, "unknown");
});

test("'vesselfinder' vẫn gán được nguyên văn (mọi write hiện tại dùng chuỗi này)", () => {
  const literal = new VesselPosition({ mmsi: "305803000", source: "vesselfinder" });
  assert.equal(literal.source, "vesselfinder");

  const viaConst = new VesselPosition({ mmsi: "305803000", source: VesselSource.VESSELFINDER });
  assert.equal(viaConst.source, "vesselfinder");
});

test("nguồn mới gán được mà không phải sửa entity", () => {
  const position = new VesselPosition({ mmsi: "305803000", source: VesselSource.AISSTREAM });
  assert.equal(position.source, "aisstream");
});

test("BR-03 giữ nguyên: toạ độ ngoài phạm vi -> null, không ném lỗi", () => {
  const bad = new VesselPosition({ mmsi: "305803000", lat: 999, lon: -200 });
  assert.equal(bad.lat, null);
  assert.equal(bad.lon, null);
  assert.equal(bad.hasCoordinates(), false);

  const good = new VesselPosition({ mmsi: "305803000", lat: 1.29, lon: 103.85 });
  assert.equal(good.lat, 1.29);
  assert.equal(good.lon, 103.85);
  assert.equal(good.hasCoordinates(), true);
});

test("khoá rơi về IMO khi thiếu MMSI; receivedAt giữ nguyên chuỗi ISO khi đọc lại từ DB", () => {
  const position = new VesselPosition({
    imo: "9074729",
    receivedAt: "2026-08-11T23:00:00.000Z",
  });
  assert.equal(position.mmsi, "9074729");
  assert.equal(typeof position.receivedAt, "string");
  assert.equal(position.receivedAt, "2026-08-11T23:00:00.000Z");
});
