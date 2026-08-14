// ============================================================================
//  TEST · IdentityResolver
// ----------------------------------------------------------------------------
//  Số liệu lấy nguyên từ `vessel_observations` sau POC P6.4/P7.4.
//  Trọng tâm: phần lớn "xung đột" quan sát được KHÔNG phải xung đột.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselIdentity } from "../../domain/canonical/VesselIdentity";
import { ObservationValidationStatus } from "../../domain/observations/ObservationValidation";
import {
  IdentityObservation,
  VesselObservationType,
  VesselSourceObservation,
} from "../../domain/observations/VesselObservation";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { IdentityResolver } from "./IdentityResolver";
import { RejectionReason, ResolutionReason } from "./ResolverTypes";

const MMSI = "636018086";
const SHIPFINDER_AT = new Date("2026-08-14T16:40:41.985Z");
const SHIPINFO_AT = new Date("2026-08-14T10:40:13.307Z");

function identity(props: {
  source: VesselSource;
  fetchedAt: Date;
  id?: string;
  invalid?: boolean;
  data?: Partial<VesselIdentity>;
}): IdentityObservation {
  const data: VesselIdentity = {
    mmsi: MMSI,
    metadata: createSourceMetadata({ source: props.source, fetchedAt: props.fetchedAt }),
    ...props.data,
  };
  return {
    id: props.id ?? `obs-${props.source}`,
    source: props.source,
    type: VesselObservationType.IDENTITY,
    vesselKey: { mmsi: MMSI },
    fetchedAt: props.fetchedAt,
    sourceReceivedAt: null,
    validation: {
      status: props.invalid
        ? ObservationValidationStatus.INVALID
        : ObservationValidationStatus.VALID,
      errors: [],
    },
    data,
  };
}

const resolver = new IdentityResolver();

// ---- CA THẬT · AGIA DOXA (MMSI 636018086) ---------------------------------

const REAL_SHIPFINDER = identity({
  source: VesselSource.SHIPFINDER,
  id: "6a7f450a521d474c8df814e9",
  fetchedAt: SHIPFINDER_AT,
  data: {
    imo: "9467976",
    name: "AGIA DOXA",
    callsign: "D5OC7",
    vesselType: "Cargo ship",
    flag: { code: "LBR", name: null },
  },
});

const REAL_SHIPINFO = identity({
  source: VesselSource.SHIPINFO,
  id: "6a7ef08d311b00bbac1ef26f",
  fetchedAt: SHIPINFO_AT,
  data: {
    imo: "9467976",
    name: "Agia Doxa",
    callsign: "D5OC7",
    vesselType: "Bulk Carrier",
    flag: { code: "LR", name: "Liberia" },
  },
});

test('CA THẬT · "AGIA DOXA" vs "Agia Doxa" là MỘT — chỉ khác cách viết', () => {
  const result = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER]);
  assert.ok(result);

  assert.equal(result.name?.reason, ResolutionReason.SOURCES_AGREE);
  // Giữ nguyên dạng của nguồn thắng, KHÔNG viết lại chuỗi.
  assert.equal(result.name?.value, "AGIA DOXA");
  assert.equal(result.name?.source, VesselSource.SHIPFINDER);
});

test("CA THẬT · callsign giống hệt -> SOURCES_AGREE", () => {
  const result = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER]);
  assert.equal(result?.callsign?.value, "D5OC7");
  assert.equal(result?.callsign?.reason, ResolutionReason.SOURCES_AGREE);
});

test('CA THẬT · vesselType: "Bulk Carrier" thắng "Cargo ship" vì CỤ THỂ HƠN', () => {
  const result = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER]);

  // ShipFinder fetch MỚI HƠN nhưng vẫn thua — độ chi tiết quan trọng hơn độ mới.
  assert.equal(result?.vesselType?.value, "Bulk Carrier");
  assert.equal(result?.vesselType?.source, VesselSource.SHIPINFO);
  assert.equal(result?.vesselType?.reason, ResolutionReason.SOURCE_FIELD_PREFERENCE);
  assert.deepEqual(
    result?.vesselType?.rejected.map((r) => [r.source, r.reason]),
    [[VesselSource.SHIPFINDER, RejectionReason.NOT_PREFERRED_SOURCE]]
  );
});

