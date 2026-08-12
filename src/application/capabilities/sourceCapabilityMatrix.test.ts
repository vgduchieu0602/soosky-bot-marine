// ============================================================================
//  TEST · SOURCE_CAPABILITY_MATRIX — tính đầy đủ, tính bất biến, tính TRUNG THỰC
// ----------------------------------------------------------------------------
//  Nhóm test quan trọng nhất ở đây là "trung thực": chặn việc đánh CONFIRMED
//  cho field mà code hiện tại KHÔNG bóc được.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselField, VESSEL_FIELDS } from "../../domain/value-objects/VesselField";
import { VesselSource, VESSEL_SOURCES } from "../../domain/value-objects/VesselSource";
import { FieldSupportStatus, SourceCostType } from "./SourceCapability";
import { SOURCE_CAPABILITY_MATRIX } from "./sourceCapabilityMatrix";

test("matrix có entry cho MỌI VesselSource, không thiếu nguồn nào", () => {
  for (const source of VESSEL_SOURCES) {
    const capability = SOURCE_CAPABILITY_MATRIX[source];
    assert.ok(capability, `thiếu capability cho ${source}`);
    assert.equal(capability.source, source);
  }
  assert.equal(Object.keys(SOURCE_CAPABILITY_MATRIX).length, VESSEL_SOURCES.length);
});

test("mọi entry khai đủ 28 field, không field nào undefined", () => {
  for (const source of VESSEL_SOURCES) {
    const { fields } = SOURCE_CAPABILITY_MATRIX[source];
    assert.equal(Object.keys(fields).length, VESSEL_FIELDS.length, source);
    for (const field of VESSEL_FIELDS) {
      assert.ok(
        Object.values(FieldSupportStatus).includes(fields[field]),
        `${source}.${field} = ${fields[field]}`
      );
    }
  }
});

test("UNKNOWN: mọi field UNSUPPORTED, mọi operation false, enabled=false", () => {
  const capability = SOURCE_CAPABILITY_MATRIX[VesselSource.UNKNOWN];
  for (const field of VESSEL_FIELDS) {
    assert.equal(capability.fields[field], FieldSupportStatus.UNSUPPORTED, field);
  }
  for (const [name, enabled] of Object.entries(capability.operations)) {
    assert.equal(enabled, false, name);
  }
  assert.equal(capability.enabled, false);
});

test("VesselFinder: MMSI/LAT/LNG CONFIRMED (mp2 decoder đã bóc được)", () => {
  const { fields } = SOURCE_CAPABILITY_MATRIX[VesselSource.VESSELFINDER];
  assert.equal(fields[VesselField.MMSI], FieldSupportStatus.CONFIRMED);
  assert.equal(fields[VesselField.LAT], FieldSupportStatus.CONFIRMED);
  assert.equal(fields[VesselField.LNG], FieldSupportStatus.CONFIRMED);
  assert.equal(fields[VesselField.NAME], FieldSupportStatus.CONFIRMED);
});

test("VesselFinder: field mapper KHÔNG bóc thì KHÔNG được CONFIRMED", () => {
  const { fields } = SOURCE_CAPABILITY_MATRIX[VesselSource.VESSELFINDER];
  // Mongo schema có cột nhưng VesselFinderHtmlMapper không parse
  // (CURRENT_DATA_FLOW.md §2.3) -> phải là CANDIDATE, không phải CONFIRMED.
  for (const field of [
    VesselField.GROSS_TONNAGE,
    VesselField.DEADWEIGHT,
    VesselField.BUILT_YEAR,
    VesselField.DESTINATION,
    VesselField.ETA,
    VesselField.HEADING,
    VesselField.VESSEL_TYPE_CODE,
  ]) {
    assert.notEqual(fields[field], FieldSupportStatus.CONFIRMED, field);
  }
});

