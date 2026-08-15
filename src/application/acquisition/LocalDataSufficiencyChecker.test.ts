// ============================================================================
//  TEST · LocalDataSufficiencyChecker
// ----------------------------------------------------------------------------
//  Số liệu lấy từ canonical thật của AGIA DOXA (MMSI 636018086) sau POC
//  P6.4/P7.4 và composition P8.4.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { PositionFreshness } from "../resolver/PositionResolverPolicy";
import { ResolvedCurrentVessel } from "../resolver/ResolvedCurrentVessel";
import { ResolvedIdentity } from "../resolver/IdentityResolver";
import { ResolvedParticulars } from "../resolver/ParticularsResolver";
import { ResolvedPosition } from "../resolver/PositionResolver";
import { ResolvedVoyage } from "../resolver/VoyageResolver";
import { ResolutionReason, ResolvedField } from "../resolver/ResolverTypes";
import { VesselField, VesselFieldGroup } from "../../domain/value-objects/VesselField";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { DataNeedType, InvalidDataNeedError } from "./DataNeed";
import { LocalDataSufficiencyChecker } from "./LocalDataSufficiencyChecker";
import { MissingReason } from "./SufficiencyTypes";

const MMSI = "636018086";
const NOW = new Date("2026-08-14T17:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const checker = new LocalDataSufficiencyChecker();

/** `fetchedAt` cách `NOW` đúng `hours` giờ. */
function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * HOUR);
}

function field<T>(value: T, fetchedAt: Date = hoursAgo(1)): ResolvedField<T> {
  return {
    value,
    source: VesselSource.SHIPFINDER,
    observationId: "obs-1",
    observedAt: null,
    fetchedAt,
    reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
    rejected: [],
  };
}

function identity(overrides: Partial<ResolvedIdentity> = {}): ResolvedIdentity {
  return {
    mmsi: MMSI,
    imo: null,
    name: field("AGIA DOXA"),
    callsign: null,
    vesselType: null,
    vesselTypeCode: null,
    flagCode: null,
    flagName: null,
    ...overrides,
  };
}

function position(
  freshness: PositionFreshness,
  overrides: Partial<ResolvedPosition["position"]> = {}
): ResolvedPosition {
  const fetchedAt = hoursAgo(0.2);
  return {
    position: {
      mmsi: MMSI,
      lat: 33.74968333333333,
      lng: -118.20891666666667,
      speed: 0,
      course: 0.9,
      heading: null,
      navStatus: null,
      latLngApproximate: false,
      receivedAt: fetchedAt,
      metadata: createSourceMetadata({ source: VesselSource.SHIPFINDER, fetchedAt }),
      ...overrides,
    },
    source: VesselSource.SHIPFINDER,
    observationId: "obs-position",
    observedAt: fetchedAt,
    fetchedAt,
    freshness,
    reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
    rejected: [],
  };
}

function particulars(overrides: Partial<ResolvedParticulars> = {}): ResolvedParticulars {
  return {
    mmsi: MMSI,
    length: field(179),
    beam: null,
    draught: null,
    grossTonnage: null,
    deadweight: null,
    builtYear: null,
    ...overrides,
  };
}

function voyage(overrides: Partial<ResolvedVoyage> = {}): ResolvedVoyage {
  return {
    mmsi: MMSI,
    destination: field("LONG BEACH, US", hoursAgo(2)),
    eta: null,
    currentPort: null,
    nextPort: null,
    lastPort: null,
    lastPortDepartureAt: null,
    ...overrides,
  };
}

function vessel(overrides: Partial<ResolvedCurrentVessel> = {}): ResolvedCurrentVessel {
  return {
    vesselKey: { mmsi: MMSI },
    identity: identity(),
    position: position(PositionFreshness.LIVE),
    particulars: particulars(),
    voyage: voyage(),
    resolvedAt: NOW,
    ...overrides,
  };
}

// ---- Không có tàu ---------------------------------------------------------

test("vessel null -> NO_CURRENT_VESSEL, không suy đoán từng nhóm", () => {
  const result = checker.check(null, { type: DataNeedType.POSITION }, NOW);

  assert.equal(result.satisfied, false);
  assert.deepEqual([...result.missing], [{ reason: MissingReason.NO_CURRENT_VESSEL }]);
  assert.equal(result.need.type, DataNeedType.POSITION);
});

// ---- POSITION · bậc độ tươi ------------------------------------------------

