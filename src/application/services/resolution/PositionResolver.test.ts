// ============================================================================
//  TEST · PositionResolver
// ----------------------------------------------------------------------------
//  Test quan trọng nhất là ca THẬT ShipFinder vs ShipInfo: nó khoá chặt luật
//  cốt lõi "tuổi của NGUỒN quyết định, không phải defaultPriority".
//  Số liệu lấy nguyên từ `vessel_observations` sau POC P6.4/P7.4.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import {
  PositionObservation,
  VesselObservationType,
  VesselSourceObservation,
} from "../../../domain/entities/VesselObservation";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { getSourceCapability } from "../acquisition/capabilities/capabilityQueries";
import { PositionResolver } from "./PositionResolver";
import { PositionFreshness } from "./PositionResolverPolicy";
import { RejectionReason, ResolutionReason } from "./ResolverTypes";

const MMSI = "636018086";
/** Đúng thời điểm POC ShipFinder chạy. */
const NOW = new Date("2026-08-14T16:40:41.985Z");

interface Props {
  source: VesselSource;
  sourceReceivedAt: Date | null;
  fetchedAt?: Date;
  id?: string;
  invalid?: boolean;
  approximate?: boolean;
  lat?: number;
  lng?: number;
  speed?: number | null;
  course?: number | null;
  heading?: number | null;
  navStatus?: { code: number | null; text: string | null } | null;
}

function position(props: Props): PositionObservation {
  const fetchedAt = props.fetchedAt ?? NOW;
  const data: VesselPositionReport = {
    mmsi: MMSI,
    lat: props.lat ?? 33.749683,
    lng: props.lng ?? -118.208917,
    speed: props.speed ?? null,
    course: props.course ?? null,
    heading: props.heading ?? null,
    navStatus: props.navStatus ?? null,
    latLngApproximate: props.approximate ?? false,
    receivedAt: props.sourceReceivedAt ?? fetchedAt,
    metadata: createSourceMetadata({
      source: props.source,
      fetchedAt,
      sourceReceivedAt: props.sourceReceivedAt,
    }),
  };
  return {
    id: props.id ?? `obs-${props.source}`,
    source: props.source,
    type: VesselObservationType.POSITION,
    vesselKey: { mmsi: MMSI },
    fetchedAt,
    sourceReceivedAt: props.sourceReceivedAt,
    validation: {
      status: props.invalid
        ? ObservationValidationStatus.INVALID
        : ObservationValidationStatus.VALID,
      errors: [],
    },
    data,
  };
}

const resolver = new PositionResolver();

// ---- Ca THẬT: ShipFinder vs ShipInfo (BẮT BUỘC) ---------------------------

/** Bản ghi thật của ShipFinder, MMSI 636018086. Tuổi 0.02h -> LIVE. */
const REAL_SHIPFINDER = position({
  source: VesselSource.SHIPFINDER,
  id: "6a7f450a521d474c8df814eb",
  sourceReceivedAt: new Date("2026-08-14T16:39:41.000Z"),
  fetchedAt: new Date("2026-08-14T16:40:41.985Z"),
  lat: 33.74968333333333,
  lng: -118.20891666666667,
  speed: 0,
  course: 0.9,
  heading: 58,
  navStatus: { code: null, text: "Moored" },
});

/** Bản ghi thật của ShipInfo, cùng tàu. Tuổi 14.49h -> STALE. */
const REAL_SHIPINFO = position({
  source: VesselSource.SHIPINFO,
  id: "6a7ef08d311b00bbac1ef271",
  sourceReceivedAt: new Date("2026-08-13T20:11:07.000Z"),
  fetchedAt: new Date("2026-08-14T10:40:13.307Z"),
  lat: 33.74833,
  lng: -118.20833,
  speed: 0,
});

