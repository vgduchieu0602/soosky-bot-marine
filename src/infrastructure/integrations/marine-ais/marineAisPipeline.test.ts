// ============================================================================
//  TEST TÍCH HỢP · AIS đi vào ĐÚNG đường ống đang có, không có ống riêng
// ----------------------------------------------------------------------------
//      MarineAisMessage -> MarineAisMessageMapper -> ProviderDetailsResult
//        -> providerResultToObservation (P5) -> PositionResolver/IdentityResolver (P8)
//
//  Không mock resolver, không mock validator. Không DB, không mạng, không
//  repository — phase này CHƯA persist gì (docs/AIS_CANONICAL_INGESTION.md §8).
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { detailsResultToObservations } from "../../../application/services/observation/providerResultToObservation";
import { IdentityResolver } from "../../../application/services/resolution/IdentityResolver";
import { PositionResolver } from "../../../application/services/resolution/PositionResolver";
import { PositionFreshness } from "../../../application/services/resolution/PositionResolverPolicy";
import { ResolutionReason } from "../../../application/services/resolution/ResolverTypes";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import { VesselIdentity } from "../../../domain/value-objects/VesselIdentity";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import {
  VesselObservationType,
  VesselSourceObservation,
} from "../../../domain/entities/VesselObservation";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../../domain/enums/VesselSource";
import {
  MARINE_AIS_PARSER_VERSION,
  mapMarineAisMessage,
} from "./MarineAisMessageMapper";
import { MarineAisMessage, MarineAisMessageType } from "./MarineAisTypes";

const MMSI = "636018086";
const RECEIVED_AT = new Date("2026-08-16T10:05:20.000Z");
const AIS_INSTANT = new Date("2026-08-16T10:05:00.000Z");

function aisPosition(): MarineAisMessage {
  return {
    type: MarineAisMessageType.POSITION_REPORT,
    data: {
      mmsi: 636018086,
      latlng: [33.749667, -118.20895],
      sog: 10.6,
      cog: 123,
      timestamp: "2026-08-16 10:05:00 +0000 UTC",
      navigationalStatus: 0,
    },
  };
}

function aisStatic(): MarineAisMessage {
  return {
    type: MarineAisMessageType.SHIP_STATIC_DATA,
    data: { mmsi: 636018086, imo: 9074729, type: 70, name: "AGIA DOXA" },
  };
}

/** Observation của message AIS, đi qua đúng mapper P5 hiện có. */
function aisObservations(message: MarineAisMessage): readonly VesselSourceObservation[] {
  const result = mapMarineAisMessage(message, RECEIVED_AT);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return detailsResultToObservations(result.result, {
    parserVersion: MARINE_AIS_PARSER_VERSION,
    now: RECEIVED_AT,
  });
}

/** Ứng viên đối chứng: một nguồn crawl thật, dựng thẳng ở tầng canonical. */
function shipFinderPosition(sourceReceivedAt: Date): VesselPositionReport {
  return {
    mmsi: MMSI,
    imo: "9074729",
    lat: 33.7,
    lng: -118.2,
    speed: 10.4,
    course: 120,
    // ShipFinder là nguồn DUY NHẤT trong bot có heading -> nhiều field chuyển
    // động hơn AIS qua đường Marine. Cố ý, để thấy tiêu chí nào đang quyết định.
    heading: 118,
    navStatus: { code: null, text: "Under way using engine" },
    latLngApproximate: false,
    receivedAt: sourceReceivedAt,
    metadata: createSourceMetadata({
      source: VesselSource.SHIPFINDER,
      fetchedAt: RECEIVED_AT,
      sourceReceivedAt,
    }),
  };
}

function shipFinderIdentity(): VesselIdentity {
  return {
    mmsi: MMSI,
    imo: "9074729",
    name: "AGIA DOXA",
    callsign: "5LAB9",
    vesselType: "Bulk Carrier",
    // ShipFinder chỉ có nhãn chữ, không có mã AIS.
    vesselTypeCode: null,
    flag: { code: "LBR", name: null },
    metadata: createSourceMetadata({
      source: VesselSource.SHIPFINDER,
      fetchedAt: RECEIVED_AT,
      sourceReceivedAt: null,
    }),
  };
}

function shipFinderObservations(position: VesselPositionReport): readonly VesselSourceObservation[] {
  return detailsResultToObservations({ position }, { now: RECEIVED_AT });
}

// ---------------------------------------------------------------------------
//  §27 · Tương thích Observation
// ---------------------------------------------------------------------------

test("§27 position AIS -> đúng MỘT observation POSITION, xuất xứ AISSTREAM", () => {
  const observations = aisObservations(aisPosition());

  assert.equal(observations.length, 1);
  const [observation] = observations;
  assert.equal(observation.type, VesselObservationType.POSITION);
  assert.equal(observation.source, VesselSource.AISSTREAM);
  assert.equal(observation.vesselKey.mmsi, MMSI);
  assert.equal(observation.validation.status, ObservationValidationStatus.VALID);
  assert.equal(observation.parserVersion, MARINE_AIS_PARSER_VERSION);

  // Hai mốc thời gian KHÔNG được lẫn nhau.
  assert.equal(observation.sourceReceivedAt?.toISOString(), AIS_INSTANT.toISOString());
  assert.equal(observation.fetchedAt.toISOString(), RECEIVED_AT.toISOString());

  if (observation.type !== VesselObservationType.POSITION) return;
  assert.equal(observation.data.lat, 33.749667);
  assert.equal(observation.data.heading, null);
});

