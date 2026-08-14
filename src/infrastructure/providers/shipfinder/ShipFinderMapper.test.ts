// ============================================================================
//  TEST · ShipFinderMapper — RAW -> canonical. Chạy trên fixture P7.2.
// ----------------------------------------------------------------------------
//  Ba luật bị khoá chặt nhất:
//    • DDM phải đổi ĐÚNG sang decimal degrees
//    • không khai múi giờ -> KHÔNG phát ra vị trí (không mượn fetchedAt)
//    • ETA thiếu năm -> KHÔNG bịa năm
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselSource } from "../../../domain/value-objects/VesselSource";
import { parseShipFinderHtml } from "./ShipFinderParser";
import { ShipFinderRawVessel } from "./ShipFinderTypes";
import {
  buildShipFinderMetadata,
  cleanText,
  parseDdmCoordinate,
  parseMeasurement,
  parseNaiveTimestampMs,
  resolveSourceInstant,
  toVesselIdentity,
  toVesselParticulars,
  toVesselPositionReport,
  toVesselVoyage,
} from "./ShipFinderMapper";
import {
  FIXTURE_DIMENSIONS_CORRECT,
  FIXTURE_FULL_VESSEL,
  FIXTURE_MISSING_OPTIONAL_FIELDS,
  FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING,
} from "./shipFinderFixtures";

/** Fixture giờ nguồn 2026-08-14 23:51:36; +8h -> 15:51:36Z. */
const FETCHED_AT = new Date("2026-08-14T16:00:00.000Z");
const OFFSET_UTC_PLUS_8 = 480;
const METADATA = buildShipFinderMetadata(FETCHED_AT, null);
/** Cho phép đổi múi giờ (người vận hành đã khai tường minh). */
const WITH_OFFSET = { sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8, now: FETCHED_AT };
/** Mặc định bảo thủ: không khai offset. */
const NO_OFFSET = { now: FETCHED_AT };

function rawOf(html: string): ShipFinderRawVessel {
  const result = parseShipFinderHtml(html);
  assert.equal(result.status, "OK");
  if (result.status !== "OK") throw new Error("unreachable");
  return result.document.vessel;
}

// ---- Helper thuần ---------------------------------------------------------

test("cleanText: gộp khoảng trắng, loại sentinel", () => {
  assert.equal(cleanText("LONG BEACH,  US"), "LONG BEACH, US");
  assert.equal(cleanText("  Moored  "), "Moored");
  assert.equal(cleanText("-"), null);
  assert.equal(cleanText("Unknown"), null);
  assert.equal(cleanText("unknown"), null);
  assert.equal(cleanText(""), null);
  assert.equal(cleanText(null), null);
});

test("parseMeasurement: bóc đơn vị, từ chối chuỗi thừa", () => {
  assert.equal(parseMeasurement("179 m", "m"), 179);
  assert.equal(parseMeasurement("10.6 kn", "kn"), 10.6);
  assert.equal(parseMeasurement("0.9 °", "°"), 0.9);
  assert.equal(parseMeasurement("0 kn", "kn"), 0);
  // Đơn vị là tuỳ chọn — nguồn bỏ đơn vị vẫn đọc được.
  assert.equal(parseMeasurement("179", "m"), 179);
  // Nhưng chuỗi thừa thì từ chối, không nuốt lấy con số.
  assert.equal(parseMeasurement("about 10 kn", "kn"), null);
  assert.equal(parseMeasurement("-", "m"), null);
  assert.equal(parseMeasurement("Unknown", "°"), null);
  assert.equal(parseMeasurement("", "m"), null);
});

// ---- DDM ------------------------------------------------------------------