test("POSITION · LIVE là bậc DUY NHẤT đủ", () => {
  const cases: [PositionFreshness, boolean][] = [
    [PositionFreshness.LIVE, true],
    [PositionFreshness.RECENT, false],
    [PositionFreshness.STALE, false],
    [PositionFreshness.EXPIRED, false],
    [PositionFreshness.NO_SOURCE_TIME, false],
  ];

  for (const [freshness, expected] of cases) {
    const result = checker.check(
      vessel({ position: position(freshness) }),
      { type: DataNeedType.POSITION },
      NOW
    );
    assert.equal(result.satisfied, expected, `bậc ${freshness}`);
    if (!expected) {
      assert.deepEqual(
        result.missing.map((m) => m.reason),
        [MissingReason.POSITION_NOT_FRESH_ENOUGH]
      );
    }
  }
});

test("POSITION · nhóm position null -> MISSING_GROUP", () => {
  const result = checker.check(vessel({ position: null }), { type: DataNeedType.POSITION }, NOW);

  assert.equal(result.satisfied, false);
  assert.deepEqual(
    [...result.missing],
    [{ group: VesselFieldGroup.POSITION, reason: MissingReason.MISSING_GROUP }]
  );
});

test("POSITION · bậc lấy từ resolver, KHÔNG tính lại từ observedAt", () => {
  // observedAt 20 phút trước (đủ để là LIVE nếu tính lại), nhưng resolver đã
  // đóng dấu EXPIRED. Checker phải tin resolver.
  const stamped = { ...position(PositionFreshness.EXPIRED), observedAt: hoursAgo(0.33) };
  const result = checker.check(
    vessel({ position: stamped }),
    { type: DataNeedType.POSITION },
    NOW
  );
  assert.equal(result.satisfied, false);
});

// ---- POSITION · field chỉ đích danh ---------------------------------------

test("POSITION + HEADING · null -> thiếu; có -> đủ", () => {
  const need = { type: DataNeedType.POSITION, requiredFields: [VesselField.HEADING] };

  const without = checker.check(
    vessel({ position: position(PositionFreshness.LIVE, { heading: null }) }),
    need,
    NOW
  );
  assert.equal(without.satisfied, false);
  assert.deepEqual(
    [...without.missing],
    [
      {
        group: VesselFieldGroup.POSITION,
        field: VesselField.HEADING,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      },
    ]
  );

  const withHeading = checker.check(
    vessel({ position: position(PositionFreshness.LIVE, { heading: 58 }) }),
    need,
    NOW
  );
  assert.equal(withHeading.satisfied, true);
});

test("POSITION · heading null KHÔNG ảnh hưởng khi không yêu cầu", () => {
  const result = checker.check(
    vessel({ position: position(PositionFreshness.LIVE, { heading: null }) }),
    { type: DataNeedType.POSITION },
    NOW
  );
  assert.equal(result.satisfied, true);
});

test("POSITION · lat/lng không kiểm lại — vị trí tồn tại thì toạ độ tồn tại", () => {
  const result = checker.check(
    vessel({ position: position(PositionFreshness.LIVE) }),
    { type: DataNeedType.POSITION, requiredFields: [VesselField.LAT, VesselField.LNG] },
    NOW
  );
  assert.equal(result.satisfied, true);
});

test("POSITION · heading=0 là GIÁ TRỊ, không phải thiếu", () => {
  const result = checker.check(
    vessel({ position: position(PositionFreshness.LIVE, { heading: 0, speed: 0 }) }),
    {
      type: DataNeedType.POSITION,
      requiredFields: [VesselField.HEADING, VesselField.SPEED],
    },
    NOW
  );
  assert.equal(result.satisfied, true, "0 knot / hướng 0° là dữ liệu thật của tàu đang neo");
});

test("POSITION_RECEIVED_AT · observedAt null -> thiếu", () => {
  const noSourceTime = { ...position(PositionFreshness.LIVE), observedAt: null };
  const result = checker.check(
    vessel({ position: noSourceTime }),
    { type: DataNeedType.POSITION, requiredFields: [VesselField.POSITION_RECEIVED_AT] },
    NOW
  );
  assert.equal(result.satisfied, false);
  assert.equal(result.missing[0]?.field, VesselField.POSITION_RECEIVED_AT);
});

