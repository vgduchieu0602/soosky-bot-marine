// ============================================================================
//  TEST · ShipFinderParser — giữ ĐÚNG biểu diễn nguồn, không chuẩn hoá gì
// ----------------------------------------------------------------------------
//  Chạy hoàn toàn trên fixture. Không mạng.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHIPFINDER_PARSER_VERSION,
  ShipFinderNoDataReason,
  ShipFinderParseError,
  decodeEntities,
  extractByLabel,
  extractById,
  parseShipFinderHtml,
} from "./ShipFinderParser";
import { ShipFinderRawVessel } from "./ShipFinderTypes";
import {
  FIXTURE_DIMENSIONS_CORRECT,
  FIXTURE_FULL_VESSEL,
  FIXTURE_MARKUP_VARIATION,
  FIXTURE_MISSING_OPTIONAL_FIELDS,
  FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING,
  FIXTURE_NOT_A_VESSEL_PAGE,
  FIXTURE_NOT_FOUND,
  FIXTURE_STRUCTURE_DRIFT,
} from "./shipFinderFixtures";

function vesselOf(html: string): ShipFinderRawVessel {
  const result = parseShipFinderHtml(html);
  assert.equal(result.status, "OK", `mong OK, nhận ${JSON.stringify(result)}`);
  if (result.status !== "OK") throw new Error("unreachable");
  return result.document.vessel;
}

// ---- Identity -------------------------------------------------------------

test("identity raw: mmsi/imo/name/callsign/type", () => {
  const v = vesselOf(FIXTURE_FULL_VESSEL);
  assert.equal(v.mmsi, "636018086");
  assert.equal(v.imo, "9467976");
  assert.equal(v.name, "AGIA DOXA");
  assert.equal(v.callsign, "D5OC7");
  // Nhãn thô của ShipFinder, KHÔNG map sang "Bulk Carrier" như ShipInfo.
  assert.equal(v.type, "Cargo ship");
});

test("flag giữ nguyên mã 3 ký tự, KHÔNG quy đổi sang 2 ký tự", () => {
  assert.equal(vesselOf(FIXTURE_FULL_VESSEL).flag, "LBR");
  assert.equal(vesselOf(FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING).flag, "USA");
  assert.equal(vesselOf(FIXTURE_DIMENSIONS_CORRECT).flag, "CHN");
  // ShipInfo dùng "LR"/"US"/"CN" — quy đổi là việc của P7.3.
  assert.notEqual(vesselOf(FIXTURE_FULL_VESSEL).flag, "LR");
});

// ---- Position -------------------------------------------------------------

test("toạ độ giữ nguyên DDM, KHÔNG đổi sang decimal degrees", () => {
  const v = vesselOf(FIXTURE_FULL_VESSEL);
  assert.equal(v.lat, "33-44.983 N");
  assert.equal(v.lon, "118-12.531 W");
  // 33-44.983 N = 33.749717 — phép đổi đó thuộc P7.3, không phải ở đây.
  assert.equal(typeof v.lat, "string");
  assert.equal(v.lat?.includes("-"), true);
  assert.equal(v.lat?.endsWith(" N"), true);
  assert.equal(v.lon?.endsWith(" W"), true);
});

test("speed/course giữ nguyên đơn vị", () => {
  const v = vesselOf(FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING);
  assert.equal(v.speed, "10.6 kn");
  assert.equal(v.course, "97.5 °");
  assert.equal(typeof v.speed, "string");
  // Ký hiệu độ được giải mã từ &#176; nhưng KHÔNG bị bóc khỏi giá trị.
  assert.equal(v.course?.includes("°"), true);
});

test("navStatus giữ nguyên chữ của nguồn, chưa map enum", () => {
  assert.equal(vesselOf(FIXTURE_FULL_VESSEL).status, "Moored");
  assert.equal(
    vesselOf(FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING).status,
    "Under way using engine"
  );
});

