// ============================================================================
//  TEST · SOURCE_CAPABILITY_MATRIX — tính đầy đủ, tính bất biến, tính TRUNG THỰC
// ----------------------------------------------------------------------------
//  Nhóm test quan trọng nhất ở đây là "trung thực": chặn việc đánh CONFIRMED
//  cho field mà code hiện tại KHÔNG bóc được.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselField, VESSEL_FIELDS } from "../../../../domain/enums/VesselField";
import { VesselSource, VESSEL_SOURCES } from "../../../../domain/enums/VesselSource";
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

test("AISStream: CONFIRMED đúng 10 field mà Marine API thực sự broadcast", () => {
  const capability = SOURCE_CAPABILITY_MATRIX[VesselSource.AISSTREAM];

  // `AisWebSocketManager._dataTransform` phát đúng bấy nhiêu — không hơn.
  for (const field of [
    VesselField.MMSI,
    VesselField.LAT,
    VesselField.LNG,
    VesselField.SPEED,
    VesselField.COURSE,
    VesselField.NAV_STATUS,
    VesselField.POSITION_RECEIVED_AT,
    VesselField.IMO,
    VesselField.NAME,
    VesselField.VESSEL_TYPE_CODE,
  ]) {
    assert.equal(capability.fields[field], FieldSupportStatus.CONFIRMED, field);
  }

  // Có trong AIS message gốc nhưng đường truyền Marine KHÔNG chuyển tiếp ->
  // KHÔNG được confirm theo đặc tả.
  for (const field of [
    VesselField.HEADING,
    VesselField.CALLSIGN,
    VesselField.LENGTH,
    VesselField.BEAM,
    VesselField.DRAUGHT,
    VesselField.DESTINATION,
    VesselField.ETA,
  ]) {
    assert.equal(capability.fields[field], FieldSupportStatus.CANDIDATE, field);
  }

  // Mapper AIS-1 chỉ phát POSITION + IDENTITY.
  assert.equal(capability.operations.position, true);
  assert.equal(capability.operations.particulars, false);
  assert.equal(capability.operations.voyage, false);
});

test("ShipInfo: đã POC trọn đường -> CONFIRMED cho cả position lẫn details", () => {
  const capability = SOURCE_CAPABILITY_MATRIX[VesselSource.SHIPINFO];
  assert.equal(capability.operations.position, true);
  assert.equal(capability.operations.particulars, true);
  assert.equal(capability.operations.searchByMmsi, true);
  assert.equal(capability.operations.searchByImo, true);
  // Endpoint tìm theo tên nằm dưới /api/ mà robots.txt cấm.
  assert.equal(capability.operations.searchByName, false);

  for (const field of [
    VesselField.MMSI,
    VesselField.IMO,
    VesselField.NAME,
    VesselField.CALLSIGN,
    VesselField.FLAG,
    VesselField.VESSEL_TYPE,
    VesselField.BUILT_YEAR,
    VesselField.DEADWEIGHT,
    VesselField.LAT,
    VesselField.LNG,
    VesselField.SPEED,
    VesselField.COURSE,
    VesselField.POSITION_RECEIVED_AT,
  ]) {
    assert.equal(capability.fields[field], FieldSupportStatus.CONFIRMED, field);
  }
});

test("ShipInfo: field KHÔNG có bằng chứng vẫn phải UNSUPPORTED", () => {
  const { fields } = SOURCE_CAPABILITY_MATRIX[VesselSource.SHIPINFO];

  // length/beam: nguồn ĐẢO không nhất quán -> mapper cố ý không map.
  assert.equal(fields[VesselField.LENGTH], FieldSupportStatus.UNSUPPORTED);
  assert.equal(fields[VesselField.BEAM], FieldSupportStatus.UNSUPPORTED);
  // null ở 0/1073 điểm, hoặc nguồn không có khoá.
  for (const field of [
    VesselField.HEADING,
    VesselField.DRAUGHT,
    VesselField.DESTINATION,
    VesselField.ETA,
    VesselField.GROSS_TONNAGE,
    VesselField.NAV_STATUS,
    VesselField.VESSEL_TYPE_CODE,
  ]) {
    assert.equal(fields[field], FieldSupportStatus.UNSUPPORTED, field);
  }
});

