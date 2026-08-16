// ============================================================================
//  TEST · MapVesselReadiness + MapVesselProjector
// ----------------------------------------------------------------------------
//  Hàm thuần: `now` luôn truyền vào, không đọc đồng hồ hệ thống ở đâu cả.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import { PositionFreshness } from "../resolution/PositionResolverPolicy";
import { ResolutionReason } from "../resolution/ResolverTypes";
import { ResolvedCurrentVessel } from "../resolution/ResolvedCurrentVessel";
import { projectMapVessel, projectMapVessels } from "./MapVesselProjector";
import {
  DEFAULT_MAP_READINESS_POLICY,
  MapReadinessReason,
  evaluateMapReadiness,
  isMapReady,
} from "./MapVesselReadiness";

const NOW = new Date("2026-08-16T12:00:00.000Z");
const MMSI = "636018086";

function positionReport(overrides: Partial<VesselPositionReport> = {}): VesselPositionReport {
  const observedAt = overrides.receivedAt ?? new Date(NOW.getTime() - 60_000);
  return {
    mmsi: MMSI,
    imo: null,
    lat: 10,
    lng: 106,
    speed: 12.3,
    course: 87,
    heading: null,
    navStatus: { code: 0, text: "Under way using engine" },
    latLngApproximate: false,
    receivedAt: observedAt,
    metadata: createSourceMetadata({
      source: VesselSource.AISSTREAM,
      fetchedAt: NOW,
      sourceReceivedAt: observedAt,
    }),
    ...overrides,
  };
}

function field<T>(value: T) {
  return {
    value,
    source: VesselSource.AISSTREAM,
    observedAt: null,
    fetchedAt: NOW,
    reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
    rejected: [],
  };
}

interface VesselOptions {
  mmsi?: string;
  imo?: string;
  observedAt?: Date | null;
  position?: VesselPositionReport | null;
  /** Bậc độ tươi ĐÃ LƯU — cố ý cho phép đặt sai để chứng minh nó bị bỏ qua. */
  storedFreshness?: PositionFreshness;
  identity?: { name?: string; imo?: string; vesselTypeCode?: number } | null;
}

function vessel(options: VesselOptions = {}): ResolvedCurrentVessel {
  const report = options.position === undefined ? positionReport() : options.position;
  const observedAt =
    options.observedAt === undefined ? report?.receivedAt ?? null : options.observedAt;

  return {
    // `"mmsi" in options` chứ không phải `!== undefined`: test cần phân biệt
    // "không khai" với "khai là undefined" (tàu chỉ biết IMO).
    vesselKey: { mmsi: "mmsi" in options ? options.mmsi : MMSI, imo: options.imo },
    identity:
      options.identity === undefined || options.identity === null
        ? null
        : ({
            mmsi: MMSI,
            imo: options.identity.imo === undefined ? null : field(options.identity.imo),
            name: options.identity.name === undefined ? null : field(options.identity.name),
            callsign: null,
            vesselType: null,
            vesselTypeCode:
              options.identity.vesselTypeCode === undefined
                ? null
                : field(options.identity.vesselTypeCode),
            flagCode: null,
            flagName: null,
          } as never),
    position:
      report === null
        ? null
        : ({
            position: report,
            source: VesselSource.AISSTREAM,
            observationId: "obs-1",
            observedAt,
            fetchedAt: NOW,
            freshness: options.storedFreshness ?? PositionFreshness.LIVE,
            reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
            rejected: [],
          } as never),
    particulars: null,
    voyage: null,
    resolvedAt: NOW,
  };
}

// ---------------------------------------------------------------------------
//  §22 · Đủ điều kiện
// ---------------------------------------------------------------------------

test("§22 MMSI + toạ độ + mốc mới -> ready", () => {
  const result = evaluateMapReadiness(vessel(), NOW);
  assert.equal(result.ready, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.ageMs, 60_000);
  assert.equal(isMapReady(vessel(), NOW), true);
});

