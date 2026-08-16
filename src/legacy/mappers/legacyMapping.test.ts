// ============================================================================
//  TEST · legacyMapping — canonical model biểu diễn ĐỦ dữ liệu entity hiện tại
// ----------------------------------------------------------------------------
//  Test này khoá lại bảng mapping trong CANONICAL_VESSEL_MODEL.md §3. Sửa
//  mapping mà quên sửa tài liệu (hoặc ngược lại) -> test đỏ.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { Vessel } from "../entities/Vessel";
import { VesselPosition } from "../entities/VesselPosition";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../domain/enums/VesselSource";
import {
  parseTimestamp,
  toVesselIdentity,
  toVesselParticulars,
  toVesselPositionReport,
  toVesselVoyage,
} from "./legacyMapping";

const META = createSourceMetadata({
  source: VesselSource.VESSELFINDER,
  fetchedAt: new Date("2026-08-12T00:00:00.000Z"),
});

const FULL_VESSEL = new Vessel({
  mmsi: "305803000",
  imo: "9074729",
  name: "TEST TRADER",
  type: "Container Ship",
  callsign: "V2BC7",
  flagCode: "AG",
  country: "Antigua Barbuda",
  yearBuilt: 1994,
  lengthM: 134,
  widthM: 22.5,
  grossTonnage: 7676,
  deadweight: 9000,
  draughtM: 6.8,
});

test("Identity: type -> vesselType, country -> flag.name, flagCode -> flag.code", () => {
  const identity = toVesselIdentity(FULL_VESSEL, META);
  assert.equal(identity.mmsi, "305803000");
  assert.equal(identity.imo, "9074729");
  assert.equal(identity.name, "TEST TRADER");
  assert.equal(identity.callsign, "V2BC7");
  assert.equal(identity.vesselType, "Container Ship");
  assert.deepEqual(identity.flag, { code: "AG", name: "Antigua Barbuda" });
  assert.equal(identity.metadata.source, "vesselfinder");
});

test("Identity: entity cũ không có mã loại tàu -> vesselTypeCode luôn null", () => {
  assert.equal(toVesselIdentity(FULL_VESSEL, META).vesselTypeCode, null);
});

test("Identity: không có cả flagCode lẫn country -> flag = null (không phải object rỗng)", () => {
  const bare = new Vessel({ mmsi: "305803000" });
  assert.equal(toVesselIdentity(bare, META).flag, null);
});

test("Particulars: đổi tên field, GIỮ NGUYÊN đơn vị mét/tấn/năm", () => {
  const particulars = toVesselParticulars(FULL_VESSEL, META);
  assert.equal(particulars.length, 134); // lengthM
  assert.equal(particulars.beam, 22.5); // widthM
  assert.equal(particulars.draught, 6.8); // draughtM
  assert.equal(particulars.builtYear, 1994); // yearBuilt
  assert.equal(particulars.grossTonnage, 7676);
  assert.equal(particulars.deadweight, 9000);
});

test("Position: lon -> lng, receivedAt chuỗi ISO -> Date UTC", () => {
  const position = new VesselPosition({
    mmsi: "305803000",
    lat: 1.29,
    lon: 103.85,
    speedKn: 12.4,
    courseDeg: 271,
    navStatusText: "Under way using engine",
    source: VesselSource.VESSELFINDER,
    latLonApproximate: false,
    receivedAt: "2026-08-11T23:00:00.000Z",
  });

  const report = toVesselPositionReport(position, META);
  assert.notEqual(report, null);
  assert.equal(report?.lat, 1.29);
  assert.equal(report?.lng, 103.85);
  assert.equal(report?.speed, 12.4);
  assert.equal(report?.course, 271);
  assert.equal(report?.latLngApproximate, false);
  assert.ok(report?.receivedAt instanceof Date);
  assert.equal(report?.receivedAt.toISOString(), "2026-08-11T23:00:00.000Z");
  assert.deepEqual(report?.navStatus, { code: null, text: "Under way using engine" });
});

test("Position: entity cũ cho phép thiếu toạ độ, canonical thì không -> trả null", () => {
  const noCoords = new VesselPosition({ mmsi: "305803000", lat: null, lon: null });
  assert.equal(toVesselPositionReport(noCoords, META), null);

  const outOfRange = new VesselPosition({ mmsi: "305803000", lat: 999, lon: 103.85 });
  assert.equal(toVesselPositionReport(outOfRange, META), null);
});

test("Position: thiếu khoá mmsi -> trả null thay vì dựng bản ghi mồ côi", () => {
  const noKey = new VesselPosition({ lat: 1.29, lon: 103.85 });
  assert.equal(toVesselPositionReport(noKey, META), null);
  assert.equal(toVesselVoyage(noKey, META), null);
});

test("Position: navStatus mặc định 'Unknown' + không có mã -> null, không tạo nhiễu", () => {
  const bare = new VesselPosition({ mmsi: "305803000", lat: 1.29, lon: 103.85 });
  assert.equal(toVesselPositionReport(bare, META)?.navStatus, null);
});

test("Voyage: destination/eta chuyển tiếp; cảng chưa có nguồn nào cấp -> null", () => {
  const position = new VesselPosition({
    mmsi: "305803000",
    destination: "SGSIN",
    eta: "2026-08-20T06:00:00.000Z",
  });
  const voyage = toVesselVoyage(position, META);
  assert.equal(voyage?.destination, "SGSIN");
  assert.equal(voyage?.eta?.toISOString(), "2026-08-20T06:00:00.000Z");
  assert.equal(voyage?.currentPort, null);
  assert.equal(voyage?.nextPort, null);
  assert.equal(voyage?.lastPort, null);
  assert.equal(voyage?.lastPortDepartureAt, null);
});

test("parseTimestamp: chuỗi rác / rỗng / null -> null, không sinh Invalid Date", () => {
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp(undefined), null);
  assert.equal(parseTimestamp("   "), null);
  // `positionTime` của entity cũ có dạng này -> đúng là phải bị loại.
  assert.equal(parseTimestamp("0 min ago"), null);
  assert.equal(parseTimestamp("2026-08-12T00:00:00.000Z")?.toISOString(), "2026-08-12T00:00:00.000Z");
});