test("ShipFinder: đã POC trọn đường -> CONFIRMED cho position + details", () => {
  const capability = SOURCE_CAPABILITY_MATRIX[VesselSource.SHIPFINDER];

  // Chỉ tra được bằng MMSI (P7.1: /ship/detail/imo/... -> 404).
  assert.equal(capability.operations.searchByMmsi, true);
  assert.equal(capability.operations.searchByImo, false);
  assert.equal(capability.operations.searchByName, false, "endpoint bị ký chữ ký");
  assert.equal(capability.operations.areaScan, false);

  for (const field of [
    VesselField.MMSI,
    VesselField.IMO,
    VesselField.NAME,
    VesselField.CALLSIGN,
    VesselField.FLAG,
    VesselField.VESSEL_TYPE,
    VesselField.LAT,
    VesselField.LNG,
    VesselField.SPEED,
    VesselField.COURSE,
    VesselField.HEADING,
    VesselField.NAV_STATUS,
    VesselField.POSITION_RECEIVED_AT,
    VesselField.LENGTH,
    VesselField.BEAM,
    VesselField.DRAUGHT,
    VesselField.DESTINATION,
  ]) {
    assert.equal(capability.fields[field], FieldSupportStatus.CONFIRMED, field);
  }
});

test("ShipFinder: ETA KHÔNG confirmed — nguồn thiếu năm nên mapper không map", () => {
  const { fields } = SOURCE_CAPABILITY_MATRIX[VesselSource.SHIPFINDER];
  assert.notEqual(fields[VesselField.ETA], FieldSupportStatus.CONFIRMED);
  // GT/DWT/năm đóng nằm sau API ký chữ ký -> chưa lấy được.
  for (const field of [
    VesselField.GROSS_TONNAGE,
    VesselField.DEADWEIGHT,
    VesselField.BUILT_YEAR,
  ]) {
    assert.notEqual(fields[field], FieldSupportStatus.CONFIRMED, field);
  }
  // Không có mã AIS số.
  assert.equal(fields[VesselField.VESSEL_TYPE_CODE], FieldSupportStatus.UNSUPPORTED);
});

test("ShipFinder: heading/navStatus/draught là thứ ShipInfo KHÔNG có", () => {
  const shipfinder = SOURCE_CAPABILITY_MATRIX[VesselSource.SHIPFINDER].fields;
  const shipinfo = SOURCE_CAPABILITY_MATRIX[VesselSource.SHIPINFO].fields;

  for (const field of [VesselField.HEADING, VesselField.NAV_STATUS, VesselField.DRAUGHT]) {
    assert.equal(shipfinder[field], FieldSupportStatus.CONFIRMED, field);
    assert.equal(shipinfo[field], FieldSupportStatus.UNSUPPORTED, field);
  }
});

test("KHÔNG mã hoá 'ShipFinder thắng ShipInfo' vào defaultPriority", () => {
  // ShipFinder có vị trí tươi hơn nhiều, nhưng đổi thứ tự ưu tiên chính là làm
  // resolver — mà resolver CHƯA TỒN TẠI.
  const shipinfo = SOURCE_CAPABILITY_MATRIX[VesselSource.SHIPINFO];
  const shipfinder = SOURCE_CAPABILITY_MATRIX[VesselSource.SHIPFINDER];
  assert.equal(shipinfo.defaultPriority, 45);
  assert.equal(shipfinder.defaultPriority, 55);
});

test("ShipInfo: có implementation nhưng CHƯA bật ingestion tự động", () => {
  const capability = SOURCE_CAPABILITY_MATRIX[VesselSource.SHIPINFO];
  // Provider tồn tại và POC đã chạy, nhưng mới chỉ gọi TAY qua CLI.
  assert.equal(capability.enabled, false);
  assert.equal(
    capability.notes?.some((note) => note.includes("shipinfo:poc")),
    true
  );
});

test("ShipInfo: voyage giữ bảo thủ — chưa bằng chứng thì không hứa", () => {
  const capability = SOURCE_CAPABILITY_MATRIX[VesselSource.SHIPINFO];
  assert.equal(capability.operations.voyage, false);
  for (const field of [
    VesselField.DESTINATION,
    VesselField.ETA,
    VesselField.CURRENT_PORT,
    VesselField.NEXT_PORT,
    VesselField.LAST_PORT,
  ]) {
    assert.equal(capability.fields[field], FieldSupportStatus.UNSUPPORTED, field);
  }
});

test("VesselFinder: enabled=true phải kèm note giới hạn phạm vi (legacy crawler)", () => {
  const capability = SOURCE_CAPABILITY_MATRIX[VesselSource.VESSELFINDER];
  assert.equal(capability.enabled, true);
  const scoped = capability.notes?.some(
    (note) => note.includes("legacy crawler") && note.includes("resolver")
  );
  assert.equal(scoped, true, "thiếu note: enabled=true không đồng nghĩa resolver mới được phép dùng");
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
  // SHIPINFO ra khỏi danh sách này ở P6.4, SHIPFINDER ở P7.4 — cả hai đã có
  // POC live ghi observation thật.
  for (const source of [
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