test("DDM -> decimal degrees, đúng công thức độ + phút/60", () => {
  // 33 + 44.980/60 = 33.749666...
  const lat = parseDdmCoordinate("33-44.980 N");
  assert.ok(lat !== null);
  assert.ok(Math.abs(lat - 33.7496667) < 1e-6, `nhận ${lat}`);

  // -(118 + 12.537/60) = -118.20895
  const lon = parseDdmCoordinate("118-12.537 W");
  assert.ok(lon !== null);
  assert.ok(Math.abs(lon - -118.20895) < 1e-6, `nhận ${lon}`);
});

test("DDM: cả 4 bán cầu, S/W âm", () => {
  assert.ok(Math.abs((parseDdmCoordinate("1-30.000 N") as number) - 1.5) < 1e-9);
  assert.ok(Math.abs((parseDdmCoordinate("1-30.000 S") as number) - -1.5) < 1e-9);
  assert.ok(Math.abs((parseDdmCoordinate("103-30.000 E") as number) - 103.5) < 1e-9);
  assert.ok(Math.abs((parseDdmCoordinate("103-30.000 W") as number) - -103.5) < 1e-9);
  // Chữ thường vẫn nhận.
  assert.ok(Math.abs((parseDdmCoordinate("1-30.000 s") as number) - -1.5) < 1e-9);
});

test("DDM không hợp lệ -> null", () => {
  assert.equal(parseDdmCoordinate("33-60.000 N"), null, "phút >= 60");
  assert.equal(parseDdmCoordinate("33-75.500 N"), null, "phút >= 60");
  assert.equal(parseDdmCoordinate("91-00.000 N"), null, "vĩ độ > 90");
  assert.equal(parseDdmCoordinate("181-00.000 E"), null, "kinh độ > 180");
  assert.equal(parseDdmCoordinate("90-30.000 N"), null, "vượt 90 sau khi cộng phút");
  assert.equal(parseDdmCoordinate("33.7496"), null, "decimal không phải DDM");
  assert.equal(parseDdmCoordinate("33-44.980"), null, "thiếu bán cầu");
  assert.equal(parseDdmCoordinate("33-44.980 X"), null, "bán cầu lạ");
  assert.equal(parseDdmCoordinate("-"), null);
  assert.equal(parseDdmCoordinate(null), null);
});

// ---- Identity -------------------------------------------------------------

test("identity map đủ field có bằng chứng", () => {
  const identity = toVesselIdentity(rawOf(FIXTURE_FULL_VESSEL), METADATA);
  assert.ok(identity);

  assert.equal(identity.mmsi, "636018086");
  assert.equal(identity.imo, "9467976");
  assert.equal(identity.name, "AGIA DOXA");
  assert.equal(identity.callsign, "D5OC7");
  assert.equal(identity.vesselType, "Cargo ship");
  assert.equal(identity.metadata.source, VesselSource.SHIPFINDER);
  // Nguồn không có mã AIS số, không suy từ nhãn chữ.
  assert.equal(identity.vesselTypeCode, null);
});

test("flag giữ ISO3, KHÔNG tự đổi sang ISO2", () => {
  const identity = toVesselIdentity(rawOf(FIXTURE_FULL_VESSEL), METADATA);
  assert.equal(identity?.flag?.code, "LBR");
  assert.equal(identity?.flag?.code?.length, 3);
  // ShipInfo dùng "LR"; quy đổi là việc của resolver, không thêm dependency ở đây.
  assert.notEqual(identity?.flag?.code, "LR");
  // Nguồn không cho tên nước.
  assert.equal(identity?.flag?.name, null);

  assert.equal(toVesselIdentity(rawOf(FIXTURE_DIMENSIONS_CORRECT), METADATA)?.flag?.code, "CHN");
});

test("sentinel trong identity -> null, không lọt chuỗi rác", () => {
  const identity = toVesselIdentity(rawOf(FIXTURE_MISSING_OPTIONAL_FIELDS), METADATA);
  assert.ok(identity);
  assert.equal(identity.imo, null, '"-" phải thành null');
  assert.equal(identity.callsign, null);
  assert.equal(identity.flag, null);
});

// ---- Particulars ----------------------------------------------------------

