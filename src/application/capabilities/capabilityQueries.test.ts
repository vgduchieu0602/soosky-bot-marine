// ============================================================================
//  TEST · capabilityQueries — MẶC ĐỊNH AN TOÀN là hợp đồng chính
// ----------------------------------------------------------------------------
//  Mặc định: chỉ enabled + CONFIRMED + không tốn tiền. Ai muốn rộng hơn phải
//  nói rõ qua options.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselField } from "../../domain/value-objects/VesselField";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { FieldSupportStatus, SourceCostType } from "./SourceCapability";
import {
  getCandidateFields,
  getConfirmedFields,
  getMissingFields,
  getSourceCapability,
  getSourcesForField,
  getSourcesForFields,
  providerSupportsField,
} from "./capabilityQueries";
import { SOURCE_CAPABILITY_MATRIX } from "./sourceCapabilityMatrix";

test("getSourceCapability trả đúng entry cho mọi nguồn", () => {
  assert.equal(getSourceCapability(VesselSource.VESSELFINDER).source, VesselSource.VESSELFINDER);
  assert.equal(getSourceCapability(VesselSource.UNKNOWN).costType, SourceCostType.FREE);
});

test("mặc định KHÔNG trả nguồn trả tiền", () => {
  const sources = getSourcesForField(VesselField.LAT);
  assert.equal(sources.includes(VesselSource.MYSHIPTRACKING), false);
  for (const source of sources) {
    assert.notEqual(getSourceCapability(source).costType, SourceCostType.PAID);
  }
});

test("mặc định KHÔNG trả nguồn đang tắt", () => {
  const sources = getSourcesForField(VesselField.LAT);
  // AISStream CONFIRMED lat nhưng enabled=false -> phải bị loại.
  assert.equal(sources.includes(VesselSource.AISSTREAM), false);
  for (const source of sources) {
    assert.equal(getSourceCapability(source).enabled, true, source);
  }
  // Ở phase này chỉ còn đúng VesselFinder qua được bộ lọc mặc định.
  assert.deepEqual([...sources], [VesselSource.VESSELFINDER]);
});

test("mặc định KHÔNG trả nguồn mới ở mức CANDIDATE", () => {
  // VesselFinder: DESTINATION là CANDIDATE (mapper không bóc).
  assert.equal(
    SOURCE_CAPABILITY_MATRIX[VesselSource.VESSELFINDER].fields[VesselField.DESTINATION],
    FieldSupportStatus.CANDIDATE
  );
  assert.deepEqual([...getSourcesForField(VesselField.DESTINATION)], []);

  const withCandidate = getSourcesForField(VesselField.DESTINATION, { includeCandidate: true });
  assert.equal(withCandidate.includes(VesselSource.VESSELFINDER), true);
});

test("includePaid=true cho MyShipTracking xuất hiện, và luôn đứng CUỐI", () => {
  const sources = getSourcesForField(VesselField.LAT, {
    includePaid: true,
    includeCandidate: true,
  });
  assert.equal(sources.includes(VesselSource.MYSHIPTRACKING), true);
  assert.equal(sources[sources.length - 1], VesselSource.MYSHIPTRACKING);
});

test("includeDisabled=true mở nguồn đang tắt, thứ tự theo defaultPriority", () => {
  const sources = getSourcesForField(VesselField.LAT, { includeDisabled: true });
  assert.equal(sources.includes(VesselSource.AISSTREAM), true);
  // AISStream (10) đứng trước VesselFinder (20).
  assert.equal(sources[0], VesselSource.AISSTREAM);
  assert.equal(sources[1], VesselSource.VESSELFINDER);
});

test("UNKNOWN không bao giờ được trả về, kể cả khi mở hết bộ lọc", () => {
  const sources = getSourcesForField(VesselField.MMSI, {
    includeDisabled: true,
    includeCandidate: true,
    includePaid: true,
  });
  assert.equal(sources.includes(VesselSource.UNKNOWN), false);
});

test("providerSupportsField: mặc định chỉ tính CONFIRMED", () => {
  assert.equal(providerSupportsField(VesselSource.VESSELFINDER, VesselField.LAT), true);
  assert.equal(providerSupportsField(VesselSource.VESSELFINDER, VesselField.ETA), false);
  assert.equal(
    providerSupportsField(VesselSource.VESSELFINDER, VesselField.ETA, { includeCandidate: true }),
    true
  );
  assert.equal(
    providerSupportsField(VesselSource.VESSELFINDER, VesselField.CURRENT_PORT, {
      includeCandidate: true,
    }),
    false
  );
});

test("getConfirmedFields / getCandidateFields tách đúng hai tập, không giao nhau", () => {
  const confirmed = getConfirmedFields(VesselSource.VESSELFINDER);
  const candidate = getCandidateFields(VesselSource.VESSELFINDER);

  assert.equal(confirmed.includes(VesselField.MMSI), true);
  assert.equal(confirmed.includes(VesselField.DRAUGHT), true);
  assert.equal(candidate.includes(VesselField.GROSS_TONNAGE), true);

  for (const field of confirmed) {
    assert.equal(candidate.includes(field), false, field);
  }
  assert.deepEqual([...getConfirmedFields(VesselSource.UNKNOWN)], []);
  assert.deepEqual([...getCandidateFields(VesselSource.UNKNOWN)], []);
});

test("getSourcesForFields cần nguồn cấp ĐƯỢC HẾT các field (giao, không phải hợp)", () => {
  // VesselFinder confirm cả 3.
  assert.deepEqual(
    [...getSourcesForFields([VesselField.MMSI, VesselField.LAT, VesselField.LNG])],
    [VesselSource.VESSELFINDER]
  );
  // Thêm 1 field VesselFinder KHÔNG confirm -> không nguồn nào đủ.
  assert.deepEqual(
    [...getSourcesForFields([VesselField.MMSI, VesselField.GROSS_TONNAGE])],
    []
  );
  // Danh sách rỗng KHÔNG có nghĩa "mọi nguồn đều hợp".
  assert.deepEqual([...getSourcesForFields([])], []);
});

test("getMissingFields trả đúng field thiếu, không trùng lặp, giữ thứ tự yêu cầu", () => {
  const required = [
    VesselField.MMSI,
    VesselField.LAT,
    VesselField.GROSS_TONNAGE,
    VesselField.BUILT_YEAR,
    VesselField.GROSS_TONNAGE, // lặp lại có chủ ý
  ];
  const available = [VesselField.MMSI, VesselField.LAT, VesselField.LNG];

  assert.deepEqual(
    [...getMissingFields(required, available)],
    [VesselField.GROSS_TONNAGE, VesselField.BUILT_YEAR]
  );
  assert.deepEqual([...getMissingFields([], available)], []);
  assert.deepEqual(
    [...getMissingFields(required, [])],
    [VesselField.MMSI, VesselField.LAT, VesselField.GROSS_TONNAGE, VesselField.BUILT_YEAR]
  );
});

test("kết quả truy vấn bị đóng băng — người gọi không sửa được", () => {
  const sources = getSourcesForField(VesselField.LAT);
  assert.equal(Object.isFrozen(sources), true);
  assert.equal(Object.isFrozen(getConfirmedFields(VesselSource.VESSELFINDER)), true);
});
