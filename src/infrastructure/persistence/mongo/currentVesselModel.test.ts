// ============================================================================
//  TEST · Phép chiếu GeoJSON + schema canonical_current_vessels
// ----------------------------------------------------------------------------
//  `toGeoJsonPoint` là hàm thuần nên test được thứ tự toạ độ mà KHÔNG cần Mongo.
//  Phần index chỉ đọc CẤU HÌNH schema — cũng không cần connection.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import { ResolvedCurrentVessel } from "../../../application/services/resolution/ResolvedCurrentVessel";
import { CurrentVesselModel } from "./currentVesselModel";
import { toGeoJsonPoint } from "./MongoCurrentVesselRepository";

const NOW = new Date("2026-08-16T12:00:00.000Z");

function vesselAt(lat: number, lng: number): ResolvedCurrentVessel {
  const position: VesselPositionReport = {
    mmsi: "636018086",
    imo: null,
    lat,
    lng,
    speed: 10,
    course: 90,
    heading: null,
    navStatus: null,
    latLngApproximate: false,
    receivedAt: NOW,
    metadata: createSourceMetadata({
      source: VesselSource.AISSTREAM,
      fetchedAt: NOW,
      sourceReceivedAt: NOW,
    }),
  };
  return {
    vesselKey: { mmsi: "636018086" },
    identity: null,
    position: {
      position,
      source: VesselSource.AISSTREAM,
      observedAt: NOW,
      fetchedAt: NOW,
      freshness: "LIVE",
      reason: "ONLY_AVAILABLE_VALUE",
      rejected: [],
    } as never,
    particulars: null,
    voyage: null,
    resolvedAt: NOW,
  };
}

function vesselWithoutPosition(): ResolvedCurrentVessel {
  return {
    vesselKey: { mmsi: "636018086" },
    identity: null,
    position: null,
    particulars: null,
    voyage: null,
    resolvedAt: NOW,
  };
}

// ---------------------------------------------------------------------------
//  §8 + §26 · THỨ TỰ TOẠ ĐỘ
// ---------------------------------------------------------------------------

test("§26 lat=10 lng=106 -> coordinates=[106,10] — GeoJSON là [lng, lat]", () => {
  const point = toGeoJsonPoint(vesselAt(10, 106));
  assert.deepEqual(point, { type: "Point", coordinates: [106, 10] });
  // Đảo nhầm thì Vũng Tàu (10,106) thành (10,106)->[10,106] = giữa Somalia, và
  // Mongo KHÔNG kêu vì cả hai đều là toạ độ hợp lệ. Nên khoá chặt ở đây.
  assert.notDeepEqual(point?.coordinates, [10, 106]);
});

test("dấu âm giữ nguyên: Nam bán cầu và Tây bán cầu", () => {
  assert.deepEqual(toGeoJsonPoint(vesselAt(-33.86, 151.2))?.coordinates, [151.2, -33.86]);
  assert.deepEqual(toGeoJsonPoint(vesselAt(33.74, -118.2))?.coordinates, [-118.2, 33.74]);
});

// ---------------------------------------------------------------------------
//  §11 + §12 · Không dựng Point từ dữ liệu không dùng được
// ---------------------------------------------------------------------------

test("§11 canonical không có vị trí -> null (repository sẽ $unset)", () => {
  assert.equal(toGeoJsonPoint(vesselWithoutPosition()), null);
});

test("§12 toạ độ hỏng -> null, KHÔNG dựng Point rác", () => {
  for (const [lat, lng] of [
    [91, 10],
    [-91, 10],
    [10, 181],
    [10, -181],
    [Number.NaN, 10],
    [10, Number.POSITIVE_INFINITY],
  ] as const) {
    assert.equal(toGeoJsonPoint(vesselAt(lat, lng)), null, `${lat},${lng}`);
  }
});

test("biên hợp lệ vẫn dựng được Point", () => {
  assert.deepEqual(toGeoJsonPoint(vesselAt(90, 180))?.coordinates, [180, 90]);
  assert.deepEqual(toGeoJsonPoint(vesselAt(-90, -180))?.coordinates, [-180, -90]);
  assert.deepEqual(toGeoJsonPoint(vesselAt(0, 0))?.coordinates, [0, 0]);
});

// ---------------------------------------------------------------------------
//  §13 + §21 · Index
// ---------------------------------------------------------------------------

type IndexEntry = [Record<string, number | string>, Record<string, unknown>];

function indexes(): IndexEntry[] {
  return CurrentVesselModel.schema.indexes() as IndexEntry[];
}

test("§21 có 2dsphere index trên `location`", () => {
  const geo = indexes().find(([keys]) => keys.location === "2dsphere");
  assert.notEqual(geo, undefined, "thiếu 2dsphere index");
  // Chỉ `location`, không compound đoán trước.
  assert.deepEqual(Object.keys(geo![0]), ["location"]);
});

test("§31 index MMSI/IMO cũ KHÔNG bị đụng", () => {
  const signatures = indexes().map(([keys]) => Object.keys(keys).join(","));
  assert.ok(signatures.includes("mmsi"));
  assert.ok(signatures.includes("imo"));
});

test("§29 canonical_current_vessels KHÔNG có TTL", () => {
  const ttl = indexes().filter(([, options]) => options.expireAfterSeconds !== undefined);
  assert.deepEqual(ttl, [], "canonical là ảnh chụp hiện tại, hết hạn là việc của lúc ĐỌC");
});

test("§13 KHÔNG thêm index geo vào vessel_observations", async () => {
  const { VesselObservationModel } = await import("./observationModels");
  const geo = (VesselObservationModel.schema.indexes() as IndexEntry[]).filter(([keys]) =>
    Object.values(keys).includes("2dsphere")
  );
  assert.deepEqual(geo, [], "truy vấn map chạy trên canonical, không trên nhật ký observation");
});

test("`location` không required và không có default -> tàu chưa có vị trí thì field VẮNG MẶT", () => {
  const path = CurrentVesselModel.schema.path("location.coordinates");
  assert.notEqual(path, undefined);
  assert.notEqual(path.isRequired, true);
});