test("length/width -> length/beam, bóc đơn vị mét", () => {
  const particulars = toVesselParticulars(rawOf(FIXTURE_FULL_VESSEL), METADATA);
  assert.ok(particulars);
  assert.equal(particulars.length, 179);
  assert.equal(particulars.beam, 29);
  assert.equal(particulars.draught, 5.9);
});

test("KHÔNG hoán đổi length/beam theo heuristic nào", () => {
  // Con tàu mà ShipInfo bị đảo; ShipFinder cho đúng chiều -> map thẳng.
  const particulars = toVesselParticulars(rawOf(FIXTURE_DIMENSIONS_CORRECT), METADATA);
  assert.equal(particulars?.length, 180);
  assert.equal(particulars?.beam, 29);
});

test("KHÔNG map grossTonnage / deadweight / builtYear", () => {
  const particulars = toVesselParticulars(rawOf(FIXTURE_FULL_VESSEL), METADATA);
  assert.equal(particulars?.grossTonnage, null);
  assert.equal(particulars?.deadweight, null);
  assert.equal(particulars?.builtYear, null);
});

test("không field kích thước nào -> null, không phát nhóm rỗng", () => {
  const raw: ShipFinderRawVessel = { mmsi: "636018086", length: "-", width: "-", draught: "-" };
  assert.equal(toVesselParticulars(raw, METADATA), null);
});

// ---- Motion ---------------------------------------------------------------

test("speed / course bóc đúng số", () => {
  const position = toVesselPositionReport(
    rawOf(FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING),
    METADATA,
    WITH_OFFSET
  );
  assert.ok(position);
  assert.equal(position.speed, 10.6);
  assert.equal(position.course, 97.5);
});

test('heading "Unknown" -> missing; KHÔNG suy từ course', () => {
  const position = toVesselPositionReport(
    rawOf(FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING),
    METADATA,
    WITH_OFFSET
  );
  assert.equal(position?.heading, null);
  assert.equal(position?.course, 97.5);
  assert.notEqual(position?.heading, position?.course);
});

test('heading "58.0 °" -> 58 (validator P1 cần số nguyên)', () => {
  const position = toVesselPositionReport(rawOf(FIXTURE_FULL_VESSEL), METADATA, WITH_OFFSET);
  assert.equal(position?.heading, 58);
  assert.equal(Number.isInteger(position?.heading), true);
});

test("giá trị chuyển động ngoài ngưỡng AIS -> missing", () => {
  const raw: ShipFinderRawVessel = {
    mmsi: "636018086",
    lat: "1-30.000 N",
    lon: "103-30.000 E",
    lastUpdate: "2026-08-14 23:00:00",
    speed: "999 kn",
    course: "400 °",
    heading: "400 °",
  };
  const position = toVesselPositionReport(raw, METADATA, WITH_OFFSET);
  assert.ok(position);
  assert.equal(position.speed, null);
  assert.equal(position.course, null);
  assert.equal(position.heading, null);
});

// ---- Nav status -----------------------------------------------------------

test("navStatus giữ TEXT của nguồn, code để trống", () => {
  const moored = toVesselPositionReport(rawOf(FIXTURE_FULL_VESSEL), METADATA, WITH_OFFSET);
  assert.equal(moored?.navStatus?.text, "Moored");
  assert.equal(moored?.navStatus?.code, null, "không dựng bảng tra chữ -> mã AIS");

  const underway = toVesselPositionReport(
    rawOf(FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING),
    METADATA,
    WITH_OFFSET
  );
  assert.equal(underway?.navStatus?.text, "Under way using engine");
});

