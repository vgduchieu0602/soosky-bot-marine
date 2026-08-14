// ============================================================================
//  TEST FIXTURES · ShipFinder — rút gọn từ HTML THẬT (P7.1/P7.2, 2026-08-14)
// ----------------------------------------------------------------------------
//  Trang thật ~59 KB; ở đây giữ đúng cấu trúc parser bám vào (khối `info-grid`
//  với cặp `info-label` / `info-value` mang id `ais-*`, cộng câu mô tả chứa cờ)
//  và cắt phần vô can. Mọi giá trị đều là giá trị thật đã quan sát.
// ============================================================================

interface VesselFixtureInput {
  title: string;
  lead: string;
  rows: ReadonlyArray<readonly [label: string, id: string, value: string]>;
}

/** Dựng trang theo đúng khuôn DOM thật. */
function vesselPage(input: VesselFixtureInput): string {
  const grid = input.rows
    .map(
      ([label, id, value]) =>
        `                    <div class="info-label">${label}</div>\n` +
        `                    <div class="info-value" id="${id}">${value}</div>`
    )
    .join("\n\n");

  return `<!doctype html>
<html lang="en">
<head>
<title>${input.title}</title>
<meta property="og:title" content="${input.title}" />
</head>
<body>
    <div class="detail-lead">${input.lead}</div>
    <div class="info-photo-grid">
        <h2 class="detail-section-title">Ship Info</h2>
        <div class="info-grid">
${grid}
        </div>
    </div>
    <script>var x = 1;</script>
</body>
</html>`;
}

/**
 * Fixture 1 — AGIA DOXA (MMSI 636018086), tàu đang neo, bộ field đầy đủ nhất.
 * Có: IMO, callsign, flag, type, DDM lat/lon, speed/course/heading, navStatus,
 * mốc thời gian, length/width/draught, destination, ETA.
 */
export const FIXTURE_FULL_VESSEL = vesselPage({
  title: "AGIA DOXA, Cargo ship - Current position, specs &amp; port calls - MMSI 636018086 - ShipFinder",
  lead:
    'AGIA DOXA (MMSI: 636018086) is a <span class="highlight">Cargo ship</span> and is currently ' +
    'sailing under the flag of <span class="highlight">LBR</span>, with a length overall (LOA) of ' +
    '<span class="highlight">179</span> meters and a width of <span class="highlight">29</span> meters.',
  rows: [
    ["Name", "ais-name", "AGIA DOXA"],
    ["IMO", "ais-imo", "9467976"],
    ["MMSI", "ais-mmsi", "636018086"],
    ["Call Sign", "ais-callsign", "D5OC7"],
    ["Type", "ais-shipType", "Cargo ship"],
    ["Length", "ais-_length", "179 m"],
    ["Width", "ais-_width", "29 m"],
    ["Lat", "ais-_lat", "33-44.983 N"],
    ["Lon", "ais-_lon", "118-12.531 W"],
    ["Course", "ais-course_f", "0.9 &#176;"],
    ["Heading", "ais-heading_f", "58.0 &#176;"],
    ["Speed", "ais-_sog", "0 kn"],
    ["Draught", "ais-_draught", "5.9 m"],
    // Khoảng trắng KÉP là của nguồn — raw layer phải giữ.
    ["Dest", "ais-dest", "LONG BEACH,  US"],
    ["ETA", "ais-_eta", "07-29 07:01"],
    ["Status", "ais-shipStatus", "Moored"],
    ["Last update", "ais-lastTime", "2026-08-14 23:51:36"],
  ],
});

/**
 * Fixture 2 — QUEEN OF THE WEST (MMSI 367452710): tàu ĐANG CHẠY và
 * `Heading = Unknown` (sentinel thật đã quan sát).
 */