test("nhóm thiếu -> KHÔNG báo trùng từng field của nhóm đó", () => {
  const result = checker.check(
    vessel({ position: null }),
    { type: DataNeedType.POSITION, requiredFields: [VesselField.HEADING, VesselField.SPEED] },
    NOW
  );
  // Một nguyên nhân, một dòng.
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0]?.reason, MissingReason.MISSING_GROUP);
});

// ---- IDENTITY -------------------------------------------------------------

test("IDENTITY · chỉ name là bắt buộc", () => {
  const bare = vessel({
    identity: identity({ callsign: null, vesselType: null, flagCode: null, flagName: null }),
  });
  assert.equal(checker.check(bare, { type: DataNeedType.IDENTITY }, NOW).satisfied, true);
});

test("IDENTITY · name null -> thiếu", () => {
  const result = checker.check(
    vessel({ identity: identity({ name: null }) }),
    { type: DataNeedType.IDENTITY },
    NOW
  );
  assert.equal(result.satisfied, false);
  assert.deepEqual(
    [...result.missing],
    [
      {
        group: VesselFieldGroup.IDENTITY,
        field: VesselField.NAME,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      },
    ]
  );
});

test("IDENTITY · nhóm null -> MISSING_GROUP", () => {
  const result = checker.check(vessel({ identity: null }), { type: DataNeedType.IDENTITY }, NOW);
  assert.equal(result.missing[0]?.reason, MissingReason.MISSING_GROUP);
});

test("IDENTITY + enrichment chỉ đích danh -> mới tính là thiếu", () => {
  const need = {
    type: DataNeedType.IDENTITY,
    requiredFields: [VesselField.CALLSIGN, VesselField.VESSEL_TYPE],
  };

  assert.equal(checker.check(vessel(), need, NOW).satisfied, false);

  const enriched = vessel({
    identity: identity({ callsign: field("D5OC7"), vesselType: field("Bulk Carrier") }),
  });
  assert.equal(checker.check(enriched, need, NOW).satisfied, true);
});

test("FLAG · có code HOẶC name là có cờ", () => {
  const need = { type: DataNeedType.IDENTITY, requiredFields: [VesselField.FLAG] };

  assert.equal(checker.check(vessel(), need, NOW).satisfied, false);
  // Chỉ có mã, chưa có tên nước -> vẫn là có cờ.
  const codeOnly = vessel({ identity: identity({ flagCode: field("LR") }) });
  assert.equal(checker.check(codeOnly, need, NOW).satisfied, true);
  // Ngược lại cũng vậy.
  const nameOnly = vessel({ identity: identity({ flagName: field("Liberia") }) });
  assert.equal(checker.check(nameOnly, need, NOW).satisfied, true);
});

test("MMSI là khoá tra -> luôn có khi identity tồn tại", () => {
  const result = checker.check(
    vessel(),
    { type: DataNeedType.IDENTITY, requiredFields: [VesselField.MMSI] },
    NOW
  );
  assert.equal(result.satisfied, true);
});

// ---- PARTICULARS ----------------------------------------------------------

test("PARTICULARS · MỘT field là đủ", () => {
  const onlyLength = vessel({ particulars: particulars() });
  assert.equal(checker.check(onlyLength, { type: DataNeedType.PARTICULARS }, NOW).satisfied, true);
});

test("PARTICULARS · nhóm có nhưng RỖNG -> thiếu", () => {
  const empty = vessel({ particulars: particulars({ length: null }) });
  const result = checker.check(empty, { type: DataNeedType.PARTICULARS }, NOW);

  assert.equal(result.satisfied, false);
  assert.deepEqual(
    [...result.missing],
    [{ group: VesselFieldGroup.PARTICULARS, reason: MissingReason.MISSING_GROUP }]
  );
});

test("PARTICULARS · nhóm null -> thiếu", () => {
  assert.equal(
    checker.check(vessel({ particulars: null }), { type: DataNeedType.PARTICULARS }, NOW).satisfied,
    false
  );
});

