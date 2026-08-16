// ============================================================================
//  TEST · MarineAisMessageMapper — message production -> canonical
// ----------------------------------------------------------------------------
//  Payload trong file này sao chép ĐÚNG hình dạng mà
//  `AisWebSocketManager._dataTransform` của Soosky-marine-api đang phát. Test
//  nào đỏ ở đây nghĩa là hai repo đã lệch contract.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import {
  MARINE_AIS_PARSER_VERSION,
  MarineAisRejectReason,
  buildMarineAisMetadata,
  cleanAisText,
  mapMarineAisMessage,
  parseAisSourceInstant,
  toVesselIdentity,
  toVesselPositionReport,
} from "./MarineAisMessageMapper";
import {
  MarineAisMessage,
  MarineAisMessageType,
  MarineAisPositionData,
  MarineAisStaticData,
  isMarineAisMessage,
} from "./MarineAisTypes";

const MMSI = 636018086;
const MMSI_TEXT = "636018086";
/** IMO thật, khớp checksum ISO 8713. */
const IMO = 9074729;

/** Bot nhận frame lúc 12:10 — đồng hồ CỦA BOT. */
const RECEIVED_AT = new Date("2026-08-16T12:10:00.000Z");
/** AIS ghi 12:09:42 — đồng hồ CỦA NGUỒN. Định dạng in mặc định của Go. */
const AIS_TIME = "2026-08-16 12:09:42.123456789 +0000 UTC";
const AIS_INSTANT = new Date("2026-08-16T12:09:42.123Z");

function positionMessage(overrides: Partial<MarineAisPositionData> = {}): MarineAisMessage {
  return {
    type: MarineAisMessageType.POSITION_REPORT,
    data: {
      mmsi: MMSI,
      latlng: [33.749667, -118.20895],
      sog: 10.6,
      cog: 123,
      timestamp: AIS_TIME,
      navigationalStatus: 5,
      ...overrides,
    },
  };
}

function staticMessage(overrides: Partial<MarineAisStaticData> = {}): MarineAisMessage {
  return {
    type: MarineAisMessageType.SHIP_STATIC_DATA,
    data: { mmsi: MMSI, imo: IMO, type: 70, name: "AGIA DOXA", ...overrides },
  };
}