test('sentinel heading "Unknown" VẪN là "Unknown"', () => {
  const v = vesselOf(FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING);
  assert.equal(v.heading, "Unknown");
  assert.notEqual(v.heading, null);
  // Chuyển thành thiếu dữ liệu là việc của P7.3.
  assert.equal(vesselOf(FIXTURE_FULL_VESSEL).heading, "58.0 °");
});

test("lastUpdate giữ nguyên chuỗi, KHÔNG gán múi giờ", () => {
  const v = vesselOf(FIXTURE_FULL_VESSEL);
  assert.equal(v.lastUpdate, "2026-08-14 23:51:36");
  // Không "Z", không "+08:00", không Date.
  assert.equal(v.lastUpdate?.includes("Z"), false);
  assert.equal(v.lastUpdate?.includes("+"), false);
  assert.equal(typeof v.lastUpdate, "string");
});

// ---- Particulars ----------------------------------------------------------

test("length/width/draught giữ nguyên đơn vị, giữ nguyên TÊN của nguồn", () => {
  const v = vesselOf(FIXTURE_FULL_VESSEL);
  assert.equal(v.length, "179 m");
  // Nguồn gọi là `width`; đổi sang `beam` là việc của canonical mapper.
  assert.equal(v.width, "29 m");
  assert.equal(v.draught, "5.9 m");
  assert.equal("beam" in v, false);
});

test("kích thước ĐÚNG CHIỀU ở tàu mà ShipInfo bị đảo", () => {
  // ShipInfo cho QI XIAN LING: length=29 / width=180 (bất khả thi).
  const v = vesselOf(FIXTURE_DIMENSIONS_CORRECT);
  assert.equal(v.length, "180 m");
  assert.equal(v.width, "29 m");
  assert.ok(Number.parseFloat(v.length ?? "0") > Number.parseFloat(v.width ?? "0"));
});

// ---- Voyage ---------------------------------------------------------------

test("destination giữ nguyên chuỗi thô, kể cả khoảng trắng KÉP", () => {
  assert.equal(vesselOf(FIXTURE_FULL_VESSEL).destination, "LONG BEACH,  US");
  assert.equal(vesselOf(FIXTURE_DIMENSIONS_CORRECT).destination, "VERACRUZ,  MX");
  assert.equal(vesselOf(FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING).destination, "RICHLAND, WA.");
});

test("ETA VẪN thiếu năm — parser không suy, không thêm năm hiện tại", () => {
  const v = vesselOf(FIXTURE_FULL_VESSEL);
  assert.equal(v.eta, "07-29 07:01");
  assert.equal(v.eta?.includes("2026"), false);
  assert.equal(v.eta?.includes("202"), false);
  assert.equal(vesselOf(FIXTURE_DIMENSIONS_CORRECT).eta, "08-05 00:00");
});

// ---- Không chuẩn hoá gì ---------------------------------------------------

test("mọi giá trị raw đều là CHUỖI — không field nào bị ép số", () => {
  const v = vesselOf(FIXTURE_FULL_VESSEL);
  for (const [field, value] of Object.entries(v)) {
    assert.equal(typeof value, "string", `${field} phải là chuỗi, nhận ${typeof value}`);
  }
});

// ---- Neo & biến thể markup ------------------------------------------------

test("bám NEO id: đổi thứ tự field, nháy đơn, xuống dòng trong thẻ vẫn đọc được", () => {
  const result = parseShipFinderHtml(FIXTURE_MARKUP_VARIATION);
  assert.equal(result.status, "OK");
  if (result.status !== "OK") throw new Error("unreachable");

  const v = result.document.vessel;
  assert.equal(v.mmsi, "636018086");
  assert.equal(v.name, "ODD MARKUP");
  assert.equal(v.lat, "1-16.789 N");
  assert.equal(v.lon, "103-51.234 E");
  assert.equal(v.speed, "12.5 kn");
  assert.equal(v.lastUpdate, "2026-08-14 22:00:00");
  assert.equal(v.flag, "SGP");
  // Đọc được bằng neo -> không phải dùng đường dự phòng.
  assert.deepEqual([...result.document.fallbackFields], []);
});

