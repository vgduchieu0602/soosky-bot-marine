// ============================================================================
//  TEST · VesselField — từ vựng canonical, không phải tên field của nguồn
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VesselField,
  VESSEL_FIELDS,
  VesselFieldGroup,
  getFieldGroup,
  getFieldsInGroup,
  isVesselField,
} from "./VesselField";

test("đủ 28 field canonical, không trùng giá trị", () => {
  assert.equal(VESSEL_FIELDS.length, 28);
  assert.equal(new Set(VESSEL_FIELDS).size, 28);
});

test("mỗi field thuộc đúng một nhóm canonical", () => {
  assert.equal(getFieldGroup(VesselField.MMSI), VesselFieldGroup.IDENTITY);
  assert.equal(getFieldGroup(VesselField.LAT), VesselFieldGroup.POSITION);
  assert.equal(getFieldGroup(VesselField.DRAUGHT), VesselFieldGroup.PARTICULARS);
  assert.equal(getFieldGroup(VesselField.LAST_PORT), VesselFieldGroup.VOYAGE);

  const counts = Object.values(VesselFieldGroup).reduce(
    (total, group) => total + getFieldsInGroup(group).length,
    0
  );
  assert.equal(counts, VESSEL_FIELDS.length);
});

test("số field mỗi nhóm khớp canonical model A1", () => {
  assert.equal(getFieldsInGroup(VesselFieldGroup.IDENTITY).length, 7);
  assert.equal(getFieldsInGroup(VesselFieldGroup.POSITION).length, 7);
  assert.equal(getFieldsInGroup(VesselFieldGroup.PARTICULARS).length, 6);
  assert.equal(getFieldsInGroup(VesselFieldGroup.VOYAGE).length, 8);
});

test("giá trị field trùng tên thuộc tính canonical -> đọc matrix không cần bảng tra thứ hai", () => {
  assert.equal(VesselField.LNG, "lng"); // canonical dùng lng, KHÔNG phải lon
  assert.equal(VesselField.VESSEL_TYPE, "vesselType");
  assert.equal(VesselField.BUILT_YEAR, "builtYear");
  assert.equal(VesselField.LENGTH, "length"); // không phải lengthM
  assert.equal(VesselField.POSITION_RECEIVED_AT, "positionReceivedAt");
});

test("không dùng tên field thô của nguồn", () => {
  const raw = ["ship_lat", "ship_lon", "ship_sog", "ship_cog", "lrpd", "lon", "lengthM", "widthM"];
  for (const name of raw) {
    assert.equal(isVesselField(name), false, name);
  }
});

test("isVesselField nhận đúng giá trị chuẩn", () => {
  assert.equal(isVesselField("mmsi"), true);
  assert.equal(isVesselField("MMSI"), false);
  assert.equal(isVesselField(null), false);
});
