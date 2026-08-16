// ============================================================================
//  TEST · ParticularsResolver — trộn field bù trừ
// ----------------------------------------------------------------------------
//  Số liệu lấy nguyên từ `vessel_observations` sau POC P6.4/P7.4.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselParticulars } from "../../../domain/value-objects/VesselParticulars";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import {
  ParticularsObservation,
  VesselObservationType,
  VesselSourceObservation,
} from "../../../domain/entities/VesselObservation";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { ParticularsResolver } from "./ParticularsResolver";
import { RejectionReason, ResolutionReason } from "./ResolverTypes";

const MMSI = "636018086";
const SHIPFINDER_AT = new Date("2026-08-14T16:40:41.985Z");
const SHIPINFO_AT = new Date("2026-08-14T10:40:13.307Z");

function particulars(props: {
  source: VesselSource;
  fetchedAt: Date;
  id?: string;
  invalid?: boolean;
  data?: Partial<VesselParticulars>;
}): ParticularsObservation {
  const data: VesselParticulars = {
    mmsi: MMSI,
    metadata: createSourceMetadata({ source: props.source, fetchedAt: props.fetchedAt }),
    ...props.data,
  };
  return {
    id: props.id ?? `obs-${props.source}`,
    source: props.source,
    type: VesselObservationType.PARTICULARS,
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

const resolver = new ParticularsResolver();

// ---- CA THẬT · trộn bù trừ hoàn hảo ---------------------------------------

const REAL_SHIPFINDER = particulars({
  source: VesselSource.SHIPFINDER,
  id: "6a7f450a521d474c8df814ea",
  fetchedAt: SHIPFINDER_AT,
  data: { length: 179, beam: 29, draught: 5.9, builtYear: null, deadweight: null },
});

const REAL_SHIPINFO = particulars({
  source: VesselSource.SHIPINFO,
  id: "6a7ef08d311b00bbac1ef270",
  fetchedAt: SHIPINFO_AT,
  data: { length: null, beam: null, draught: null, builtYear: 2010, deadweight: 33261 },
});

test("CA THẬT · trộn field cho kết quả TỐT HƠN CẢ HAI nguồn đơn lẻ", () => {
  const result = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER]);
  assert.ok(result);

  assert.equal(result.length?.value, 179);
  assert.equal(result.length?.source, VesselSource.SHIPFINDER);
  assert.equal(result.beam?.value, 29);
  assert.equal(result.beam?.source, VesselSource.SHIPFINDER);
  assert.equal(result.draught?.value, 5.9);
  assert.equal(result.draught?.source, VesselSource.SHIPFINDER);

  assert.equal(result.builtYear?.value, 2010);
  assert.equal(result.builtYear?.source, VesselSource.SHIPINFO);
  assert.equal(result.deadweight?.value, 33261);
  assert.equal(result.deadweight?.source, VesselSource.SHIPINFO);

  // Không nguồn nào có -> không bịa.
  assert.equal(result.grossTonnage, null);
});

test("CA THẬT · provenance từng field, mỗi field trỏ về đúng observation gốc", () => {
  const result = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER]);

  assert.equal(result?.length?.observationId, "6a7f450a521d474c8df814ea");
  assert.equal(result?.length?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
  assert.equal(result?.length?.fetchedAt.getTime(), SHIPFINDER_AT.getTime());

  assert.equal(result?.builtYear?.observationId, "6a7ef08d311b00bbac1ef270");
  assert.equal(result?.builtYear?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
  assert.equal(result?.builtYear?.fetchedAt.getTime(), SHIPINFO_AT.getTime());

  // Hai field lấy từ HAI nguồn khác nhau — đúng bản chất trộn field.
  assert.notEqual(result?.length?.source, result?.builtYear?.source);
});

// ---- Capability matrix tham gia -------------------------------------------

test("nguồn UNSUPPORTED cho field KHÔNG được vượt nguồn CONFIRMED", () => {
  // ShipInfo đảo kích thước -> matrix ghi UNSUPPORTED cho length/beam.
  // Kể cả khi một observation nào đó lỡ mang giá trị, nó vẫn phải thua.
  const shipinfoWithLength = particulars({
    source: VesselSource.SHIPINFO,
    fetchedAt: new Date(SHIPFINDER_AT.getTime() + 60 * 60 * 1000), // MỚI HƠN
    data: { length: 29 },
  });
  const shipfinder = particulars({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { length: 179 },
  });

  const result = resolver.resolve([shipinfoWithLength, shipfinder]);

  assert.equal(result?.length?.value, 179, "CONFIRMED thắng UNSUPPORTED dù cũ hơn");
  assert.equal(result?.length?.source, VesselSource.SHIPFINDER);
  assert.equal(result?.length?.reason, ResolutionReason.HIGHER_FIELD_QUALITY);
  assert.deepEqual(
    result?.length?.rejected.map((r) => r.reason),
    [RejectionReason.LOWER_FIELD_QUALITY]
  );
});

// ---- Dung sai số ----------------------------------------------------------