test("navStatus KHÔNG được suy từ speed", () => {
  const raw: ShipFinderRawVessel = {
    mmsi: "636018086",
    lat: "1-30.000 N",
    lon: "103-30.000 E",
    lastUpdate: "2026-08-14 23:00:00",
    speed: "0 kn",
    // Nguồn không nói trạng thái -> canonical phải để trống.
  };
  const position = toVesselPositionReport(raw, METADATA, WITH_OFFSET);
  assert.equal(position?.speed, 0, "tàu đứng yên");
  assert.equal(position?.navStatus, null, "nhưng KHÔNG được kết luận là neo đậu");
});

// ---- Toạ độ trong position ------------------------------------------------

test("toạ độ được đổi DDM và qua validator P1", () => {
  const position = toVesselPositionReport(rawOf(FIXTURE_FULL_VESSEL), METADATA, WITH_OFFSET);
  assert.ok(position);
  assert.ok(Math.abs(position.lat - 33.7497167) < 1e-4, `lat=${position.lat}`);
  assert.ok(Math.abs(position.lng - -118.20885) < 1e-4, `lng=${position.lng}`);
  assert.equal(typeof position.lat, "number");
  assert.equal(position.latLngApproximate, false);
});

test("toạ độ hỏng -> KHÔNG có vị trí, không bịa (0,0)", () => {
  for (const bad of [
    { lat: "33-60.000 N", lon: "118-12.537 W" },
    { lat: "91-00.000 N", lon: "118-12.537 W" },
    { lat: "-", lon: "-" },
    { lat: "33.7496", lon: "-118.2089" },
  ]) {
    const raw: ShipFinderRawVessel = {
      mmsi: "636018086",
      lastUpdate: "2026-08-14 23:00:00",
      ...bad,
    };
    assert.equal(toVesselPositionReport(raw, METADATA, WITH_OFFSET), null, JSON.stringify(bad));
  }
});

// ---- Mốc thời gian (BẮT BUỘC) ---------------------------------------------

test("parseNaiveTimestampMs dựng bằng Date.UTC, không theo múi giờ máy", () => {
  assert.equal(
    parseNaiveTimestampMs("2026-08-14 23:45:34"),
    Date.UTC(2026, 7, 14, 23, 45, 34)
  );
  assert.equal(parseNaiveTimestampMs("-"), null);
  assert.equal(parseNaiveTimestampMs("hôm qua"), null);
  assert.equal(parseNaiveTimestampMs(null), null);
});

test("KHÔNG khai offset -> mốc nguồn KHÔNG xác định, và KHÔNG mượn fetchedAt", () => {
  const raw = rawOf(FIXTURE_FULL_VESSEL);
  assert.equal(resolveSourceInstant(raw, NO_OFFSET), null);

  // Hệ quả: không phát ra vị trí. Thà thiếu còn hơn gắn mốc bịa.
  assert.equal(toVesselPositionReport(raw, METADATA, NO_OFFSET), null);

  // Và metadata cũng không được mượn fetchedAt làm mốc nguồn.
  const metadata = buildShipFinderMetadata(FETCHED_AT, null);
  assert.equal(metadata.sourceReceivedAt, null);
  assert.notEqual(metadata.sourceReceivedAt, metadata.fetchedAt);
});

test("khai offset tường minh -> quy đổi đúng theo offset ĐÓ, không hardcode", () => {
  const raw = rawOf(FIXTURE_FULL_VESSEL); // Last update 2026-08-14 23:51:36

  // +8h (giả định P7.1, do người vận hành khai)
  assert.equal(
    resolveSourceInstant(raw, WITH_OFFSET)?.toISOString(),
    "2026-08-14T15:51:36.000Z"
  );
  // Offset khác -> kết quả khác. Mapper không ghim con số nào.
  assert.equal(
    resolveSourceInstant(raw, { sourceUtcOffsetMinutes: 600, now: FETCHED_AT })?.toISOString(),
    "2026-08-14T13:51:36.000Z"
  );
  // Offset nhỏ hơn thực tế -> mốc rơi vào tương lai -> lưới an toàn chặn.
  // (UTC+7 cho 16:51:36Z, muộn hơn `now` = 16:00:00Z quá mức lệch cho phép.)
  assert.equal(
    resolveSourceInstant(raw, { sourceUtcOffsetMinutes: 420, now: FETCHED_AT }),
    null
  );
  assert.equal(
    resolveSourceInstant(raw, { sourceUtcOffsetMinutes: 0, now: FETCHED_AT }),
    null,
    "offset 0 đẩy mốc vào tương lai -> bị từ chối"
  );
});

