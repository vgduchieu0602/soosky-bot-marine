// ============================================================================
//  TEST · ShipInfoMapper — RAW -> canonical. Toàn bộ chạy trên fixture.
// ----------------------------------------------------------------------------
//  Hai luật bị khoá chặt nhất ở đây:
//    • length/beam KHÔNG BAO GIỜ được map (nguồn đảo không nhất quán)
//    • không suy được mốc thời gian thật -> KHÔNG phát ra vị trí
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { parseShipInfoHtml } from "./ShipInfoParser";
import { ShipInfoParsedDocument } from "./ShipInfoTypes";
import {
  buildShipInfoMetadata,
  cleanText,
  parseFiniteNumber,
  parseNaiveTimestampMs,
  resolveSourceOffsetMs,
  selectLatestUsablePoint,
  toVesselIdentity,
  toVesselParticulars,
  toVesselPositionReport,
} from "./ShipInfoMapper";
import {
  FIXTURE_ABSURD_OFFSET,
  FIXTURE_ALL_POINTS_INVALID,
  FIXTURE_EMPTY_UPDATED_UTC,
  FIXTURE_IMO_ONLY_AND_BAD_NUMBERS,
  FIXTURE_LAST_POINT_INVALID,
  FIXTURE_MISSING_OPTIONAL_FIELDS,
  FIXTURE_NORMAL_VESSEL,
  FIXTURE_POINTS_WITHOUT_SEO_ANCHOR,
  FIXTURE_SENTINEL_VALUES,
  FIXTURE_SWAPPED_DIMENSIONS,
} from "./shipInfoFixtures";

const FETCHED_AT = new Date("2026-08-14T08:00:00.000Z");
const METADATA = buildShipInfoMetadata(FETCHED_AT, null);

function documentOf(html: string): ShipInfoParsedDocument {
  const result = parseShipInfoHtml(html);
  assert.equal(result.status, "OK");
  if (result.status !== "OK") throw new Error("unreachable");
  return result.document;
}

// ---- Helper thuần ---------------------------------------------------------

test("cleanText: trim, gộp khoảng trắng, rỗng -> null", () => {
  assert.equal(cleanText("Bulk Carrier\n"), "Bulk Carrier");
  assert.equal(cleanText("  Odd  Spacing  "), "Odd Spacing");
  assert.equal(cleanText(""), null);
  assert.equal(cleanText("   "), null);
  assert.equal(cleanText(null), null);
  assert.equal(cleanText(undefined), null);
});

test("parseFiniteNumber: chuỗi rỗng KHÔNG được thành 0", () => {
  assert.equal(parseFiniteNumber("33.74968"), 33.74968);
  assert.equal(parseFiniteNumber("-118.20887"), -118.20887);
  assert.equal(parseFiniteNumber("0"), 0);
  // `Number("")` và `Number("  ")` đều là 0 — đây chính là cái bẫy.
  assert.equal(parseFiniteNumber(""), null);
  assert.equal(parseFiniteNumber("   "), null);
  assert.equal(parseFiniteNumber("abc"), null);
  assert.equal(parseFiniteNumber(null), null);
  assert.equal(parseFiniteNumber(Number.NaN), null);
  assert.equal(parseFiniteNumber(Number.POSITIVE_INFINITY), null);
});

test("parseNaiveTimestampMs: dựng bằng Date.UTC, không phụ thuộc múi giờ máy", () => {
  assert.equal(
    parseNaiveTimestampMs("2026-08-13 19:39:30"),
    Date.UTC(2026, 7, 13, 19, 39, 30)
  );
  assert.equal(parseNaiveTimestampMs("2026-08-13T19:39:30"), Date.UTC(2026, 7, 13, 19, 39, 30));
  assert.equal(parseNaiveTimestampMs(""), null);
  assert.equal(parseNaiveTimestampMs("hôm qua"), null);
  assert.equal(parseNaiveTimestampMs(null), null);
});

// ---- Identity -------------------------------------------------------------

test("identity map đủ field có bằng chứng", () => {
  const identity = toVesselIdentity(documentOf(FIXTURE_NORMAL_VESSEL), METADATA);
  assert.ok(identity);

  assert.equal(identity.mmsi, "636018086");
  assert.equal(identity.imo, "9467976");
  assert.equal(identity.name, "Agia Doxa");
  assert.equal(identity.callsign, "D5OC7");
  assert.equal(identity.flag?.code, "LR");
  assert.equal(identity.flag?.name, "Liberia");
  assert.equal(identity.metadata.source, VesselSource.SHIPINFO);
});

test('vesselType được trim: "Bulk Carrier\\n" -> "Bulk Carrier"', () => {
  const identity = toVesselIdentity(documentOf(FIXTURE_NORMAL_VESSEL), METADATA);
  assert.equal(identity?.vesselType, "Bulk Carrier");
  assert.equal(identity?.vesselType?.includes("\n"), false);
  // ShipInfo chỉ có nhãn chữ, không có mã AIS.
  assert.equal(identity?.vesselTypeCode, null);
});