test("VesselFinder: lịch cảng UNSUPPORTED — repo không có dấu vết nào", () => {
  const { fields } = SOURCE_CAPABILITY_MATRIX[VesselSource.VESSELFINDER];
  for (const field of [
    VesselField.CURRENT_PORT,
    VesselField.CURRENT_PORT_ARRIVAL_AT,
    VesselField.NEXT_PORT,
    VesselField.NEXT_PORT_ETA,
    VesselField.LAST_PORT,
    VesselField.LAST_PORT_DEPARTURE_AT,
  ]) {
    assert.equal(fields[field], FieldSupportStatus.UNSUPPORTED, field);
  }
});

test("MyShipTracking: costType = PAID và ưu tiên THẤP NHẤT trong các nguồn thật", () => {
  const paid = SOURCE_CAPABILITY_MATRIX[VesselSource.MYSHIPTRACKING];
  assert.equal(paid.costType, SourceCostType.PAID);
  assert.equal(
    paid.notes?.includes("Paid fallback only. Resolver must place this source last."),
    true
  );

  const realSources = VESSEL_SOURCES.filter((s) => s !== VesselSource.UNKNOWN);
  for (const source of realSources) {
    if (source === VesselSource.MYSHIPTRACKING) continue;
    assert.ok(
      SOURCE_CAPABILITY_MATRIX[source].defaultPriority < paid.defaultPriority,
      `${source} phải có ưu tiên cao hơn nguồn trả tiền`
    );
  }
});

test("AISStream: EXISTING_STREAM, chưa bật trong bot, KHÔNG confirm GT/DWT/năm đóng", () => {
  const capability = SOURCE_CAPABILITY_MATRIX[VesselSource.AISSTREAM];
  assert.equal(capability.costType, SourceCostType.EXISTING_STREAM);
  assert.equal(capability.enabled, false);
  // AIS không mang các trường này trong bất kỳ message nào.
  for (const field of [
    VesselField.GROSS_TONNAGE,
    VesselField.DEADWEIGHT,
    VesselField.BUILT_YEAR,
  ]) {
    assert.equal(capability.fields[field], FieldSupportStatus.UNSUPPORTED, field);
  }
  assert.equal(capability.fields[VesselField.LAT], FieldSupportStatus.CONFIRMED);
});

test("nguồn chưa có implementation đều enabled=false", () => {
  for (const source of [
    VesselSource.SHIPINFO,
    VesselSource.SHIPFINDER,
    VesselSource.BOATNERD,
    VesselSource.MARINETRAFFIC_LIVE,
    VesselSource.SHIPTRAFFIC,
    VesselSource.VESSELTRACKER,
  ]) {
    assert.equal(SOURCE_CAPABILITY_MATRIX[source].enabled, false, source);
  }
  // VesselFinder là nguồn DUY NHẤT có adapter thật -> nguồn free duy nhất đang bật.
  assert.equal(SOURCE_CAPABILITY_MATRIX[VesselSource.VESSELFINDER].enabled, true);
});

test("nguồn chưa POC không được có field CONFIRMED nào", () => {
  for (const source of [
    VesselSource.SHIPINFO,
    VesselSource.SHIPFINDER,
    VesselSource.BOATNERD,
    VesselSource.MARINETRAFFIC_LIVE,
    VesselSource.SHIPTRAFFIC,
    VesselSource.VESSELTRACKER,
    VesselSource.MYSHIPTRACKING,
  ]) {
    const { fields } = SOURCE_CAPABILITY_MATRIX[source];
    for (const field of VESSEL_FIELDS) {
      assert.notEqual(fields[field], FieldSupportStatus.CONFIRMED, `${source}.${field}`);
    }
  }
});

test("matrix bị đóng băng — runtime không sửa được cấu hình", () => {
  assert.equal(Object.isFrozen(SOURCE_CAPABILITY_MATRIX), true);
  const capability = SOURCE_CAPABILITY_MATRIX[VesselSource.VESSELFINDER];
  assert.equal(Object.isFrozen(capability), true);
  assert.equal(Object.isFrozen(capability.fields), true);
  assert.equal(Object.isFrozen(capability.operations), true);
  assert.throws(() => {
    (capability as { enabled: boolean }).enabled = false;
  }, TypeError);
});