// ---------------------------------------------------------------------------
//  §23 · Không có vị trí
// ---------------------------------------------------------------------------

test("§23 chưa có nhóm POSITION -> NO_POSITION", () => {
  const result = evaluateMapReadiness(vessel({ position: null }), NOW);
  assert.equal(result.ready, false);
  assert.equal(result.reason, MapReadinessReason.NO_POSITION);
});

test("không có MMSI (tàu chỉ biết IMO) -> NO_MMSI", () => {
  const result = evaluateMapReadiness(vessel({ mmsi: undefined, imo: "9074729" }), NOW);
  assert.equal(result.ready, false);
  assert.equal(result.reason, MapReadinessReason.NO_MMSI);
});

// ---------------------------------------------------------------------------
//  §24 + §6 · CŨ — dù freshness đã lưu nói LIVE
// ---------------------------------------------------------------------------

test("§24 vị trí 2 ngày tuổi -> STALE, BẤT KỂ freshness đã lưu là LIVE", () => {
  const twoDaysAgo = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
  const stale = vessel({
    position: positionReport({ receivedAt: twoDaysAgo }),
    // Đây chính là cái bẫy: canonical chỉ ghi lại khi có dữ liệu mới, nên tàu
    // ngừng phát tín hiệu giữ nguyên bậc LIVE trong document mãi mãi.
    storedFreshness: PositionFreshness.LIVE,
  });

  assert.equal(stale.position?.freshness, PositionFreshness.LIVE, "document vẫn nói LIVE");

  const result = evaluateMapReadiness(stale, NOW);
  assert.equal(result.ready, false);
  assert.equal(result.reason, MapReadinessReason.STALE_POSITION);
  assert.equal(result.ageMs, 2 * 24 * 60 * 60 * 1000);
});

test("đúng ranh giới 24h vẫn ready; qua ranh giới một mili-giây là hết", () => {
  const limit = DEFAULT_MAP_READINESS_POLICY.maxPositionAgeMs;
  const atLimit = new Date(NOW.getTime() - limit);
  const overLimit = new Date(NOW.getTime() - limit - 1);

  assert.equal(evaluateMapReadiness(vessel({ position: positionReport({ receivedAt: atLimit }) }), NOW).ready, true);
  assert.equal(
    evaluateMapReadiness(vessel({ position: positionReport({ receivedAt: overLimit }) }), NOW).reason,
    MapReadinessReason.STALE_POSITION
  );
});

test("ngưỡng mặc định DÙNG LẠI hằng số của resolver, không khai số thứ hai", () => {
  assert.equal(DEFAULT_MAP_READINESS_POLICY.maxPositionAgeMs, 24 * 60 * 60 * 1000);
});

test("policy tiêm được -> ngưỡng chặt hơn loại tàu cũ hơn", () => {
  const tenMinutesAgo = new Date(NOW.getTime() - 10 * 60 * 1000);
  const target = vessel({ position: positionReport({ receivedAt: tenMinutesAgo }) });
  assert.equal(evaluateMapReadiness(target, NOW).ready, true);
  assert.equal(
    evaluateMapReadiness(target, NOW, { maxPositionAgeMs: 5 * 60 * 1000, futureToleranceMs: 60_000 })
      .reason,
    MapReadinessReason.STALE_POSITION
  );
});

// ---------------------------------------------------------------------------
//  §7 · Mốc ở tương lai
// ---------------------------------------------------------------------------

test("§7 mốc nguồn ở tương lai xa -> INVALID, KHÔNG phải 'siêu tươi'", () => {
  const future = new Date(NOW.getTime() + 60 * 60 * 1000);
  const result = evaluateMapReadiness(vessel({ position: positionReport({ receivedAt: future }) }), NOW);
  assert.equal(result.ready, false);
  assert.equal(result.reason, MapReadinessReason.INVALID_POSITION);
});