test("§27 static AIS -> observation IDENTITY, KHÔNG kèm position", () => {
  const observations = aisObservations(aisStatic());

  assert.equal(observations.length, 1);
  const [observation] = observations;
  assert.equal(observation.type, VesselObservationType.IDENTITY);
  assert.equal(observation.source, VesselSource.AISSTREAM);
  assert.equal(observation.validation.status, ObservationValidationStatus.VALID);
  // Message 5 không có mốc thời gian -> null, không mượn đồng hồ bot.
  assert.equal(observation.sourceReceivedAt, null);
});

test("AIS lưu chung kho observation với nguồn crawl, không tách bảng riêng", () => {
  const all = [
    ...aisObservations(aisPosition()),
    ...shipFinderObservations(shipFinderPosition(AIS_INSTANT)),
  ];
  // Cùng kiểu, cùng khoá tàu, khác mỗi `source` — đó là toàn bộ khác biệt.
  assert.deepEqual(
    all.map((o) => o.source),
    [VesselSource.AISSTREAM, VesselSource.SHIPFINDER]
  );
  assert.equal(new Set(all.map((o) => o.vesselKey.mmsi)).size, 1);
});

// ---------------------------------------------------------------------------
//  §28 · Tương thích Resolver — KHÔNG hardcode "AIS luôn thắng"
// ---------------------------------------------------------------------------
//  Bậc độ tươi hiện tại: LIVE <= 30 phút < RECENT <= 6 giờ. Ba ca dưới đây chọn
//  `now` để rơi vào hai phía của đúng cái ranh giới đó.

const resolver = new PositionResolver();

test("§28a AIS mới hơn và vượt bậc độ tươi -> AIS thắng", () => {
  const now = new Date("2026-08-16T10:35:00.000Z");
  const candidates = [
    ...shipFinderObservations(shipFinderPosition(new Date("2026-08-16T10:00:00.000Z"))),
    ...aisObservations(aisPosition()),
  ];

  const resolved = resolver.resolve(candidates, now);
  assert.equal(resolved?.source, VesselSource.AISSTREAM);
  assert.equal(resolved?.freshness, PositionFreshness.LIVE);
  assert.equal(resolved?.reason, ResolutionReason.FRESHER_SOURCE_TIMESTAMP);
  assert.equal(resolved?.observedAt?.toISOString(), AIS_INSTANT.toISOString());
});

test("§28b ShipFinder mới hơn -> ShipFinder thắng, AIS không có đặc quyền", () => {
  const now = new Date("2026-08-16T10:36:00.000Z");
  const candidates = [
    ...aisObservations(aisPosition()),
    ...shipFinderObservations(shipFinderPosition(new Date("2026-08-16T10:10:00.000Z"))),
  ];

  const resolved = resolver.resolve(candidates, now);
  assert.equal(resolved?.source, VesselSource.SHIPFINDER);
  assert.equal(resolved?.reason, ResolutionReason.FRESHER_SOURCE_TIMESTAMP);
});

test("§28c cùng bậc độ tươi -> AIS vẫn có thể THUA vì thiếu heading", () => {
  // AIS 10:05 và ShipFinder 10:10 đều <= 30 phút so với 10:30 -> cùng LIVE.
  // Lúc đó tiêu chí kế tiếp mới lên tiếng: độ chính xác, rồi độ đầy đủ chuyển
  // động. Marine API không chuyển tiếp heading nên AIS đếm được 3/4 field.
  const now = new Date("2026-08-16T10:30:00.000Z");
  const candidates = [
    ...aisObservations(aisPosition()),
    ...shipFinderObservations(shipFinderPosition(new Date("2026-08-16T10:10:00.000Z"))),
  ];

  const resolved = resolver.resolve(candidates, now);
  assert.equal(resolved?.source, VesselSource.SHIPFINDER);
  assert.equal(resolved?.reason, ResolutionReason.MORE_COMPLETE);
});

test("§28 chỉ có AIS -> vẫn ra vị trí canonical, không cần nguồn thứ hai", () => {
  const resolved = resolver.resolve(
    aisObservations(aisPosition()),
    new Date("2026-08-16T10:06:00.000Z")
  );
  assert.equal(resolved?.source, VesselSource.AISSTREAM);
  assert.equal(resolved?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
  assert.equal(resolved?.position.mmsi, MMSI);
});

test("identity AIS bổ sung vesselTypeCode — field không nguồn free nào cấp", () => {
  const identityResolver = new IdentityResolver();
  const resolved = identityResolver.resolve([
    ...aisObservations(aisStatic()),
    ...detailsResultToObservations({ identity: shipFinderIdentity() }, { now: RECEIVED_AT }),
  ]);

  assert.equal(resolved?.mmsi, MMSI);
  // AIS là nguồn DUY NHẤT có mã loại tàu.
  assert.equal(resolved?.vesselTypeCode?.value, 70);
  assert.equal(resolved?.vesselTypeCode?.source, VesselSource.AISSTREAM);
  // Nhãn chữ / callsign / cờ thì AIS không có -> nguồn crawl điền. Hai nguồn bổ
  // sung nhau theo FIELD, không tranh nhau nguyên khối.
  assert.equal(resolved?.vesselType?.source, VesselSource.SHIPFINDER);
  assert.equal(resolved?.callsign?.source, VesselSource.SHIPFINDER);
});