test("field text rỗng/trắng -> null, không lọt chuỗi rác vào canonical", () => {
  const identity = toVesselIdentity(documentOf(FIXTURE_IMO_ONLY_AND_BAD_NUMBERS), METADATA);
  assert.equal(identity?.callsign, null); // "   "
  assert.equal(identity?.name, "Odd Spacing");
  assert.equal(identity?.vesselType, "Bulk Carrier");
  assert.equal(identity?.flag, null); // flag "" + country null
});

test("chỉ có IMO -> dùng IMO làm khoá (BR-01), không mất tàu", () => {
  const identity = toVesselIdentity(documentOf(FIXTURE_IMO_ONLY_AND_BAD_NUMBERS), METADATA);
  assert.equal(identity?.mmsi, "9467976");
  assert.equal(identity?.imo, "9467976");
});

test("thiếu field tuỳ chọn không làm mapper crash", () => {
  const identity = toVesselIdentity(documentOf(FIXTURE_MISSING_OPTIONAL_FIELDS), METADATA);
  assert.ok(identity);
  assert.equal(identity.callsign, null);
  assert.equal(identity.flag, null);
});

// ---- Particulars ----------------------------------------------------------

test("particulars chỉ map builtYear + deadweight", () => {
  const particulars = toVesselParticulars(
    documentOf(FIXTURE_NORMAL_VESSEL),
    METADATA,
    FETCHED_AT
  );
  assert.ok(particulars);
  assert.equal(particulars.builtYear, 2010);
  assert.equal(particulars.deadweight, 33261);
  assert.equal(particulars.grossTonnage, null);
  assert.equal(particulars.draught, null);
});

test("⛔ length/beam KHÔNG BAO GIỜ được map — kể cả khi nguồn có vẻ ĐÚNG", () => {
  // Agia Doxa: length=179 width=29 (đúng thực tế)
  const good = toVesselParticulars(documentOf(FIXTURE_NORMAL_VESSEL), METADATA, FETCHED_AT);
  assert.equal(good?.length, null);
  assert.equal(good?.beam, null);
});

test("⛔ length/beam KHÔNG được map khi nguồn ĐẢO — và KHÔNG tự hoán đổi", () => {
  // Qi Xian Ling: length=29 width=180 (đảo). Nếu có heuristic "số lớn hơn là
  // chiều dài" thì test này sẽ thấy beam=29/length=180 — phải là null cả hai.
  const document = documentOf(FIXTURE_SWAPPED_DIMENSIONS);
  assert.equal(document.vessel.length, "29", "raw vẫn giữ nguyên");
  assert.equal(document.vessel.width, "180", "raw vẫn giữ nguyên");

  const particulars = toVesselParticulars(document, METADATA, FETCHED_AT);
  // Tàu này không có year/dwt -> không phát ra nhóm particulars nào cả.
  assert.equal(particulars, null);
});

test("builtYear/deadweight vô lý -> missing, KHÔNG bịa 0", () => {
  // year="0", dwt="abc"
  const particulars = toVesselParticulars(
    documentOf(FIXTURE_IMO_ONLY_AND_BAD_NUMBERS),
    METADATA,
    FETCHED_AT
  );
  assert.equal(particulars, null, "không field nào hợp lệ -> không phát nhóm rỗng");
});

test("không có field particulars nào -> null, không phát nhóm toàn null", () => {
  assert.equal(
    toVesselParticulars(documentOf(FIXTURE_MISSING_OPTIONAL_FIELDS), METADATA, FETCHED_AT),
    null
  );
});

// ---- Chọn điểm ------------------------------------------------------------

test("chọn điểm dùng được MỚI NHẤT", () => {
  const document = documentOf(FIXTURE_NORMAL_VESSEL);
  const point = selectLatestUsablePoint(document.vessel.points ?? []);
  assert.equal(point?.updated, "2026-08-13 19:39:30");
  assert.equal(point?.lat, "33.74968");
});

test("điểm cuối hỏng toạ độ -> lùi về điểm hợp lệ gần nhất", () => {
  const document = documentOf(FIXTURE_LAST_POINT_INVALID);
  const point = selectLatestUsablePoint(document.vessel.points ?? []);
  assert.equal(point?.updated, "2026-08-13 19:32:11");
  assert.equal(point?.lat, "33.75001");
});

test("mảng rỗng / mọi điểm hỏng -> null", () => {
  assert.equal(selectLatestUsablePoint([]), null);
  const allBad = documentOf(FIXTURE_ALL_POINTS_INVALID);
  assert.equal(selectLatestUsablePoint(allBad.vessel.points ?? []), null);
});

// ---- Mốc thời gian --------------------------------------------------------

test("offset múi giờ được SUY RA, không hardcode", () => {
  // Fixture dựng theo dữ liệu thật: updated 19:39:30 vs updated_utc 17:39:30.
  assert.equal(resolveSourceOffsetMs(documentOf(FIXTURE_NORMAL_VESSEL)), 2 * 60 * 60 * 1000);
});