test("lệch đồng hồ nhỏ vẫn chấp nhận", () => {
  const slightlyAhead = new Date(NOW.getTime() + 60 * 1000);
  assert.equal(
    evaluateMapReadiness(vessel({ position: positionReport({ receivedAt: slightlyAhead }) }), NOW).ready,
    true
  );
});

test("nguồn không khai mốc -> NO_POSITION_TIME, không đoán tuổi", () => {
  const result = evaluateMapReadiness(vessel({ observedAt: null }), NOW);
  assert.equal(result.ready, false);
  assert.equal(result.reason, MapReadinessReason.NO_POSITION_TIME);
});

// ---------------------------------------------------------------------------
//  §12 · Toạ độ hỏng
// ---------------------------------------------------------------------------

test("§12 toạ độ ngoài phạm vi -> INVALID_POSITION", () => {
  for (const bad of [{ lat: 91, lng: 10 }, { lat: 10, lng: 181 }, { lat: Number.NaN, lng: 10 }]) {
    const result = evaluateMapReadiness(vessel({ position: positionReport(bad) }), NOW);
    assert.equal(result.ready, false, JSON.stringify(bad));
    assert.equal(result.reason, MapReadinessReason.INVALID_POSITION);
  }
});

// ---------------------------------------------------------------------------
//  §25 · Identity thiếu vẫn vẽ được
// ---------------------------------------------------------------------------

test("§25 chỉ có vị trí, không IMO/tên/loại -> VẪN ready", () => {
  const anonymous = vessel({ identity: null });
  assert.equal(evaluateMapReadiness(anonymous, NOW).ready, true);

  const projected = projectMapVessel(anonymous, NOW);
  assert.equal(projected?.mmsi, MMSI);
  // §20: thiếu thì null, TUYỆT ĐỐI không 0 / "N/A".
  assert.equal(projected?.imo, null);
  assert.equal(projected?.vesselName, null);
  assert.equal(projected?.vesselTypeCode, null);
});

// ---------------------------------------------------------------------------
//  Projector
// ---------------------------------------------------------------------------

test("projector bóc giá trị khỏi provenance, giữ tên canonical `lng`", () => {
  const full = vessel({
    identity: { name: "AGIA DOXA", imo: "9074729", vesselTypeCode: 70 },
  });
  const projected = projectMapVessel(full, NOW);

  assert.equal(projected?.mmsi, MMSI);
  assert.equal(projected?.imo, "9074729");
  assert.equal(projected?.vesselName, "AGIA DOXA");
  assert.equal(projected?.vesselTypeCode, 70);
  assert.equal(projected?.lat, 10);
  assert.equal(projected?.lng, 106, "canonical dùng `lng`; đổi sang `lon` là việc của adapter");
  assert.equal(projected?.speed, 12.3);
  assert.equal(projected?.course, 87);
  assert.deepEqual(projected?.navStatus, { code: 0, text: "Under way using engine" });
  assert.equal(projected?.positionSource, VesselSource.AISSTREAM);
  assert.equal(projected?.ageMs, 60_000);
});

test("projector trả null khi chưa đủ điều kiện — không phát object thiếu toạ độ", () => {
  assert.equal(projectMapVessel(vessel({ position: null }), NOW), null);
  assert.equal(projectMapVessel(vessel({ mmsi: undefined }), NOW), null);
});

test("projectMapVessels lọc tàu chưa sẵn sàng, giữ thứ tự", () => {
  const old = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
  const list = [
    vessel({ mmsi: "111111111" }),
    vessel({ mmsi: "222222222", position: null }),
    vessel({ mmsi: "333333333", position: positionReport({ receivedAt: old }) }),
    vessel({ mmsi: "444444444" }),
  ];
  assert.deepEqual(
    projectMapVessels(list, NOW).map((item) => item.mmsi),
    ["111111111", "444444444"]
  );
});