test("PARTICULARS + BUILT_YEAR · ca bắt buộc", () => {
  const need = {
    type: DataNeedType.PARTICULARS,
    requiredFields: [VesselField.BUILT_YEAR],
  };

  // length 179 có, builtYear null -> PARTICULARS trần thì đủ, có BUILT_YEAR thì không.
  const withoutYear = vessel({ particulars: particulars() });
  assert.equal(checker.check(withoutYear, { type: DataNeedType.PARTICULARS }, NOW).satisfied, true);

  const result = checker.check(withoutYear, need, NOW);
  assert.equal(result.satisfied, false);
  assert.deepEqual(
    [...result.missing],
    [
      {
        group: VesselFieldGroup.PARTICULARS,
        field: VesselField.BUILT_YEAR,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      },
    ]
  );

  const withYear = vessel({ particulars: particulars({ builtYear: field(2010) }) });
  assert.equal(checker.check(withYear, need, NOW).satisfied, true);
});

test("PARTICULARS · không có ngưỡng tuổi cho field TĨNH", () => {
  // length lấy từ 90 ngày trước. Chiều dài tàu không đổi -> vẫn đủ.
  const old = vessel({ particulars: particulars({ length: field(179, hoursAgo(24 * 90)) }) });
  assert.equal(
    checker.check(old, { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.LENGTH] }, NOW)
      .satisfied,
    true
  );
});

// ---- DRAUGHT · nửa động ---------------------------------------------------

test("DRAUGHT · 2 giờ đủ, 8 giờ quá cũ", () => {
  const need = { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.DRAUGHT] };

  const fresh = vessel({ particulars: particulars({ draught: field(5.9, hoursAgo(2)) }) });
  assert.equal(checker.check(fresh, need, NOW).satisfied, true);

  const stale = vessel({ particulars: particulars({ draught: field(5.9, hoursAgo(8)) }) });
  const result = checker.check(stale, need, NOW);
  assert.equal(result.satisfied, false);
  assert.deepEqual(
    [...result.missing],
    [
      {
        group: VesselFieldGroup.PARTICULARS,
        field: VesselField.DRAUGHT,
        reason: MissingReason.FIELD_TOO_OLD,
      },
    ]
  );
});

test("DRAUGHT cũ KHÔNG ảnh hưởng PARTICULARS trần", () => {
  const stale = vessel({ particulars: particulars({ draught: field(5.9, hoursAgo(48)) }) });
  assert.equal(checker.check(stale, { type: DataNeedType.PARTICULARS }, NOW).satisfied, true);
});

test("DRAUGHT · tuổi 8 giờ chỉ áp cho draught, không lan sang length", () => {
  const mixed = vessel({
    particulars: particulars({
      length: field(179, hoursAgo(8)),
      draught: field(5.9, hoursAgo(8)),
    }),
  });
  const result = checker.check(
    mixed,
    {
      type: DataNeedType.PARTICULARS,
      requiredFields: [VesselField.LENGTH, VesselField.DRAUGHT],
    },
    NOW
  );
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0]?.field, VesselField.DRAUGHT);
});

// ---- VOYAGE ---------------------------------------------------------------

test("VOYAGE · destination 2 giờ đủ, 8 giờ quá cũ, null thiếu", () => {
  const need = { type: DataNeedType.VOYAGE };

  assert.equal(checker.check(vessel(), need, NOW).satisfied, true);

  const old = vessel({ voyage: voyage({ destination: field("LONG BEACH, US", hoursAgo(8)) }) });
  const oldResult = checker.check(old, need, NOW);
  assert.equal(oldResult.satisfied, false);
  assert.deepEqual(
    [...oldResult.missing],
    [
      {
        group: VesselFieldGroup.VOYAGE,
        field: VesselField.DESTINATION,
        reason: MissingReason.VOYAGE_TOO_OLD,
      },
    ]
  );

  const none = vessel({ voyage: voyage({ destination: null }) });
  const noneResult = checker.check(none, need, NOW);
  assert.equal(noneResult.satisfied, false);
  assert.equal(noneResult.missing[0]?.reason, MissingReason.MISSING_REQUIRED_FIELD);
});

test("VOYAGE · tuổi đo bằng fetchedAt, KHÔNG bằng resolvedAt", () => {
  // resolvedAt = NOW (vừa chạy resolve) nhưng destination lấy từ 8 giờ trước.
  const stale = vessel({
    voyage: voyage({ destination: field("LONG BEACH, US", hoursAgo(8)) }),
    resolvedAt: NOW,
  });
  assert.equal(checker.check(stale, { type: DataNeedType.VOYAGE }, NOW).satisfied, false);
});

test("VOYAGE · eta null KHÔNG làm thiếu — ca thật ShipFinder", () => {
  const real = vessel({ voyage: voyage({ eta: null }) });
  assert.equal(checker.check(real, { type: DataNeedType.VOYAGE }, NOW).satisfied, true);
});