test("CA THẬT · ShipFinder thắng vì mốc NGUỒN tươi hơn, KHÔNG phải vì priority", () => {
  const result = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER], NOW);
  assert.ok(result);

  assert.equal(result.source, VesselSource.SHIPFINDER);
  assert.equal(result.reason, ResolutionReason.FRESHER_SOURCE_TIMESTAMP);
  assert.equal(result.freshness, PositionFreshness.LIVE);

  // Và priority của kẻ thắng thực ra TỆ HƠN — chứng minh priority không quyết định.
  assert.ok(
    getSourceCapability(VesselSource.SHIPFINDER).defaultPriority >
      getSourceCapability(VesselSource.SHIPINFO).defaultPriority,
    "ShipFinder có defaultPriority kém hơn ShipInfo (55 vs 45)"
  );
  assert.notEqual(result.reason, ResolutionReason.TIE_BREAK_PRIORITY);

  assert.deepEqual([...result.rejected], [
    {
      source: VesselSource.SHIPINFO,
      observationId: "6a7ef08d311b00bbac1ef271",
      reason: RejectionReason.STALER_TIMESTAMP,
    },
  ]);
});

test("CA THẬT · provenance đầy đủ, observedAt là mốc NGUỒN chứ không phải fetchedAt", () => {
  const result = resolver.resolve([REAL_SHIPINFO, REAL_SHIPFINDER], NOW);

  assert.equal(result?.observationId, "6a7f450a521d474c8df814eb");
  assert.equal(result?.observedAt?.toISOString(), "2026-08-14T16:39:41.000Z");
  assert.equal(result?.fetchedAt.toISOString(), "2026-08-14T16:40:41.985Z");
  assert.notEqual(result?.observedAt?.getTime(), result?.fetchedAt.getTime());
});

test("CA THẬT · NGUYÊN KHỐI — không lấp field từ kẻ thua", () => {
  // ShipInfo (thua) có speed=0; ShipFinder (thắng) cũng có. Dựng ca gắt hơn:
  // kẻ thua có heading, kẻ thắng không có.
  const winnerNoHeading = position({
    source: VesselSource.SHIPFINDER,
    sourceReceivedAt: new Date("2026-08-14T16:39:41.000Z"),
    speed: 0,
    course: 0.9,
    heading: null,
  });
  const loserWithHeading = position({
    source: VesselSource.SHIPINFO,
    sourceReceivedAt: new Date("2026-08-13T20:11:07.000Z"),
    heading: 50,
    navStatus: { code: 5, text: "Moored" },
  });

  const result = resolver.resolve([winnerNoHeading, loserWithHeading], NOW);

  assert.equal(result?.source, VesselSource.SHIPFINDER);
  assert.equal(result?.position.heading, null, "KHÔNG được lấy heading=50 của kẻ thua");
  assert.equal(result?.position.navStatus, null, "KHÔNG được lấy navStatus của kẻ thua");
  // Payload phải là ĐÚNG object của observation thắng.
  assert.equal(result?.position, winnerNoHeading.data);
});

// ---- INVALID không bao giờ thắng ------------------------------------------

