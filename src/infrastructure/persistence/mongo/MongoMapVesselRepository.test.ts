// ============================================================================
//  TEST · Hình dạng truy vấn geo gửi xuống Mongo
// ----------------------------------------------------------------------------
//  `buildMapFilter` / `boxToPolygon` là hàm thuần -> kiểm được đúng thứ MAP-1
//  đã cảnh báo (`$box` vô hiệu hoá index) mà KHÔNG cần Mongo chạy.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { boxToPolygon, buildMapFilter } from "./MongoMapVesselRepository";

const BOX = { minLat: 5, minLon: 100, maxLat: 15, maxLon: 110 };

// ---------------------------------------------------------------------------
//  §5 + §34 · Polygon, KHÔNG phải $box
// ---------------------------------------------------------------------------

test("§5 vòng Polygon đóng kín, toạ độ [lon, lat]", () => {
  assert.deepEqual(boxToPolygon(BOX), {
    type: "Polygon",
    coordinates: [
      [
        [100, 5],
        [110, 5],
        [110, 15],
        [100, 15],
        [100, 5],
      ],
    ],
  });

  const ring = boxToPolygon(BOX).coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1], "vòng phải đóng kín");
  assert.equal(ring.length, 5);
});

test("§34 truy vấn dùng $geometry Polygon, TUYỆT ĐỐI không $box", () => {
  const filter = buildMapFilter({ boxes: [BOX], candidateLimit: 100 });
  const serialized = JSON.stringify(filter);

  assert.ok(serialized.includes("$geoWithin"));
  assert.ok(serialized.includes("$geometry"));
  assert.ok(serialized.includes("Polygon"));
  // MAP-1 đo được: `$box` là toán tử legacy -> rơi vào COLLSCAN với 2dsphere.
  assert.equal(serialized.includes("$box"), false);
  assert.equal(serialized.includes("$center"), false);
  assert.equal(serialized.includes("$centerSphere"), false);
});

test("một hộp -> lọc phẳng; hai hộp -> $or", () => {
  const single = buildMapFilter({ boxes: [BOX], candidateLimit: 10 });
  assert.equal("$or" in single, false);
  assert.ok("location" in single);

  const crossing = buildMapFilter({
    boxes: [
      { minLat: -10, maxLat: 10, minLon: 170, maxLon: 180 },
      { minLat: -10, maxLat: 10, minLon: -180, maxLon: -170 },
    ],
    candidateLimit: 10,
  });
  const or = (crossing as { $or: unknown[] }).$or;
  assert.equal(or.length, 2);
  assert.equal(JSON.stringify(crossing).includes("$box"), false);
});

// ---------------------------------------------------------------------------
//  §7 · Lọc sơ bộ theo mốc nguồn
// ---------------------------------------------------------------------------

test("§7 `observedSince` thành bộ lọc trên `position.observedAt`", () => {
  const since = new Date("2026-08-15T12:00:00.000Z");
  const filter = buildMapFilter({ boxes: [BOX], candidateLimit: 10, observedSince: since });
  assert.deepEqual(filter["position.observedAt"], { $gte: since });
});

test("cửa sổ thời gian có CẢ HAI cận — mốc tương lai không phải 'siêu tươi'", () => {
  const since = new Date("2026-08-15T12:00:00.000Z");
  const before = new Date("2026-08-16T12:05:00.000Z");
  const filter = buildMapFilter({
    boxes: [BOX],
    candidateLimit: 10,
    observedSince: since,
    observedBefore: before,
  });
  assert.deepEqual(filter["position.observedAt"], { $gte: since, $lte: before });
});

test("không truyền `observedSince` -> KHÔNG thêm bộ lọc thời gian", () => {
  const filter = buildMapFilter({ boxes: [BOX], candidateLimit: 10 });
  assert.equal("position.observedAt" in filter, false);
});

// ---------------------------------------------------------------------------
//  §19 + §20 · Chiếu Mongo phải bỏ nhóm nặng
// ---------------------------------------------------------------------------

test("§19 chiếu Mongo KHÔNG kéo particulars/voyage/rejected", async () => {
  // Đọc thẳng hằng số chiếu qua mã nguồn: nó là hằng nội bộ, nhưng đây đúng là
  // thứ quyết định một viewport nặng vài MB hay vài chục MB.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const source = await fs.readFile(
    path.join(__dirname, "MongoMapVesselRepository.ts"),
    "utf8"
  );
  const projection = /const MAP_PROJECTION = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(source)?.[1];
  assert.notEqual(projection, undefined);

  for (const heavy of ["particulars", "voyage", "rejected", "contentHash"]) {
    assert.equal(projection!.includes(heavy), false, `chiếu không được lấy \`${heavy}\``);
  }
  for (const needed of ["mmsi", "position", "identity.name", "identity.vesselTypeCode"]) {
    assert.ok(projection!.includes(needed), `chiếu thiếu \`${needed}\``);
  }
});