test("VOYAGE + ETA chỉ đích danh -> mới báo thiếu", () => {
  const result = checker.check(
    vessel(),
    { type: DataNeedType.VOYAGE, requiredFields: [VesselField.ETA] },
    NOW
  );
  assert.equal(result.satisfied, false);
  assert.equal(result.missing[0]?.field, VesselField.ETA);
  // Checker CHỈ báo thiếu. Nó không biết và không được biết rằng hiện không
  // nguồn free nào cấp được ETA — đó là câu hỏi của P9.3.
});

test("VOYAGE · cảng chỉ tính khi đích danh", () => {
  assert.equal(checker.check(vessel(), { type: DataNeedType.VOYAGE }, NOW).satisfied, true);
  assert.equal(
    checker.check(
      vessel(),
      { type: DataNeedType.VOYAGE, requiredFields: [VesselField.NEXT_PORT] },
      NOW
    ).satisfied,
    false
  );
});

test("VOYAGE · field canonical chưa được resolver phân xử -> luôn thiếu", () => {
  // `currentPortArrivalAt` là VesselField hợp lệ nhưng ResolvedVoyage cố ý
  // không có nó (P8.4 §R.3). Báo thiếu là đúng sự thật, không phải lỗi cấu hình.
  const result = checker.check(
    vessel(),
    { type: DataNeedType.VOYAGE, requiredFields: [VesselField.CURRENT_PORT_ARRIVAL_AT] },
    NOW
  );
  assert.equal(result.satisfied, false);
  assert.equal(result.missing[0]?.reason, MissingReason.MISSING_REQUIRED_FIELD);
});

// ---- FULL -----------------------------------------------------------------

test("FULL · RECENT đủ cho FULL nhưng KHÔNG đủ cho POSITION — luật lõi", () => {
  const recent = vessel({ position: position(PositionFreshness.RECENT) });

  assert.equal(checker.check(recent, { type: DataNeedType.POSITION }, NOW).satisfied, false);
  assert.equal(checker.check(recent, { type: DataNeedType.FULL }, NOW).satisfied, true);
});

test("FULL · AGIA DOXA đủ cả bốn nhóm", () => {
  assert.equal(checker.check(vessel(), { type: DataNeedType.FULL }, NOW).satisfied, true);
});

test("FULL · STALE làm hỏng", () => {
  const stale = vessel({ position: position(PositionFreshness.STALE) });
  const result = checker.check(stale, { type: DataNeedType.FULL }, NOW);

  assert.equal(result.satisfied, false);
  assert.deepEqual(
    [...result.missing],
    [{ group: VesselFieldGroup.POSITION, reason: MissingReason.POSITION_NOT_FRESH_ENOUGH }]
  );
});

test("FULL · destination 8 giờ làm hỏng", () => {
  const old = vessel({ voyage: voyage({ destination: field("LONG BEACH, US", hoursAgo(8)) }) });
  const result = checker.check(old, { type: DataNeedType.FULL }, NOW);

  assert.equal(result.satisfied, false);
  assert.equal(result.missing[0]?.reason, MissingReason.VOYAGE_TOO_OLD);
});

test("FULL · KHÔNG đuổi theo field null — ca chống hoàn hảo", () => {
  const sparse = vessel({
    identity: identity({ callsign: null, vesselType: null, flagCode: null, flagName: null }),
    position: position(PositionFreshness.RECENT),
    particulars: particulars({
      beam: null,
      draught: null,
      grossTonnage: null,
      deadweight: null,
      builtYear: null,
    }),
    voyage: voyage({ eta: null, currentPort: null, nextPort: null, lastPort: null }),
  });

  const result = checker.check(sparse, { type: DataNeedType.FULL }, NOW);
  assert.equal(result.satisfied, true, "grossTonnage/eta/nextPort/flagName null vẫn ĐỦ");
  assert.deepEqual([...result.missing], []);
});

test("FULL + field đích danh · không biến FULL thành 'mọi field required'", () => {
  const result = checker.check(
    vessel(),
    { type: DataNeedType.FULL, requiredFields: [VesselField.BUILT_YEAR] },
    NOW
  );
  assert.equal(result.satisfied, false);
  assert.deepEqual(
    result.missing.map((m) => m.field),
    [VesselField.BUILT_YEAR]
  );

  const withYear = vessel({ particulars: particulars({ builtYear: field(2010) }) });
  assert.equal(
    checker.check(withYear, { type: DataNeedType.FULL, requiredFields: [VesselField.BUILT_YEAR] }, NOW)
      .satisfied,
    true
  );
});