/** Ép nhánh thành công — test nào gọi hàm này là test mong đợi map được. */
function mapped(message: MarineAisMessage, receivedAt: Date = RECEIVED_AT) {
  const result = mapMarineAisMessage(message, receivedAt);
  assert.equal(result.ok, true, `mong đợi map được, nhận ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  return result.result;
}

function rejectedWith(message: MarineAisMessage, reason: MarineAisRejectReason): void {
  const result = mapMarineAisMessage(message, RECEIVED_AT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, reason);
}

// ---------------------------------------------------------------------------
//  §17 · PositionReport hợp lệ
// ---------------------------------------------------------------------------

test("PositionReport -> canonical position đầy đủ, nguồn là AISSTREAM", () => {
  const { position, identity } = mapped(positionMessage());

  assert.notEqual(position, undefined);
  assert.equal(identity, undefined, "PositionReport không sinh identity");
  assert.equal(position?.metadata.source, VesselSource.AISSTREAM);
  assert.equal(position?.mmsi, MMSI_TEXT);
  assert.equal(position?.lat, 33.749667);
  assert.equal(position?.lng, -118.20895);
  assert.equal(position?.speed, 10.6);
  assert.equal(position?.course, 123);
  assert.deepEqual(position?.navStatus, { code: 5, text: "Moored" });
  assert.equal(position?.latLngApproximate, false);
});

test("Marine API KHÔNG trở thành VesselSource — chỉ là đường truyền", () => {
  const { position } = mapped(positionMessage());
  assert.equal(position?.metadata.source, "aisstream");
  const { identity } = mapped(staticMessage());
  assert.equal(identity?.metadata.source, "aisstream");
});

// ---------------------------------------------------------------------------
//  §18 · ShipStaticData hợp lệ
// ---------------------------------------------------------------------------

test("ShipStaticData -> canonical identity", () => {
  const { identity, position } = mapped(staticMessage());

  assert.equal(position, undefined, "ShipStaticData không sinh position");
  assert.equal(identity?.mmsi, MMSI_TEXT);
  assert.equal(identity?.imo, "9074729");
  assert.equal(identity?.name, "AGIA DOXA");
  assert.equal(identity?.vesselTypeCode, 70);
  assert.equal(identity?.metadata.source, VesselSource.AISSTREAM);
  // Marine API không chuyển tiếp callsign; nhãn chữ và cờ phải suy diễn.
  assert.equal(identity?.callsign, null);
  assert.equal(identity?.vesselType, null);
  assert.equal(identity?.flag, null);
});

test("tên AIS đệm '@' bị dọn, không lọt vào canonical", () => {
  assert.equal(cleanAisText("MAERSK SEALAND@@@@@@"), "MAERSK SEALAND");
  assert.equal(cleanAisText("@@@@@@"), null);
  assert.equal(cleanAisText("   "), null);
  assert.equal(mapped(staticMessage({ name: "AGIA  DOXA@@@" })).identity?.name, "AGIA DOXA");
});

// ---------------------------------------------------------------------------
//  §19 + §20 · Hai loại message ĐỘC LẬP
// ---------------------------------------------------------------------------

test("§19 PositionReport chỉ có MMSI + vị trí vẫn ra observation hợp lệ", () => {
  // Không IMO, không name, không vesselType — đúng tình huống tàu vừa phát vị
  // trí mà chưa tới chu kỳ 6 phút của ShipStaticData.
  const { position } = mapped(positionMessage());
  assert.equal(position?.mmsi, MMSI_TEXT);
  assert.equal(position?.imo, null);
});

test("§20 ShipStaticData không cần vị trí vẫn ra identity hợp lệ", () => {
  const { identity } = mapped(staticMessage());
  assert.equal(identity?.mmsi, MMSI_TEXT);
  // Identity không mang mốc nguồn: message 5 không có timestamp nào.
  assert.equal(identity?.metadata.sourceReceivedAt, null);
  assert.equal(identity?.metadata.fetchedAt.toISOString(), RECEIVED_AT.toISOString());
});

// ---------------------------------------------------------------------------
//  §21 · MMSI hỏng
// ---------------------------------------------------------------------------

test("§21 MMSI không hợp lệ -> không sinh dữ liệu canonical nào", () => {
  rejectedWith(positionMessage({ mmsi: 12345 }), MarineAisRejectReason.INVALID_MMSI);
  rejectedWith(positionMessage({ mmsi: 0 }), MarineAisRejectReason.INVALID_MMSI);
  rejectedWith(staticMessage({ mmsi: 12345 }), MarineAisRejectReason.INVALID_MMSI);
  // MMSI bắt đầu bằng 0 là coast station/group call, không phải con tàu — dạng
  // số nó chỉ còn 8 chữ số nên validator P1 loại luôn.
  rejectedWith(positionMessage({ mmsi: 2190047 }), MarineAisRejectReason.INVALID_MMSI);
});

// ---------------------------------------------------------------------------
//  §22 · IMO = 0
// ---------------------------------------------------------------------------

test("§22 imo = 0 là sentinel -> IMO absent, KHÔNG phải 0 hay \"0\"", () => {
  const { identity } = mapped(staticMessage({ imo: 0 }));
  assert.equal(identity?.imo, null);
});

test("IMO sai checksum bị loại, không thành khoá rác", () => {
  // 9074728 chỉ khác chữ số kiểm tra so với 9074729.
  assert.equal(mapped(staticMessage({ imo: 9074728 })).identity?.imo, null);
});

test("ShipStaticData chỉ còn MMSI (imo/name/type đều sentinel) -> không phát nhóm rỗng", () => {
  rejectedWith(
    staticMessage({ imo: 0, name: "@@@@@@@", type: 0 }),
    MarineAisRejectReason.EMPTY_IDENTITY
  );
});

test("type = 0 là 'không có' nhưng name còn -> vẫn ra identity", () => {
  const { identity } = mapped(staticMessage({ imo: 0, type: 0 }));
  assert.equal(identity?.vesselTypeCode, null);
  assert.equal(identity?.name, "AGIA DOXA");
});

// ---------------------------------------------------------------------------
//  §23 · Toạ độ hỏng
// ---------------------------------------------------------------------------

test("§23 lat > 90 hoặc lng > 180 -> từ chối", () => {
  rejectedWith(positionMessage({ latlng: [91, 10] }), MarineAisRejectReason.INVALID_COORDINATES);
  rejectedWith(positionMessage({ latlng: [10, 181] }), MarineAisRejectReason.INVALID_COORDINATES);
  // 91.0 / 181.0 chính là sentinel "không có vị trí" của đặc tả AIS.
  rejectedWith(positionMessage({ latlng: [91, 181] }), MarineAisRejectReason.INVALID_COORDINATES);
});

// ---------------------------------------------------------------------------
//  §24 · Speed / course dùng lại validator canonical
// ---------------------------------------------------------------------------

test("§24 sentinel sog=102.3 / cog=360 bị validator P1 loại, vị trí vẫn giữ", () => {
  const { position } = mapped(positionMessage({ sog: 102.3, cog: 360 }));
  assert.equal(position?.speed, null);
  assert.equal(position?.course, null);
  // Toạ độ là lõi — mất chuyển động không làm mất báo cáo vị trí.
  assert.equal(position?.lat, 33.749667);
});

test("navigationalStatus 15 = 'undefined' -> navStatus absent", () => {
  assert.equal(mapped(positionMessage({ navigationalStatus: 15 })).position?.navStatus, null);
  // 9..13 là 'reserved': giữ mã thật, không bịa nhãn.
  assert.deepEqual(mapped(positionMessage({ navigationalStatus: 9 })).position?.navStatus, {
    code: 9,
    text: null,
  });
  assert.deepEqual(mapped(positionMessage({ navigationalStatus: 0 })).position?.navStatus, {
    code: 0,
    text: "Under way using engine",
  });
});

// ---------------------------------------------------------------------------
//  §25 · KHÔNG suy heading từ course
// ---------------------------------------------------------------------------

test("§25 cog = 123 -> course = 123, heading VẪN absent", () => {
  const { position } = mapped(positionMessage({ cog: 123 }));
  assert.equal(position?.course, 123);
  assert.equal(position?.heading, null);
});

// ---------------------------------------------------------------------------
//  §26 · Mốc thời gian
// ---------------------------------------------------------------------------

test("§26 sourceReceivedAt = mốc AIS (12:09), fetchedAt = mốc bot (12:10)", () => {
  const { position } = mapped(positionMessage());

  assert.equal(position?.receivedAt.toISOString(), AIS_INSTANT.toISOString());
  assert.equal(position?.metadata.sourceReceivedAt?.toISOString(), AIS_INSTANT.toISOString());
  assert.equal(position?.metadata.fetchedAt.toISOString(), RECEIVED_AT.toISOString());
  assert.notEqual(
    position?.metadata.sourceReceivedAt?.getTime(),
    position?.metadata.fetchedAt.getTime()
  );
});

test("parseAisSourceInstant nhận các dạng chuỗi production có thể phát", () => {
  const now = new Date("2026-08-16T13:00:00.000Z");
  const expected = new Date("2026-08-16T12:09:42.000Z").getTime();

  assert.equal(parseAisSourceInstant("2026-08-16 12:09:42 +0000 UTC", now)?.getTime(), expected);
  assert.equal(parseAisSourceInstant("2026-08-16T12:09:42Z", now)?.getTime(), expected);
  assert.equal(parseAisSourceInstant("2026-08-16 12:09:42", now)?.getTime(), expected);
  // Có offset thì phải quy về UTC, không bỏ qua.
  assert.equal(parseAisSourceInstant("2026-08-16T19:09:42+07:00", now)?.getTime(), expected);
  assert.equal(parseAisSourceInstant("2026-08-16T19:09:42+0700", now)?.getTime(), expected);
});

test("timestamp dạng SỐ bị từ chối — không đoán giây hay mili-giây", () => {
  rejectedWith(
    positionMessage({ timestamp: 1786968582 }),
    MarineAisRejectReason.INVALID_SOURCE_TIMESTAMP
  );
  rejectedWith(
    positionMessage({ timestamp: 1786968582123 }),
    MarineAisRejectReason.INVALID_SOURCE_TIMESTAMP
  );
});

test("timestamp hỏng -> KHÔNG phát vị trí, và KHÔNG thay bằng giờ bot", () => {
  rejectedWith(
    positionMessage({ timestamp: "not-a-timestamp" }),
    MarineAisRejectReason.INVALID_SOURCE_TIMESTAMP
  );
  // Mốc ở TƯƠNG LAI quá xa lệch đồng hồ cho phép -> từ chối, nếu không nó sẽ
  // LIVE vĩnh viễn và thắng mọi nguồn khác trong resolver.
  rejectedWith(
    positionMessage({ timestamp: "2026-08-16 13:00:00 +0000 UTC" }),
    MarineAisRejectReason.INVALID_SOURCE_TIMESTAMP
  );
});

test("lệch đồng hồ nhỏ (dưới 5 phút) vẫn được nhận", () => {
  const { position } = mapped(positionMessage({ timestamp: "2026-08-16 12:12:00 +0000 UTC" }));
  assert.equal(position?.receivedAt.toISOString(), "2026-08-16T12:12:00.000Z");
});

// ---------------------------------------------------------------------------
//  Hàm THUẦN + type guard
// ---------------------------------------------------------------------------

test("mapper THUẦN: cùng đầu vào -> cùng đầu ra, không sửa message gốc", () => {
  const message = positionMessage();
  const snapshot = JSON.parse(JSON.stringify(message));

  const first = mapped(message);
  const second = mapped(message);

  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(message)), snapshot);
});

test("type lạ -> UNKNOWN_MESSAGE_TYPE, không ném lỗi", () => {
  const unknown = { type: "StaticDataReport", data: { mmsi: MMSI } } as unknown as MarineAisMessage;
  const result = mapMarineAisMessage(unknown, RECEIVED_AT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, MarineAisRejectReason.UNKNOWN_MESSAGE_TYPE);
});

test("isMarineAisMessage chỉ kiểm HÌNH DẠNG, không kiểm ý nghĩa", () => {
  assert.equal(isMarineAisMessage(positionMessage()), true);
  assert.equal(isMarineAisMessage(staticMessage()), true);
  // Giá trị vô nghĩa nhưng đúng cấu trúc -> vẫn true; mapper mới là nơi loại.
  assert.equal(isMarineAisMessage(positionMessage({ mmsi: 0, latlng: [91, 181] })), true);

  assert.equal(isMarineAisMessage(null), false);
  assert.equal(isMarineAisMessage({ type: "PositionReport" }), false);
  assert.equal(isMarineAisMessage({ type: "Nope", data: {} }), false);
  assert.equal(
    isMarineAisMessage({ type: "PositionReport", data: { ...positionMessage().data, latlng: [1] } }),
    false
  );
  assert.equal(isMarineAisMessage({ type: "ShipStaticData", data: { mmsi: MMSI } }), false);
});

test("hàm dựng nhóm dùng được độc lập với điểm vào", () => {
  const metadata = buildMarineAisMetadata(RECEIVED_AT, AIS_INSTANT);
  assert.equal(metadata.source, VesselSource.AISSTREAM);
  assert.equal(metadata.confidence, null);

  const position = toVesselPositionReport(positionMessage().data as MarineAisPositionData, metadata);
  assert.equal(position?.receivedAt.toISOString(), AIS_INSTANT.toISOString());

  // Metadata không có mốc nguồn -> không dựng được báo cáo vị trí.
  const noInstant = buildMarineAisMetadata(RECEIVED_AT, null);
  assert.equal(
    toVesselPositionReport(positionMessage().data as MarineAisPositionData, noInstant),
    null
  );
  // Identity thì không cần mốc nguồn.
  assert.notEqual(
    toVesselIdentity(staticMessage().data as MarineAisStaticData, noInstant),
    null
  );
});

test("parserVersion là hằng, phase sau bump khi contract Marine đổi", () => {
  assert.equal(MARINE_AIS_PARSER_VERSION, "marine-ais-v1");
});