test('CA THẬT · cờ "LR" vs "LBR" KHÔNG phải xung đột, và giữ được tên nước', () => {
  const result = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER]);

  // Cùng quốc gia sau khi quy đổi alpha-3 -> alpha-2.
  assert.equal(result?.flagCode?.reason, ResolutionReason.SOURCES_AGREE);
  // `name` chỉ ShipInfo có -> trộn field lấy được, dù ShipFinder mới hơn.
  assert.equal(result?.flagName?.value, "Liberia");
  assert.equal(result?.flagName?.source, VesselSource.SHIPINFO);
  assert.equal(result?.flagName?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
});

test("CA THẬT · IMO trùng nhau -> SOURCES_AGREE", () => {
  const result = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER]);
  assert.equal(result?.imo?.value, "9467976");
  assert.equal(result?.imo?.reason, ResolutionReason.SOURCES_AGREE);
});

// ---- Tàu ĐỔI TÊN (MMSI 367452710) -----------------------------------------

test("XUNG ĐỘT THẬT · tàu đổi tên -> bản nhìn thấy gần nhất thắng", () => {
  const shipfinder = identity({
    source: VesselSource.SHIPFINDER,
    fetchedAt: new Date("2026-08-14T16:41:14.972Z"),
    data: { name: "AMERICAN WEST", callsign: "WDF4506", vesselType: "Passenger ship" },
  });
  const shipinfo = identity({
    source: VesselSource.SHIPINFO,
    fetchedAt: new Date("2026-08-14T10:40:39.158Z"),
    data: { name: "Queen Of The West", callsign: "WDF4506", vesselType: "Passenger Ship" },
  });

  const result = resolver.resolve([shipinfo, shipfinder]);

  assert.equal(result?.name?.value, "AMERICAN WEST");
  assert.equal(result?.name?.reason, ResolutionReason.NEWER_FETCH);
  assert.deepEqual(
    result?.name?.rejected.map((r) => r.reason),
    [RejectionReason.OLDER_FETCH]
  );

  // callsign giống nhau -> vẫn là một con tàu, không phải lỗi khoá.
  assert.equal(result?.callsign?.reason, ResolutionReason.SOURCES_AGREE);
});

test('"Passenger ship" vs "Passenger Ship" -> SOURCES_AGREE, luật ưu tiên KHÔNG chạy', () => {
  const shipfinder = identity({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { vesselType: "Passenger ship" },
  });
  const shipinfo = identity({
    source: VesselSource.SHIPINFO,
    fetchedAt: SHIPINFO_AT,
    data: { vesselType: "Passenger Ship" },
  });

  const result = resolver.resolve([shipfinder, shipinfo]);
  assert.equal(result?.vesselType?.reason, ResolutionReason.SOURCES_AGREE);
  assert.notEqual(result?.vesselType?.reason, ResolutionReason.SOURCE_FIELD_PREFERENCE);
});

// ---- null không xoá giá trị tốt -------------------------------------------