test("FULL · nhiều nhóm thiếu -> nhiều dòng độc lập", () => {
  const broken = vessel({ identity: null, particulars: null });
  const result = checker.check(broken, { type: DataNeedType.FULL }, NOW);

  assert.equal(result.satisfied, false);
  assert.deepEqual(
    result.missing.map((m) => [m.group, m.reason]),
    [
      [VesselFieldGroup.IDENTITY, MissingReason.MISSING_GROUP],
      [VesselFieldGroup.PARTICULARS, MissingReason.MISSING_GROUP],
    ]
  );
});

test("FULL · field từ nhiều nhóm khác nhau đều hợp lệ", () => {
  const rich = vessel({
    identity: identity({ callsign: field("D5OC7") }),
    particulars: particulars({ builtYear: field(2010) }),
  });
  assert.equal(
    checker.check(
      rich,
      {
        type: DataNeedType.FULL,
        requiredFields: [VesselField.CALLSIGN, VesselField.BUILT_YEAR, VesselField.DESTINATION],
      },
      NOW
    ).satisfied,
    true
  );
});

// ---- Validation need ------------------------------------------------------

test("POSITION + BUILT_YEAR -> NỔ, không bỏ qua im lặng", () => {
  assert.throws(
    () =>
      checker.check(
        vessel(),
        { type: DataNeedType.POSITION, requiredFields: [VesselField.BUILT_YEAR] },
        NOW
      ),
    InvalidDataNeedError
  );
});

test("PARTICULARS + HEADING -> NỔ", () => {
  assert.throws(
    () =>
      checker.check(
        vessel(),
        { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.HEADING] },
        NOW
      ),
    InvalidDataNeedError
  );
});

test("validation chạy TRƯỚC khi nhìn dữ liệu — vessel null vẫn nổ", () => {
  assert.throws(
    () =>
      checker.check(
        null,
        { type: DataNeedType.VOYAGE, requiredFields: [VesselField.LENGTH] },
        NOW
      ),
    InvalidDataNeedError
  );
});

test("FULL nhận field của MỌI nhóm", () => {
  assert.doesNotThrow(() =>
    checker.check(
      vessel(),
      {
        type: DataNeedType.FULL,
        requiredFields: [
          VesselField.NAME,
          VesselField.HEADING,
          VesselField.BUILT_YEAR,
          VesselField.DESTINATION,
        ],
      },
      NOW
    )
  );
});

// ---- Lệch đồng hồ ---------------------------------------------------------

test("fetchedAt ở TƯƠNG LAI (lệch đồng hồ) -> tuổi 0, không loại tàu", () => {
  const skewed = vessel({
    voyage: voyage({ destination: field("LONG BEACH, US", new Date(NOW.getTime() + 5000)) }),
  });
  assert.equal(checker.check(skewed, { type: DataNeedType.VOYAGE }, NOW).satisfied, true);
});

// ---- Thuần ----------------------------------------------------------------

test("THUẦN · cùng đầu vào -> cùng đầu ra, gọi nhiều lần không đổi", () => {
  const input = vessel({ position: position(PositionFreshness.STALE) });
  const need = { type: DataNeedType.FULL, requiredFields: [VesselField.BUILT_YEAR] };

  const a = checker.check(input, need, NOW);
  const b = checker.check(input, need, NOW);
  const c = checker.check(input, need, NOW);

  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("THUẦN · không đụng vào vessel đầu vào", () => {
  const input = vessel();
  const before = JSON.stringify(input);
  checker.check(input, { type: DataNeedType.FULL, requiredFields: [VesselField.ETA] }, NOW);
  assert.equal(JSON.stringify(input), before);
});

test("`now` là THAM SỐ — đổi now thì đổi kết quả", () => {
  const input = vessel();
  const need = { type: DataNeedType.VOYAGE };

  assert.equal(checker.check(input, need, NOW).satisfied, true);
  // 8 giờ sau, cùng dữ liệu, destination đã quá 6 giờ.
  const later = new Date(NOW.getTime() + 8 * HOUR);
  assert.equal(checker.check(input, need, later).satisfied, false);
});