test("mốc rơi vào TƯƠNG LAI bị từ chối — lưới an toàn khi offset khai sai", () => {
  const raw: ShipFinderRawVessel = { mmsi: "636018086", lastUpdate: "2026-08-14 23:51:36" };
  // now sớm hơn nhiều so với mốc quy đổi.
  assert.equal(
    resolveSourceInstant(raw, {
      sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
      now: new Date("2026-08-14T10:00:00.000Z"),
    }),
    null
  );
});

test("receivedAt là mốc NGUỒN, khác hẳn fetchedAt", () => {
  const position = toVesselPositionReport(rawOf(FIXTURE_FULL_VESSEL), METADATA, WITH_OFFSET);
  assert.ok(position);
  assert.equal(position.receivedAt.toISOString(), "2026-08-14T15:51:36.000Z");
  assert.notEqual(position.receivedAt.getTime(), FETCHED_AT.getTime());
  // Vị trí tươi ~8 phút — đúng bản chất ShipFinder, khác hẳn ShipInfo trễ 14h.
  const ageMinutes = (FETCHED_AT.getTime() - position.receivedAt.getTime()) / 60000;
  assert.ok(ageMinutes > 0 && ageMinutes < 30, `tuổi=${ageMinutes} phút`);
});

// ---- Voyage ---------------------------------------------------------------

test("destination được dọn khoảng trắng, KHÔNG geocode", () => {
  const voyage = toVesselVoyage(rawOf(FIXTURE_FULL_VESSEL), METADATA);
  assert.ok(voyage);
  assert.equal(voyage.destination, "LONG BEACH, US");
  assert.equal(voyage.mmsi, "636018086");
});

test("ETA thiếu năm -> KHÔNG map, KHÔNG bịa năm 2026", () => {
  const raw = rawOf(FIXTURE_FULL_VESSEL);
  assert.equal(raw.eta, "07-29 07:01", "raw vẫn giữ nguyên");

  const voyage = toVesselVoyage(raw, METADATA);
  // Canonical eta là Date; map buộc phải bịa năm -> thà bỏ.
  assert.equal(voyage?.eta, null);
});

test("cảng (currentPort/nextPort/lastPort) không map — cần đăng nhập/premium", () => {
  const voyage = toVesselVoyage(rawOf(FIXTURE_FULL_VESSEL), METADATA);
  assert.equal(voyage?.currentPort, null);
  assert.equal(voyage?.nextPort, null);
  assert.equal(voyage?.lastPort, null);
  assert.equal(voyage?.lastPortDepartureAt, null);
});

test("không có destination -> không phát nhóm voyage", () => {
  const raw: ShipFinderRawVessel = { mmsi: "636018086", destination: "-", eta: "07-29 07:01" };
  assert.equal(toVesselVoyage(raw, METADATA), null);
});

// ---- Metadata -------------------------------------------------------------

test("metadata: source SHIPFINDER, fetchedAt tách khỏi sourceReceivedAt", () => {
  const sourceInstant = new Date("2026-08-14T15:51:36.000Z");
  const metadata = buildShipFinderMetadata(FETCHED_AT, sourceInstant);

  assert.equal(metadata.source, VesselSource.SHIPFINDER);
  assert.equal(metadata.fetchedAt.getTime(), FETCHED_AT.getTime());
  assert.equal(metadata.sourceReceivedAt?.getTime(), sourceInstant.getTime());
  assert.notEqual(metadata.fetchedAt.getTime(), metadata.sourceReceivedAt?.getTime());
});
