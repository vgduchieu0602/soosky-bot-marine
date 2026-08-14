// ============================================================================
//  TEST · ShipInfoParser — giữ ĐÚNG những gì nguồn trả, không chuẩn hoá gì
// ----------------------------------------------------------------------------
//  Chạy hoàn toàn trên fixture. Không mạng, không DB.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ShipInfoNoDataReason,
  ShipInfoParseError,
  extractEmbeddedObject,
  parseSeoContext,
  parseShipInfoHtml,
} from "./ShipInfoParser";
import {
  FIXTURE_BRACE_IN_STRING,
  FIXTURE_EMPTY_VESSEL_STATE,
  FIXTURE_KEYED_BY_MMSI,
  FIXTURE_MALFORMED_JSON,
  FIXTURE_MALFORMED_SEO_CONTEXT,
  FIXTURE_MISSING_OPTIONAL_FIELDS,
  FIXTURE_NORMAL_VESSEL,
  FIXTURE_NO_VESSEL_STATE,
  FIXTURE_PHP_FATAL_ERROR,
  FIXTURE_SENTINEL_VALUES,
  FIXTURE_SWAPPED_DIMENSIONS,
} from "./shipInfoFixtures";

/** Rút gọn: lấy document, ném nếu không phải OK. */
function documentOf(html: string) {
  const result = parseShipInfoHtml(html);
  assert.equal(result.status, "OK", `mong OK, nhận ${JSON.stringify(result)}`);
  if (result.status !== "OK") throw new Error("unreachable");
  return result.document;
}

// ---- Extraction -----------------------------------------------------------

test("extract khối `var IMOs` thành công", () => {
  const doc = documentOf(FIXTURE_NORMAL_VESSEL);
  assert.equal(doc.vesselKey, "9467976");
  assert.equal(doc.vessel.name, "Agia Doxa");
  assert.deepEqual([...doc.otherVesselKeys], []);
});

test("extract `vesselSeoContext` khi có", () => {
  const doc = documentOf(FIXTURE_NORMAL_VESSEL);
  assert.equal(doc.seoContext?.name, "Agia Doxa");
  assert.equal(doc.seoContext?.updated_utc, "2026-08-13 17:39:30");
  assert.equal(doc.seoContext?.geo_label, "Near Long Beach");
});

test("`vesselSeoContext` vắng mặt -> undefined, không lỗi", () => {
  const doc = documentOf(FIXTURE_MISSING_OPTIONAL_FIELDS);
  assert.equal(doc.seoContext, undefined);
});

test("biến thể khoảng trắng không làm hỏng parser", () => {
  // Fixture này viết `var IMOs={...} ;` và `var   vesselSeoContext   =   {...}   ;`
  const doc = documentOf(FIXTURE_SENTINEL_VALUES);
  assert.equal(doc.vessel.name, "Queen Of The West");
  assert.equal(doc.seoContext?.updated_utc, "2026-08-13 17:57:25");

  // Không phụ thuộc ký tự xuống dòng sau dấu chấm phẩy.
  const oneLine = `<script>var IMOs = {"1":{"imo":"1","points":[]}};var x=1;</script>`;
  const inline = parseShipInfoHtml(oneLine);
  assert.equal(inline.status, "OK");
});

test("đếm cặp ngoặc bỏ qua ngoặc nằm trong chuỗi", () => {
  const doc = documentOf(FIXTURE_BRACE_IN_STRING);
  assert.equal(doc.vessel.name, "WEIRD } NAME {");
  assert.equal(doc.vessel.notes, 'a " quote and } brace');
});

test("extractEmbeddedObject trả null khi không có biến", () => {
  assert.equal(extractEmbeddedObject("<html></html>", /var\s+IMOs\s*=\s*/), null);
});

// ---- Vessel fields --------------------------------------------------------

test("field lý lịch giữ ĐÚNG biểu diễn của nguồn", () => {
  const { vessel } = documentOf(FIXTURE_NORMAL_VESSEL);

  assert.equal(vessel.imo, "9467976");
  assert.equal(vessel.mmsi, "636018086");
  assert.equal(vessel.name, "Agia Doxa");
  assert.equal(vessel.callsign, "D5OC7");
  assert.equal(vessel.flag, "LR");
  assert.equal(vessel.country, "Liberia");
  assert.equal(vessel.year, "2010");
  assert.equal(vessel.dwt, "33261");

  // "\n" ở cuối type là của nguồn -> KHÔNG trim ở tầng raw.
  assert.equal(vessel.type, "Bulk Carrier\n");
  // Số vẫn là CHUỖI.
  assert.equal(typeof vessel.year, "string");
  assert.equal(typeof vessel.dwt, "string");
});