test("null từ nguồn MỚI HƠN không xoá giá trị của nguồn cũ hơn", () => {
  const newerNull = identity({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { name: null, callsign: null },
  });
  const olderValue = identity({
    source: VesselSource.SHIPINFO,
    fetchedAt: SHIPINFO_AT,
    data: { name: "AGIA DOXA", callsign: "D5OC7" },
  });

  const result = resolver.resolve([newerNull, olderValue]);

  assert.equal(result?.name?.value, "AGIA DOXA");
  assert.equal(result?.name?.source, VesselSource.SHIPINFO);
  assert.equal(result?.name?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
  assert.deepEqual([...(result?.name?.rejected ?? [])], [], "null không phải ứng viên bị loại");
});

test("chuỗi rỗng/trắng cũng không phải ứng viên", () => {
  const blank = identity({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { name: "   " },
  });
  const real = identity({
    source: VesselSource.SHIPINFO,
    fetchedAt: SHIPINFO_AT,
    data: { name: "AGIA DOXA" },
  });
  assert.equal(resolver.resolve([blank, real])?.name?.value, "AGIA DOXA");
});

// ---- IMO bảo thủ ----------------------------------------------------------

test("IMO xung đột KHÔNG dùng newer-fetch — không đổi định danh vì nguồn mới hơn", () => {
  const newerWrong = identity({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { imo: "9999999" },
  });
  const older = identity({
    source: VesselSource.SHIPINFO,
    fetchedAt: SHIPINFO_AT,
    data: { imo: "9467976" },
  });

  const result = resolver.resolve([newerWrong, older]);

  // Cả hai đều CONFIRMED cho IMO -> rơi xuống defaultPriority (ShipInfo 45 < 55).
  assert.equal(result?.imo?.value, "9467976");
  assert.equal(result?.imo?.source, VesselSource.SHIPINFO);
  assert.equal(result?.imo?.reason, ResolutionReason.TIE_BREAK_PRIORITY);
  assert.notEqual(result?.imo?.reason, ResolutionReason.NEWER_FETCH);
});

// ---- Cờ không so được -----------------------------------------------------

test("mã alpha-3 lạ -> INCOMPARABLE, KHÔNG bị coi là xung đột dữ liệu", () => {
  const unknownAlpha3 = identity({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { flag: { code: "ZWE", name: null } },
  });
  const alpha2 = identity({
    source: VesselSource.SHIPINFO,
    fetchedAt: SHIPINFO_AT,
    data: { flag: { code: "LR", name: "Liberia" } },
  });

  const result = resolver.resolve([unknownAlpha3, alpha2]);
  assert.deepEqual(
    result?.flagCode?.rejected.map((r) => r.reason),
    [RejectionReason.INCOMPARABLE_REPRESENTATION]
  );
});

// ---- INVALID / rỗng -------------------------------------------------------

test("observation INVALID không được vào vòng trong", () => {
  const invalidNewer = identity({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    invalid: true,
    data: { name: "TÊN SAI" },
  });
  const valid = identity({
    source: VesselSource.SHIPINFO,
    fetchedAt: SHIPINFO_AT,
    data: { name: "AGIA DOXA" },
  });

  const result = resolver.resolve([invalidNewer, valid]);
  assert.equal(result?.name?.value, "AGIA DOXA");
  assert.equal(result?.name?.source, VesselSource.SHIPINFO);
});

test("không có observation IDENTITY -> null", () => {
  assert.equal(resolver.resolve([]), null);
  const other = {
    ...REAL_SHIPFINDER,
    type: VesselObservationType.PARTICULARS,
  } as unknown as VesselSourceObservation;
  assert.equal(resolver.resolve([other]), null);
});

test("field không nguồn nào có -> null, không bịa", () => {
  const result = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER]);
  assert.equal(result?.vesselTypeCode, null, "không suy mã từ nhãn chữ");
});

// ---- Provenance & tất định ------------------------------------------------

test("provenance đầy đủ trên từng field", () => {
  const result = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER]);
  const vesselType = result?.vesselType;

  assert.equal(vesselType?.source, VesselSource.SHIPINFO);
  assert.equal(vesselType?.observationId, "6a7ef08d311b00bbac1ef26f");
  assert.equal(vesselType?.fetchedAt.getTime(), SHIPINFO_AT.getTime());
  assert.equal(vesselType?.observedAt, null, "identity không có mốc nguồn");
});

test("TẤT ĐỊNH: đảo thứ tự đầu vào không đổi kết quả", () => {
  const forward = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER]);
  const backward = resolver.resolve([REAL_SHIPFINDER, REAL_SHIPINFO]);

  assert.equal(forward?.vesselType?.value, backward?.vesselType?.value);
  assert.equal(forward?.name?.value, backward?.name?.value);
  assert.equal(forward?.flagName?.value, backward?.flagName?.value);
  assert.equal(forward?.imo?.source, backward?.imo?.source);
});
