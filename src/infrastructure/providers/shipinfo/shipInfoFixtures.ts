// ============================================================================
//  TEST FIXTURES · ShipInfo — rút gọn từ response THẬT (P6.1, 2026-08-14)
// ----------------------------------------------------------------------------
//  Giữ nguyên hình dạng quan trọng, cắt bớt phần vô can (leaflet, quảng cáo,
//  268 điểm track). Mọi giá trị dưới đây đều lấy từ response thật — không bịa
//  field, không "làm đẹp" dữ liệu.
//
//  Trang thật nặng 250–295 KB nên KHÔNG lưu nguyên; cái cần khoá là cấu trúc,
//  không phải kích thước.
// ============================================================================

function page(body: string): string {
  return `<!doctype html><html><head><title>ShipInfo</title></head><body>
<div id="map"></div>
<script>
${body}
setTimeout(() => map.invalidateSize(true), 0);
</script>
</body></html>`;
}

/**
 * Fixture 1 — tàu "đầy đủ" nhất quan sát được (Agia Doxa, IMO 9467976).
 * Có callsign, flag+country, year, dwt, track. `length`/`width` ở tàu này ĐÚNG
 * (179/29) — đối chiếu với fixture SWAPPED_DIMENSIONS.
 */
export const FIXTURE_NORMAL_VESSEL = page(`
var IMOs = {"9467976":{"id":"1","imo":"9467976","mmsi":"636018086","name":"Agia Doxa","callsign":"D5OC7","width":"29","length":"179","type":"Bulk Carrier\\n","flag":"LR","country":"Liberia","year":"2010","dwt":"33261","text":null,"first":1,"image":"https:\\/\\/shipinfo.net\\/ships\\/b\\/9467976_vessel_m.jpg","notes":"","fresh_access":{"has_fresh_position":true,"fresh_position_time":"2026-08-14 09:42:31","fresh_locked":true,"fresh_age_minutes":65,"position_delay_hours":14,"access_mode":"free"},"points":[{"updated":"2026-08-13 19:32:11","lat":"33.75001","lng":"-118.20901","order":null,"destination":null,"eta":null,"inserted":"2026-08-13 19:32:40","speed":"0.1","heading":null,"zone":null,"draught":null,"course":"61","provider":"free","src":""},{"updated":"2026-08-13 19:39:30","lat":"33.74968","lng":"-118.20887","order":null,"destination":null,"eta":null,"inserted":"2026-08-13 19:39:55","speed":"0","heading":null,"zone":null,"draught":null,"course":"58","provider":"free","src":""}]}};
var vesselSeoContext = {"name":"Agia Doxa","geo_label":"Near Long Beach","last_seen":"about 15h ago","updated_utc":"2026-08-13 17:39:30","type":"Bulk Carrier","imo":"9467976","length_m":"179","width_m":"29","mmsi":"636018086"};
`);

/**
 * Fixture 2 — thiếu nhiều field tuỳ chọn (dựng theo JAHAN BROTHERS I 9493975
 * + Admarine 100 8913629). callsign/width/length/year/dwt null, KHÔNG có track
 * point, và KHÔNG có khối `vesselSeoContext`.
 */
export const FIXTURE_MISSING_OPTIONAL_FIELDS = page(`
var IMOs = {"8913629":{"id":"2","imo":"8913629","mmsi":"374121000","name":"Admarine 100","callsign":null,"width":null,"length":null,"type":"Fso Oil","flag":null,"country":null,"year":null,"dwt":null,"text":null,"first":1,"image":"https:\\/\\/shipinfo.net\\/ships\\/b\\/8913629_vessel_m.jpg","notes":"","fresh_access":{"has_fresh_position":false,"fresh_position_time":null,"fresh_locked":false,"fresh_age_minutes":null,"position_delay_hours":14,"access_mode":"free"},"points":[]}};
`);

/**
 * Fixture 3 — sentinel + biến thể khoảng trắng.
 * `course: "-1"` (không rõ hướng) và `heading: null` — quan sát trên Queen Of
 * The West và JAHAN BROTHERS I. Khai báo viết sát `var IMOs={...};` để chứng
 * minh parser không phụ thuộc khoảng trắng.
 */
export const FIXTURE_SENTINEL_VALUES = page(
  `var IMOs={"8642957":{"id":"3","imo":"8642957","mmsi":"367452710","name":"Queen Of The West","callsign":"WDF4506","width":"16","length":"67","type":"Passenger Ship","flag":"US","country":"USA","year":"1994","dwt":null,"first":1,"image":"","notes":"","fresh_access":{"has_fresh_position":true,"fresh_position_time":"2026-08-14 09:44:45","fresh_locked":true,"fresh_age_minutes":63,"position_delay_hours":14,"access_mode":"free"},"points":[{"updated":"2026-08-13 19:57:25","lat":"45.69778","lng":"-121.42427","order":null,"destination":null,"eta":null,"inserted":"2026-08-13 20:19:57","speed":"10.6","heading":null,"zone":null,"draught":null,"course":"-1","provider":"free","src":""}]}} ;
   var   vesselSeoContext   =   {"name":"Queen Of The West","geo_label":"Near Mosier","last_seen":"about 14h ago","updated_utc":"2026-08-13 17:57:25","type":"Passenger Ship","imo":"8642957","length_m":"67","width_m":"16","mmsi":"367452710"}   ;`
);