test("không có mỏ neo UTC -> không suy được offset", () => {
  assert.equal(resolveSourceOffsetMs(documentOf(FIXTURE_POINTS_WITHOUT_SEO_ANCHOR)), null);
  assert.equal(resolveSourceOffsetMs(documentOf(FIXTURE_EMPTY_UPDATED_UTC)), null);
});

test("lệch vô lý (3 ngày) bị từ chối — đó không phải múi giờ", () => {
  assert.equal(resolveSourceOffsetMs(documentOf(FIXTURE_ABSURD_OFFSET)), null);
});

test("receivedAt là mốc NGUỒN đã đổi về UTC, KHÔNG phải giờ fetch", () => {
  const position = toVesselPositionReport(documentOf(FIXTURE_NORMAL_VESSEL), METADATA);
  assert.ok(position);

  // 19:39:30 (UTC+2) -> 17:39:30Z, đúng bằng updated_utc của nguồn.
  assert.equal(position.receivedAt.toISOString(), "2026-08-13T17:39:30.000Z");
  assert.notEqual(position.receivedAt.getTime(), FETCHED_AT.getTime());
  // Vị trí cũ ~14 giờ so với lúc fetch — và phải TRÔNG đúng như vậy.
  assert.ok(FETCHED_AT.getTime() - position.receivedAt.getTime() > 13 * 60 * 60 * 1000);
});

test("không suy được mốc thời gian -> KHÔNG phát ra vị trí", () => {
  // Thà thiếu vị trí còn hơn gắn mốc lệch 1-2 giờ hoặc mượn giờ fetch.
  assert.equal(toVesselPositionReport(documentOf(FIXTURE_POINTS_WITHOUT_SEO_ANCHOR), METADATA), null);
  assert.equal(toVesselPositionReport(documentOf(FIXTURE_EMPTY_UPDATED_UTC), METADATA), null);
  assert.equal(toVesselPositionReport(documentOf(FIXTURE_ABSURD_OFFSET), METADATA), null);
});

// ---- Position -------------------------------------------------------------

test("toạ độ được ép số và qua validator P1", () => {
  const position = toVesselPositionReport(documentOf(FIXTURE_NORMAL_VESSEL), METADATA);
  assert.equal(position?.lat, 33.74968);
  assert.equal(position?.lng, -118.20887);
  assert.equal(typeof position?.lat, "number");
  // mp2 của VesselFinder làm tròn, ShipInfo thì không.
  assert.equal(position?.latLngApproximate, false);
});

test("toạ độ hỏng -> không có vị trí, KHÔNG bịa (0,0)", () => {
  assert.equal(toVesselPositionReport(documentOf(FIXTURE_ALL_POINTS_INVALID), METADATA), null);
  assert.equal(toVesselPositionReport(documentOf(FIXTURE_MISSING_OPTIONAL_FIELDS), METADATA), null);
});

test('course "-1" KHÔNG lọt vào canonical', () => {
  const document = documentOf(FIXTURE_SENTINEL_VALUES);
  assert.equal((document.vessel.points ?? [])[0]?.course, "-1", "raw vẫn giữ -1");

  const position = toVesselPositionReport(document, METADATA);
  assert.ok(position);
  assert.equal(position.course, null);
  assert.notEqual(position.course, -1);
  // Speed ở cùng điểm đó vẫn map bình thường.
  assert.equal(position.speed, 10.6);
});

test("course hợp lệ -> số", () => {
  const position = toVesselPositionReport(documentOf(FIXTURE_NORMAL_VESSEL), METADATA);
  assert.equal(position?.course, 58);
});

test("heading KHÔNG được bịa từ course", () => {
  const position = toVesselPositionReport(documentOf(FIXTURE_NORMAL_VESSEL), METADATA);
  assert.equal(position?.heading, null);
  assert.notEqual(position?.heading, position?.course);
});

test("navStatus KHÔNG được suy từ speed=0", () => {
  const position = toVesselPositionReport(documentOf(FIXTURE_NORMAL_VESSEL), METADATA);
  assert.equal(position?.speed, 0, "tàu đang đứng yên");
  assert.equal(position?.navStatus, null, "nhưng không được kết luận là neo đậu");
});

// ---- Metadata -------------------------------------------------------------

test("metadata: fetchedAt tách khỏi sourceReceivedAt", () => {
  const sourceInstant = new Date("2026-08-13T17:39:30.000Z");
  const metadata = buildShipInfoMetadata(FETCHED_AT, sourceInstant);

  assert.equal(metadata.source, VesselSource.SHIPINFO);
  assert.equal(metadata.fetchedAt.getTime(), FETCHED_AT.getTime());
  assert.equal(metadata.sourceReceivedAt?.getTime(), sourceInstant.getTime());
  assert.notEqual(metadata.fetchedAt.getTime(), metadata.sourceReceivedAt?.getTime());
});

test("không có mốc nguồn -> sourceReceivedAt null, KHÔNG mượn fetchedAt", () => {
  const metadata = buildShipInfoMetadata(FETCHED_AT, null);
  assert.equal(metadata.sourceReceivedAt, null);
});