test("extractById / extractByLabel hoạt động độc lập", () => {
  assert.equal(extractById(FIXTURE_FULL_VESSEL, "ais-mmsi"), "636018086");
  assert.equal(extractById(FIXTURE_FULL_VESSEL, "khong-ton-tai"), null);
  assert.equal(extractByLabel(FIXTURE_FULL_VESSEL, "MMSI"), "636018086");
  assert.equal(extractByLabel(FIXTURE_FULL_VESSEL, "Không Có Nhãn Này"), null);
});

test("decodeEntities: &#176; -> °", () => {
  assert.equal(decodeEntities("0.9 &#176;"), "0.9 °");
  assert.equal(decodeEntities("A &amp; B"), "A & B");
  assert.equal(decodeEntities("&quot;x&quot;"), '"x"');
  assert.equal(decodeEntities("nguyên vẹn"), "nguyên vẹn");
});

// ---- Thiếu field ----------------------------------------------------------

test("thiếu field tuỳ chọn -> không crash, field vắng mặt", () => {
  const result = parseShipFinderHtml(FIXTURE_MISSING_OPTIONAL_FIELDS);
  assert.equal(result.status, "OK");
  if (result.status !== "OK") throw new Error("unreachable");

  const v = result.document.vessel;
  assert.equal(v.mmsi, "636018086");
  assert.equal(v.name, "NO FRILLS");
  assert.equal(v.destination, undefined);
  assert.equal(v.eta, undefined);
  assert.equal(v.draught, undefined);
  assert.equal(v.callsign, undefined);
  assert.equal(v.heading, undefined);
  // Không có câu mô tả -> không có cờ, và không được bịa.
  assert.equal(v.flag, undefined);
  // "-" của từng ô lẻ được GIỮ, không bị biến thành null ở raw layer.
  assert.equal(v.imo, "-");
});

// ---- Not found ------------------------------------------------------------

test("HTTP 200 nhưng mọi ô là \"-\" -> NO_VESSEL_DATA, KHÔNG tạo tàu ma", () => {
  const result = parseShipFinderHtml(FIXTURE_NOT_FOUND);
  assert.equal(result.status, "NO_VESSEL_DATA");
  if (result.status !== "NO_VESSEL_DATA") throw new Error("unreachable");
  assert.equal(result.reason, ShipFinderNoDataReason.EMPTY_VESSEL_RECORD);
  // Tuyệt đối không có vessel với mmsi = "-".
  assert.equal("document" in result, false);
});

test("trang không phải trang tàu -> NO_VESSEL_DATA", () => {
  for (const html of [FIXTURE_NOT_A_VESSEL_PAGE, "", "   "]) {
    const result = parseShipFinderHtml(html);
    assert.equal(result.status, "NO_VESSEL_DATA");
    if (result.status !== "NO_VESSEL_DATA") throw new Error("unreachable");
    assert.equal(result.reason, ShipFinderNoDataReason.NOT_A_VESSEL_PAGE);
  }
});

// ---- Parser drift ---------------------------------------------------------

test("trang tàu mất neo -> NÉM, KHÔNG biến thành not-found", () => {
  assert.throws(
    () => parseShipFinderHtml(FIXTURE_STRUCTURE_DRIFT),
    (err: unknown) => {
      assert.ok(err instanceof ShipFinderParseError);
      assert.equal(err.anchor, "ais-mmsi");
      return true;
    }
  );
});

test("drift KHÁC not-found: một cái ném, một cái trả kết quả", () => {
  // Cùng là "không lấy được tàu" nhưng nguyên nhân khác hẳn: không có MMSI đó
  // trong dữ liệu vs nguồn đã đổi cấu trúc trang.
  assert.equal(parseShipFinderHtml(FIXTURE_NOT_FOUND).status, "NO_VESSEL_DATA");
  assert.throws(() => parseShipFinderHtml(FIXTURE_STRUCTURE_DRIFT), ShipFinderParseError);
});

test("parserVersion được khai báo", () => {
  assert.equal(SHIPFINDER_PARSER_VERSION, "shipfinder-ssr-anchors-v1");
});