/**
 * Fixture 4 — `length`/`width` BỊ ĐẢO (Qi Xian Ling, IMO 9656864).
 * Bulk carrier: length=29 m / width=180 m là bất khả thi về vật lý; số đúng
 * phải là dài 180 / rộng 29. `vesselSeoContext` LẶP LẠI đúng giá trị sai
 * (length_m=29, width_m=180) -> sai từ database, không phải lỗi hiển thị.
 *
 * Parser P6.2 phải giữ NGUYÊN. Việc hoán đổi (hoặc bỏ hẳn) là quyết định của
 * P6.3 — xem docs/sources/SHIPINFO_AUDIT.md §4.
 */
export const FIXTURE_SWAPPED_DIMENSIONS = page(`
var IMOs = {"9656864":{"id":"4","imo":"9656864","mmsi":"414708000","name":"Qi Xian Ling","callsign":"BRNX","width":"180","length":"29","type":"Bulk Carrier\\n","flag":null,"country":null,"year":null,"dwt":null,"text":null,"first":1,"image":"","notes":"","fresh_access":{"has_fresh_position":true,"fresh_position_time":"2026-08-14 09:37:57","fresh_locked":true,"fresh_age_minutes":65,"position_delay_hours":14,"access_mode":"free"},"points":[{"updated":"2026-08-13 20:07:53","lat":"19.22542","lng":"-96.16712","order":null,"destination":null,"eta":null,"inserted":"2026-08-13 20:09:37","speed":"0","heading":null,"zone":null,"draught":null,"course":"349","provider":"free","src":""}]}};
var vesselSeoContext = {"name":"Qi Xian Ling","geo_label":"Near Veracruz","last_seen":"about 14h ago","updated_utc":"2026-08-13 18:07:53","type":"Bulk Carrier","imo":"9656864","length_m":"29","width_m":"180","mmsi":"414708000"};
`);

/**
 * Fixture 5 — tra bằng MMSI: khoá của `IMOs` là MMSI chứ không phải IMO
 * (quan sát khi gọi `IMO-0_MMSI-414708000`).
 */
export const FIXTURE_KEYED_BY_MMSI = page(`
var IMOs = {"414708000":{"id":"5","imo":"9656864","mmsi":"414708000","name":"Qi Xian Ling","callsign":"BRNX","width":"180","length":"29","type":"Bulk Carrier\\n","flag":null,"country":null,"year":null,"dwt":null,"first":1,"image":"","notes":"","points":[]}};
`);

/**
 * Fixture 6 — không tìm thấy tàu: **HTTP 200** nhưng body là PHP fatal error.
 * Sao y nguyên văn response của `/find_vessel_Ghost_IMO-0000000_MMSI-000000000`.
 */
export const FIXTURE_PHP_FATAL_ERROR = `<br />
<b>Fatal error</b>:  Allowed memory size of 134217728 bytes exhausted (tried to allocate 325068160 bytes) in <b>/var/www/shipinfo.net/vessels_map.php</b> on line <b>2794</b><br />
`;

/** Fixture 7 — trang HTML hợp lệ nhưng không mang dữ liệu tàu nào. */
export const FIXTURE_NO_VESSEL_STATE = page(`
var colors = ["#fff","#000"];
var show_titles = "0";
`);

/** Fixture 8 — có `var IMOs` nhưng object rỗng. */
export const FIXTURE_EMPTY_VESSEL_STATE = page(`var IMOs = {};`);

/**
 * Fixture 9 — có marker nhưng JSON hỏng (dấu phẩy thừa + khoá không trích dẫn).
 * Parser PHẢI ném lỗi, không được im lặng trả về "không có tàu".
 */
export const FIXTURE_MALFORMED_JSON = page(
  `var IMOs = {"9467976":{"imo":"9467976",,"name":broken}};`
);

/** Fixture 10 — `vesselSeoContext` hỏng dù khối tàu vẫn tốt. */
export const FIXTURE_MALFORMED_SEO_CONTEXT = page(`
var IMOs = {"9467976":{"imo":"9467976","mmsi":"636018086","name":"Agia Doxa","points":[]}};
var vesselSeoContext = {"name":"Agia Doxa",,};
`);

/**
 * Fixture 11 — tên tàu chứa dấu ngoặc nhọn. Bộ đếm cặp ngoặc phải bỏ qua ngoặc
 * nằm trong chuỗi, nếu không khối sẽ bị cắt cụt.
 */
export const FIXTURE_BRACE_IN_STRING = page(
  `var IMOs = {"9467976":{"imo":"9467976","name":"WEIRD } NAME {","notes":"a \\" quote and } brace","points":[]}};`
);