test("179 vs 180 nằm trong dung sai -> SOURCES_AGREE, KHÔNG lấy trung bình", () => {
  const a = particulars({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { length: 179 },
  });
  const b = particulars({
    source: VesselSource.VESSELFINDER,
    fetchedAt: SHIPINFO_AT,
    data: { length: 180 },
  });

  const result = resolver.resolve([a, b]);

  assert.equal(result?.length?.reason, ResolutionReason.SOURCES_AGREE);
  // Giá trị phải là con số MỘT NGUỒN THẬT SỰ NÓI, không phải 179.5.
  assert.ok(
    result?.length?.value === 179 || result?.length?.value === 180,
    `nhận ${result?.length?.value} — không được là trung bình`
  );
  assert.notEqual(result?.length?.value, 179.5);
});

test("179 vs 220 ngoài dung sai -> xung đột thật, phân xử tất định", () => {
  const shipfinder = particulars({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { length: 179 },
  });
  const vesselfinder = particulars({
    source: VesselSource.VESSELFINDER,
    fetchedAt: SHIPINFO_AT,
    data: { length: 220 },
  });

  const result = resolver.resolve([shipfinder, vesselfinder]);

  // Cả hai đều CONFIRMED cho length -> rơi xuống NEWER_FETCH (ShipFinder mới hơn).
  assert.equal(result?.length?.value, 179);
  assert.equal(result?.length?.reason, ResolutionReason.NEWER_FETCH);
  assert.deepEqual(
    result?.length?.rejected.map((r) => r.reason),
    [RejectionReason.OLDER_FETCH]
  );
});

test("builtYear dung sai BẰNG 0 — lệch 1 năm là sai thật", () => {
  const a = particulars({
    source: VesselSource.SHIPINFO,
    fetchedAt: SHIPINFO_AT,
    data: { builtYear: 2010 },
  });
  const b = particulars({
    source: VesselSource.VESSELFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { builtYear: 2011 },
  });

  const result = resolver.resolve([a, b]);
  assert.notEqual(result?.builtYear?.reason, ResolutionReason.SOURCES_AGREE);
});

test("mớn nước lệch nhỏ nằm trong dung sai", () => {
  const a = particulars({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { draught: 5.9 },
  });
  const b = particulars({
    source: VesselSource.VESSELFINDER,
    fetchedAt: SHIPINFO_AT,
    data: { draught: 6.0 },
  });
  assert.equal(resolver.resolve([a, b])?.draught?.reason, ResolutionReason.SOURCES_AGREE);
});

// ---- null / INVALID -------------------------------------------------------

test("null từ nguồn mới hơn không xoá giá trị nguồn cũ", () => {
  const newerNull = particulars({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { builtYear: null },
  });
  const olderValue = particulars({
    source: VesselSource.SHIPINFO,
    fetchedAt: SHIPINFO_AT,
    data: { builtYear: 2010 },
  });

  const result = resolver.resolve([newerNull, olderValue]);
  assert.equal(result?.builtYear?.value, 2010);
  assert.equal(result?.builtYear?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
});

test("INVALID không vào vòng trong; không còn ai -> null", () => {
  const invalid = particulars({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    invalid: true,
    data: { length: 999 },
  });
  assert.equal(resolver.resolve([invalid]), null);

  const withValid = resolver.resolve([invalid, REAL_SHIPINFO]);
  assert.equal(withValid?.length, null, "giá trị của bản INVALID không lọt vào");
  assert.equal(withValid?.builtYear?.value, 2010);
});

test("không có observation PARTICULARS -> null", () => {
  assert.equal(resolver.resolve([]), null);
  const other = {
    ...REAL_SHIPFINDER,
    type: VesselObservationType.IDENTITY,
  } as unknown as VesselSourceObservation;
  assert.equal(resolver.resolve([other]), null);
});

// ---- Tất định -------------------------------------------------------------

test("TẤT ĐỊNH: đảo thứ tự đầu vào không đổi kết quả", () => {
  const forward = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER]);
  const backward = resolver.resolve([REAL_SHIPFINDER, REAL_SHIPINFO]);

  for (const field of ["length", "beam", "draught", "builtYear", "deadweight"] as const) {
    assert.equal(forward?.[field]?.value, backward?.[field]?.value, field);
    assert.equal(forward?.[field]?.source, backward?.[field]?.source, field);
  }
});

test("TẤT ĐỊNH: ba nguồn hoà mọi tiêu chí -> sắp theo priority rồi tên nguồn", () => {
  const at = SHIPFINDER_AT;
  const a = particulars({ source: VesselSource.SHIPFINDER, fetchedAt: at, data: { draught: 5.9 } });
  const b = particulars({ source: VesselSource.SHIPINFO, fetchedAt: at, data: { draught: 5.9 } });
  const c = particulars({ source: VesselSource.VESSELFINDER, fetchedAt: at, data: { draught: 5.9 } });

  const winners = [
    [a, b, c], [c, b, a], [b, a, c], [a, c, b],
  ].map((input) => resolver.resolve(input)?.draught?.source);

  assert.equal(new Set(winners).size, 1, `winner phải ổn định, nhận ${winners.join(",")}`);
  // VesselFinder priority 20 nhỏ nhất, và draught của nó là CONFIRMED.
  assert.equal(winners[0], VesselSource.VESSELFINDER);
});