export const FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING = vesselPage({
  title:
    "QUEEN OF THE WEST, Passenger ship - Current position, specs &amp; port calls - MMSI 367452710 - ShipFinder",
  lead:
    'QUEEN OF THE WEST (MMSI: 367452710) is a <span class="highlight">Passenger ship</span> and is ' +
    'currently sailing under the flag of <span class="highlight">USA</span>, with a length overall ' +
    '(LOA) of <span class="highlight">67</span> meters and a width of <span class="highlight">16</span> meters.',
  rows: [
    ["Name", "ais-name", "QUEEN OF THE WEST"],
    ["IMO", "ais-imo", "8642957"],
    ["MMSI", "ais-mmsi", "367452710"],
    ["Call Sign", "ais-callsign", "WDF4506"],
    ["Type", "ais-shipType", "Passenger ship"],
    ["Length", "ais-_length", "67 m"],
    ["Width", "ais-_width", "16 m"],
    ["Lat", "ais-_lat", "45-39.486 N"],
    ["Lon", "ais-_lon", "121-01.914 W"],
    ["Course", "ais-course_f", "97.5 &#176;"],
    ["Heading", "ais-heading_f", "Unknown"],
    ["Speed", "ais-_sog", "10.6 kn"],
    ["Draught", "ais-_draught", "2.5 m"],
    ["Dest", "ais-dest", "RICHLAND, WA."],
    ["ETA", "ais-_eta", "08-13 13:00"],
    ["Status", "ais-shipStatus", "Under way using engine"],
    ["Last update", "ais-lastTime", "2026-08-14 23:10:46"],
  ],
});

/**
 * Fixture 3 — QI XIAN LING (MMSI 414708000). Quan trọng để so với ShipInfo:
 * ShipInfo cho tàu này `length=29 / width=180` (ĐẢO), ShipFinder cho
 * `180 / 29` — đúng chiều.
 */
export const FIXTURE_DIMENSIONS_CORRECT = vesselPage({
  title:
    "QI XIAN LING, Cargo ship - Current position, specs &amp; port calls - MMSI 414708000 - ShipFinder",
  lead:
    'QI XIAN LING (MMSI: 414708000) is a <span class="highlight">Cargo ship</span> and is currently ' +
    'sailing under the flag of <span class="highlight">CHN</span>, with a length overall (LOA) of ' +
    '<span class="highlight">180</span> meters and a width of <span class="highlight">29</span> meters.',
  rows: [
    ["Name", "ais-name", "QI XIAN LING"],
    ["IMO", "ais-imo", "9656864"],
    ["MMSI", "ais-mmsi", "414708000"],
    ["Call Sign", "ais-callsign", "BRNX"],
    ["Type", "ais-shipType", "Cargo ship"],
    ["Length", "ais-_length", "180 m"],
    ["Width", "ais-_width", "29 m"],
    ["Lat", "ais-_lat", "19-13.525 N"],
    ["Lon", "ais-_lon", "96-10.028 W"],
    ["Course", "ais-course_f", "304.1 &#176;"],
    ["Heading", "ais-heading_f", "349.0 &#176;"],
    ["Speed", "ais-_sog", "0 kn"],
    ["Draught", "ais-_draught", "10.5 m"],
    ["Dest", "ais-dest", "VERACRUZ,  MX"],
    ["ETA", "ais-_eta", "08-05 00:00"],
    ["Status", "ais-shipStatus", "Moored"],
    ["Last update", "ais-lastTime", "2026-08-14 23:47:00"],
  ],
});

/**
 * Fixture 4 — KHÔNG TÌM THẤY. Sao theo trang thật của MMSI 232003657:
 * **HTTP 200**, layout đầy đủ, nhưng mọi ô là "-". Tiêu đề cũng rỗng phần tên.
 */
export const FIXTURE_NOT_FOUND = vesselPage({
  title: ",  - Current position, specs &amp; port calls - MMSI 232003657 - ShipFinder",
  lead: "",
  rows: [
    ["Name", "ais-name", "-"],
    ["IMO", "ais-imo", "-"],
    ["MMSI", "ais-mmsi", "-"],
    ["Call Sign", "ais-callsign", "-"],
    ["Type", "ais-shipType", "-"],
    ["Length", "ais-_length", "-"],
    ["Width", "ais-_width", "-"],
    ["Lat", "ais-_lat", "-"],
    ["Lon", "ais-_lon", "-"],
    ["Course", "ais-course_f", "-"],
    ["Heading", "ais-heading_f", "-"],
    ["Speed", "ais-_sog", "-"],
    ["Draught", "ais-_draught", "-"],
    ["Dest", "ais-dest", "-"],
    ["ETA", "ais-_eta", "-"],
    ["Status", "ais-shipStatus", "-"],
    ["Last update", "ais-lastTime", "-"],
  ],
});