test("khối fresh_access giữ nguyên (bằng chứng trễ 14 giờ)", () => {
  const { vessel } = documentOf(FIXTURE_NORMAL_VESSEL);
  assert.equal(vessel.fresh_access?.has_fresh_position, true);
  assert.equal(vessel.fresh_access?.fresh_locked, true);
  assert.equal(vessel.fresh_access?.position_delay_hours, 14);
  assert.equal(vessel.fresh_access?.fresh_position_time, "2026-08-14 09:42:31");
});

test("tra bằng MMSI: khoá của IMOs là MMSI, khác vessel.imo", () => {
  const doc = documentOf(FIXTURE_KEYED_BY_MMSI);
  assert.equal(doc.vesselKey, "414708000");
  assert.equal(doc.vessel.imo, "9656864");
  assert.notEqual(doc.vesselKey, doc.vessel.imo);
});

// ---- Position raw fields --------------------------------------------------

test("field vị trí giữ ĐÚNG biểu diễn của nguồn", () => {
  const { vessel } = documentOf(FIXTURE_NORMAL_VESSEL);
  const points = vessel.points ?? [];
  assert.equal(points.length, 2);

  const last = points[points.length - 1];
  assert.equal(last.lat, "33.74968");
  assert.equal(last.lng, "-118.20887");
  assert.equal(last.speed, "0");
  assert.equal(last.course, "58");
  assert.equal(last.heading, null);
  assert.equal(last.updated, "2026-08-13 19:39:30");
  assert.equal(last.inserted, "2026-08-13 19:39:55");
  assert.equal(last.provider, "free");

  // Toạ độ vẫn là chuỗi, chưa ép số.
  assert.equal(typeof last.lat, "string");
  assert.equal(typeof last.lng, "string");
});

test("field luôn null của nguồn được giữ nguyên null, không bị bịa giá trị", () => {
  const { vessel } = documentOf(FIXTURE_NORMAL_VESSEL);
  for (const point of vessel.points ?? []) {
    assert.equal(point.heading, null);
    assert.equal(point.draught, null);
    assert.equal(point.destination, null);
    assert.equal(point.eta, null);
  }
});

test("timestamp giữ nguyên chuỗi nguồn — parser KHÔNG đổi múi giờ", () => {
  const doc = documentOf(FIXTURE_NORMAL_VESSEL);
  const last = (doc.vessel.points ?? [])[1];

  // points[].updated là UTC+2, updated_utc là UTC (P6.1 §5). Raw layer giữ CẢ
  // HAI nguyên trạng để P6.3 tự suy offset; không được tự cộng trừ ở đây.
  assert.equal(last.updated, "2026-08-13 19:39:30");
  assert.equal(doc.seoContext?.updated_utc, "2026-08-13 17:39:30");
  assert.equal(typeof last.updated, "string");
});

// ---- Sentinel -------------------------------------------------------------

test('sentinel course "-1" VẪN là "-1" ở raw DTO', () => {
  const { vessel } = documentOf(FIXTURE_SENTINEL_VALUES);
  const point = (vessel.points ?? [])[0];

  assert.equal(point.course, "-1");
  assert.notEqual(point.course, null);
  assert.equal(typeof point.course, "string");
  // Chuyển "-1" -> null là việc của canonical mapper (P6.3).
  assert.equal(point.heading, null);
});

// ---- Missing optional fields ---------------------------------------------

test("không crash khi thiếu field tuỳ chọn / không có track point", () => {
  const { vessel } = documentOf(FIXTURE_MISSING_OPTIONAL_FIELDS);

  assert.equal(vessel.callsign, null);
  assert.equal(vessel.flag, null);
  assert.equal(vessel.country, null);
  assert.equal(vessel.year, null);
  assert.equal(vessel.dwt, null);
  assert.equal(vessel.length, null);
  assert.equal(vessel.width, null);
  assert.deepEqual(vessel.points, []);
  assert.equal(vessel.fresh_access?.has_fresh_position, false);
});

// ---- Length / width discrepancy ------------------------------------------