test("INVALID mới hơn KHÔNG thắng VALID cũ hơn", () => {
  const invalidFresh = position({
    source: VesselSource.SHIPFINDER,
    sourceReceivedAt: new Date("2026-08-14T16:39:41.000Z"),
    invalid: true,
  });

  const result = resolver.resolve([invalidFresh, REAL_SHIPINFO], NOW);

  assert.equal(result?.source, VesselSource.SHIPINFO);
  assert.equal(result?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
  assert.deepEqual(
    result?.rejected.map((r) => [r.source, r.reason]),
    [[VesselSource.SHIPFINDER, RejectionReason.INVALID_OBSERVATION]]
  );
});

test("mọi ứng viên INVALID -> null, không bịa vị trí", () => {
  const a = position({ source: VesselSource.SHIPFINDER, sourceReceivedAt: NOW, invalid: true });
  const b = position({ source: VesselSource.SHIPINFO, sourceReceivedAt: NOW, invalid: true });
  assert.equal(resolver.resolve([a, b], NOW), null);
});

// ---- NO_SOURCE_TIME -------------------------------------------------------

test("thiếu mốc nguồn thua cả bản ghi CŨ 20 GIỜ có mốc thật", () => {
  // VesselFinder luôn đặt sourceReceivedAt = null, dù vừa fetch xong.
  const vesselfinderNoTime = position({
    source: VesselSource.VESSELFINDER,
    sourceReceivedAt: null,
    fetchedAt: NOW,
  });
  const shipinfoOld = position({
    source: VesselSource.SHIPINFO,
    sourceReceivedAt: new Date(NOW.getTime() - 20 * 60 * 60 * 1000),
  });

  const result = resolver.resolve([vesselfinderNoTime, shipinfoOld], NOW);

  assert.equal(result?.source, VesselSource.SHIPINFO, "fetchedAt mới KHÔNG được coi là tươi");
  assert.equal(result?.freshness, PositionFreshness.STALE);
  assert.deepEqual(
    result?.rejected.map((r) => r.reason),
    [RejectionReason.NO_SOURCE_TIMESTAMP]
  );
});

test("thiếu mốc nguồn VẪN được chọn nếu là ứng viên duy nhất, observedAt = null", () => {
  const only = position({ source: VesselSource.VESSELFINDER, sourceReceivedAt: null });
  const result = resolver.resolve([only], NOW);

  assert.equal(result?.source, VesselSource.VESSELFINDER);
  assert.equal(result?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
  assert.equal(result?.freshness, PositionFreshness.NO_SOURCE_TIME);
  assert.equal(result?.observedAt, null, "KHÔNG mượn fetchedAt");
  assert.ok(result?.fetchedAt instanceof Date);
});

// ---- Độ chính xác ---------------------------------------------------------

test("cùng bậc: toạ độ chính xác thắng toạ độ làm tròn", () => {
  const approx = position({
    source: VesselSource.SHIPINFO,
    sourceReceivedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    approximate: true,
  });
  const precise = position({
    source: VesselSource.SHIPFINDER,
    sourceReceivedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    approximate: false,
  });

  const result = resolver.resolve([approx, precise], NOW);
  assert.equal(result?.source, VesselSource.SHIPFINDER);
  assert.equal(result?.reason, ResolutionReason.HIGHER_PRECISION);
  assert.deepEqual(
    result?.rejected.map((r) => r.reason),
    [RejectionReason.LOWER_PRECISION]
  );
});

test("ĐỘ TƯƠI THẮNG ĐỘ CHÍNH XÁC — LIVE approximate thắng STALE precise", () => {
  const liveApprox = position({
    source: VesselSource.VESSELFINDER,
    sourceReceivedAt: new Date(NOW.getTime() - 2 * 60 * 1000),
    approximate: true,
  });
  const stalePrecise = position({
    source: VesselSource.SHIPFINDER,
    sourceReceivedAt: new Date(NOW.getTime() - 20 * 60 * 60 * 1000),
    approximate: false,
  });

  const result = resolver.resolve([liveApprox, stalePrecise], NOW);

  // Toạ độ làm tròn ~111km vẫn tốt hơn vị trí chính xác của 20 giờ trước.
  assert.equal(result?.source, VesselSource.VESSELFINDER);
  assert.equal(result?.reason, ResolutionReason.FRESHER_SOURCE_TIMESTAMP);
  assert.equal(result?.freshness, PositionFreshness.LIVE);
});

// ---- Đầy đủ chuyển động ---------------------------------------------------

test("cùng bậc + cùng độ chính xác: nhiều field chuyển động hơn thắng", () => {
  const at = new Date(NOW.getTime() - 3 * 60 * 1000);
  const sparse = position({ source: VesselSource.SHIPINFO, sourceReceivedAt: at, speed: 10, course: 90 });
  const full = position({
    source: VesselSource.SHIPFINDER,
    sourceReceivedAt: at,
    speed: 10,
    course: 90,
    heading: 88,
    navStatus: { code: null, text: "Under way using engine" },
  });

  const result = resolver.resolve([sparse, full], NOW);
  assert.equal(result?.source, VesselSource.SHIPFINDER);
  assert.equal(result?.reason, ResolutionReason.MORE_COMPLETE);
  assert.deepEqual(
    result?.rejected.map((r) => r.reason),
    [RejectionReason.LESS_COMPLETE]
  );
});

// ---- Priority -------------------------------------------------------------

test("hoà mọi tiêu chí -> defaultPriority nhỏ hơn thắng (NƠI DUY NHẤT priority quyết định)", () => {
  const at = new Date(NOW.getTime() - 3 * 60 * 1000);
  const shipfinder = position({ source: VesselSource.SHIPFINDER, sourceReceivedAt: at, speed: 1 });
  const shipinfo = position({ source: VesselSource.SHIPINFO, sourceReceivedAt: at, speed: 1 });

  const result = resolver.resolve([shipfinder, shipinfo], NOW);

  // ShipInfo priority 45 < ShipFinder 55.
  assert.equal(result?.source, VesselSource.SHIPINFO);
  assert.equal(result?.reason, ResolutionReason.TIE_BREAK_PRIORITY);
  assert.deepEqual(
    result?.rejected.map((r) => r.reason),
    [RejectionReason.TIE_BREAK_PRIORITY]
  );
});

// ---- Tất định -------------------------------------------------------------

test("TẤT ĐỊNH: đảo thứ tự đầu vào không đổi kết quả", () => {
  const at = new Date(NOW.getTime() - 3 * 60 * 1000);
  const a = position({ source: VesselSource.SHIPFINDER, sourceReceivedAt: at, speed: 1 });
  const b = position({ source: VesselSource.SHIPINFO, sourceReceivedAt: at, speed: 1 });
  const c = position({ source: VesselSource.VESSELFINDER, sourceReceivedAt: at, speed: 1 });

  const orders: VesselSourceObservation[][] = [
    [a, b, c], [c, b, a], [b, a, c], [c, a, b], [b, c, a], [a, c, b],
  ];
  const winners = orders.map((o) => resolver.resolve(o, NOW)?.source);
  assert.equal(new Set(winners).size, 1, `winner phải luôn giống nhau, nhận ${winners.join(",")}`);
  // VesselFinder priority 20 là nhỏ nhất.
  assert.equal(winners[0], VesselSource.VESSELFINDER);
});

test("TẤT ĐỊNH: priority bằng nhau -> sắp theo tên nguồn, không phụ thuộc thứ tự mảng", () => {
  const at = new Date(NOW.getTime() - 3 * 60 * 1000);
  const samePriority = (source: VesselSource): number => 50;
  const fixed = new PositionResolver({ priorityOf: samePriority });

  const a = position({ source: VesselSource.SHIPFINDER, sourceReceivedAt: at });
  const b = position({ source: VesselSource.SHIPINFO, sourceReceivedAt: at });

  // "shipfinder" < "shipinfo" theo bảng chữ cái.
  assert.equal(fixed.resolve([a, b], NOW)?.source, VesselSource.SHIPFINDER);
  assert.equal(fixed.resolve([b, a], NOW)?.source, VesselSource.SHIPFINDER);
});

// ---- Biên -----------------------------------------------------------------

test("mảng rỗng / không có nhóm POSITION -> null", () => {
  assert.equal(resolver.resolve([], NOW), null);

  const identity = {
    ...REAL_SHIPFINDER,
    type: VesselObservationType.IDENTITY,
  } as unknown as VesselSourceObservation;
  // Observation khác nhóm bị BỎ QUA im lặng, không tính là "bị loại".
  assert.equal(resolver.resolve([identity], NOW), null);
});

test("một ứng viên duy nhất -> ONLY_AVAILABLE_VALUE, rejected rỗng", () => {
  const result = resolver.resolve([REAL_SHIPFINDER], NOW);
  assert.equal(result?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
  assert.deepEqual([...(result?.rejected ?? [])], []);
});

test("ba nguồn: xếp hạng theo bậc, rejected ghi lý do của TỪNG kẻ thua", () => {
  const live = position({
    source: VesselSource.SHIPFINDER,
    sourceReceivedAt: new Date(NOW.getTime() - 60 * 1000),
  });
  const stale = position({
    source: VesselSource.SHIPINFO,
    sourceReceivedAt: new Date(NOW.getTime() - 14 * 60 * 60 * 1000),
  });
  const noTime = position({ source: VesselSource.VESSELFINDER, sourceReceivedAt: null });

  const result = resolver.resolve([stale, noTime, live], NOW);

  assert.equal(result?.source, VesselSource.SHIPFINDER);
  assert.equal(result?.rejected.length, 2);
  const bySource = new Map(result?.rejected.map((r) => [r.source, r.reason]));
  assert.equal(bySource.get(VesselSource.SHIPINFO), RejectionReason.STALER_TIMESTAMP);
  assert.equal(bySource.get(VesselSource.VESSELFINDER), RejectionReason.NO_SOURCE_TIMESTAMP);
});