/**
 * Fixture 5 — thiếu field tuỳ chọn: không có ô Dest/ETA/Draught/Call Sign,
 * không có câu mô tả nên KHÔNG có cờ. Parser không được gãy.
 */
export const FIXTURE_MISSING_OPTIONAL_FIELDS = vesselPage({
  title: "NO FRILLS, Cargo ship - Current position - MMSI 636018086 - ShipFinder",
  lead: "",
  rows: [
    ["Name", "ais-name", "NO FRILLS"],
    ["IMO", "ais-imo", "-"],
    ["MMSI", "ais-mmsi", "636018086"],
    ["Type", "ais-shipType", "Cargo ship"],
    ["Lat", "ais-_lat", "1-30.000 N"],
    ["Lon", "ais-_lon", "103-30.000 E"],
    ["Speed", "ais-_sog", "0 kn"],
    ["Status", "ais-shipStatus", "Moored"],
    ["Last update", "ais-lastTime", "2026-08-14 23:00:00"],
  ],
});

/**
 * Fixture 6 — biến thể khoảng trắng/markup: nháy đơn cho id, thuộc tính đảo thứ
 * tự, xuống dòng bên trong thẻ, thứ tự field khác hẳn. Parser bám NEO nên không
 * được phụ thuộc thứ tự hay khoảng trắng.
 */
export const FIXTURE_MARKUP_VARIATION = `<!doctype html><html><head>
<title>ODD MARKUP, Cargo ship - MMSI 636018086 - ShipFinder</title></head><body>
<div class="detail-lead">ODD MARKUP is a <b>Cargo ship</b> and is currently sailing under the flag of
   <span class="highlight">SGP</span>, with a length overall (LOA) of 100 meters.</div>
<div class="info-grid">
  <div class='info-label'>Last update</div><div id='ais-lastTime' class='info-value'>2026-08-14 22:00:00</div>
  <div class="info-label">Speed</div><div
        class="info-value"
        id="ais-_sog"   >12.5 kn</div>
  <div class="info-label">Lon</div><div class="info-value" id="ais-_lon">103-51.234 E</div>
  <div class="info-label">Lat</div><div class="info-value" id="ais-_lat">1-16.789 N</div>
  <div class="info-label">MMSI</div><div class="info-value" id="ais-mmsi">636018086</div>
  <div class="info-label">Name</div><div class="info-value" id="ais-name">ODD MARKUP</div>
</div></body></html>`;

/**
 * Fixture 7 — PARSER DRIFT: vẫn là trang chi tiết tàu (`Ship Info`, `info-grid`)
 * nhưng mọi neo id đã bị đổi tên và nhãn cũng khác. Parser PHẢI ném lỗi, không
 * được lặng lẽ báo "không có tàu".
 */
export const FIXTURE_STRUCTURE_DRIFT = `<!doctype html><html><head>
<title>DRIFTED, Cargo ship - MMSI 636018086 - ShipFinder</title></head><body>
<div class="info-photo-grid"><h2 class="detail-section-title">Ship Info</h2>
<div class="info-grid">
  <div class="lbl">Maritime ID</div><div class="val" id="vessel-identity-mmsi">636018086</div>
  <div class="lbl">Position</div><div class="val" id="vessel-position-lat">33-44.983 N</div>
</div></div></body></html>`;

/** Fixture 8 — trang không phải trang tàu (VD trang chủ / 404 của site). */
export const FIXTURE_NOT_A_VESSEL_PAGE = `<!doctype html><html><head>
<title>ShipFinder - Free Satellite AIS Ship Tracking</title></head><body>
<div class="home-banner">Track vessels worldwide</div>
<a href="/ais-data-api">API</a>
</body></html>`;