test("length/width ĐẢO được giữ NGUYÊN — parser không tự hoán đổi", () => {
  const doc = documentOf(FIXTURE_SWAPPED_DIMENSIONS);

  // Bulk carrier dài 29 m rộng 180 m là bất khả thi -> dữ liệu nguồn sai.
  // Raw DTO vẫn phải phản chiếu đúng cái sai đó.
  assert.equal(doc.vessel.length, "29");
  assert.equal(doc.vessel.width, "180");
  // seoContext lặp lại đúng giá trị sai -> sai từ database, không phải hiển thị.
  assert.equal(doc.seoContext?.length_m, "29");
  assert.equal(doc.seoContext?.width_m, "180");
});

test("cùng field đó ở tàu khác lại ĐÚNG — nên không thể hoán đổi máy móc", () => {
  const ok = documentOf(FIXTURE_NORMAL_VESSEL);
  assert.equal(ok.vessel.length, "179");
  assert.equal(ok.vessel.width, "29");

  const swapped = documentOf(FIXTURE_SWAPPED_DIMENSIONS);
  // Hai tàu, cùng loại Bulk Carrier, hai cách hiểu ngược nhau cho cùng tên field.
  assert.ok(Number(ok.vessel.length) > Number(ok.vessel.width));
  assert.ok(Number(swapped.vessel.length) < Number(swapped.vessel.width));
});

// ---- Not found ------------------------------------------------------------

test("PHP fatal error (HTTP 200) -> NO_VESSEL_DATA, không tạo tàu ma", () => {
  const result = parseShipInfoHtml(FIXTURE_PHP_FATAL_ERROR);
  assert.equal(result.status, "NO_VESSEL_DATA");
  if (result.status !== "NO_VESSEL_DATA") throw new Error("unreachable");
  assert.equal(result.reason, ShipInfoNoDataReason.PHP_FATAL_ERROR);
});

test("trang không có state tàu -> NO_VESSEL_DATA", () => {
  const result = parseShipInfoHtml(FIXTURE_NO_VESSEL_STATE);
  assert.equal(result.status, "NO_VESSEL_DATA");
  if (result.status !== "NO_VESSEL_DATA") throw new Error("unreachable");
  assert.equal(result.reason, ShipInfoNoDataReason.MISSING_VESSEL_STATE);
});

test("`var IMOs` rỗng -> NO_VESSEL_DATA, phân biệt với thiếu hẳn khối", () => {
  const result = parseShipInfoHtml(FIXTURE_EMPTY_VESSEL_STATE);
  assert.equal(result.status, "NO_VESSEL_DATA");
  if (result.status !== "NO_VESSEL_DATA") throw new Error("unreachable");
  assert.equal(result.reason, ShipInfoNoDataReason.EMPTY_VESSEL_STATE);
});

test("HTML rỗng/không phải chuỗi -> NO_VESSEL_DATA, không ném", () => {
  assert.equal(parseShipInfoHtml("").status, "NO_VESSEL_DATA");
  assert.equal(parseShipInfoHtml("   ").status, "NO_VESSEL_DATA");
});

// ---- Malformed JSON -------------------------------------------------------

test("JSON hỏng -> NÉM ShipInfoParseError, KHÔNG nuốt thành không-có-tàu", () => {
  assert.throws(
    () => parseShipInfoHtml(FIXTURE_MALFORMED_JSON),
    (err: unknown) => {
      assert.ok(err instanceof ShipInfoParseError);
      assert.equal(err.marker, "IMOs");
      assert.ok(err.cause !== undefined, "phải giữ lỗi gốc");
      return true;
    }
  );
});

test("vesselSeoContext hỏng cũng NÉM — khối nhúng hỏng là tín hiệu drift", () => {
  assert.throws(
    () => parseShipInfoHtml(FIXTURE_MALFORMED_SEO_CONTEXT),
    (err: unknown) => {
      assert.ok(err instanceof ShipInfoParseError);
      assert.equal(err.marker, "vesselSeoContext");
      return true;
    }
  );
  assert.throws(() => parseSeoContext(FIXTURE_MALFORMED_SEO_CONTEXT), ShipInfoParseError);
});

test("hỏng KHÁC không-có-tàu: một cái ném, một cái trả kết quả", () => {
  // Cùng là "không lấy được tàu" nhưng nguyên nhân khác nhau hoàn toàn:
  // thiếu khối = trang không có tàu; JSON hỏng = nguồn đổi định dạng.
  assert.equal(parseShipInfoHtml(FIXTURE_NO_VESSEL_STATE).status, "NO_VESSEL_DATA");
  assert.throws(() => parseShipInfoHtml(FIXTURE_MALFORMED_JSON), ShipInfoParseError);
});
