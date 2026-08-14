# SHIPINFO_AUDIT — Phase 6.1 (reconnaissance)

> **Site:** `https://shipinfo.net` — xác định bằng probe DNS/HTTP; repo trước đó không lưu URL nào cho `VesselSource.SHIPINFO`.
> **Ngày audit:** 2026-08-14, khoảng 08:42–08:55 UTC.
> **Phạm vi:** 5 tàu + vài request chẩn đoán, ~25 request tổng, giãn 2–4 s/request. Không bulk crawl, không scan vùng, không ghi DB.
> **Trạng thái matrix:** ShipInfo giữ nguyên `CANDIDATE`. Audit chỉ tạo bằng chứng — nâng lên `CONFIRMED` là việc của P6.2/P6.3 sau khi parser chạy thật.

Tàu dùng để audit:

| Tên trên trang | IMO | MMSI | Vì sao chọn |
|---|---|---|---|
| Qi Xian Ling | 9656864 | 414708000 | Có cả IMO + MMSI, đang chạy, có track |
| Queen Of The West | 8642957 | 367452710 | Có flag/country/year |
| JAHAN BROTHERS I | 9493975 | 405000420 | URL sitemap ghi tên khác ("Isabelita") — bẫy dữ liệu cũ |
| Admarine 100 | 8913629 | 374121000 | Không có track point nào |
| Agia Doxa | 9467976 | 636018086 | Bộ particulars đầy đủ nhất (dwt + year) |
| — | 0 | 0 | Trường hợp không tìm thấy |

---

## 1. Executive summary

**Có đáng tiếp tục POC — nhưng KHÔNG phải như một nguồn vị trí.**

Ba điều quyết định:

1. ✅ **Cơ chế lấy dữ liệu rất tốt.** Toàn bộ dữ liệu tàu nằm trong **một khối JSON nhúng** (`var IMOs = {...}`) trong HTML server-render. Không cần JS engine, không XHR, không session, không anti-bot. Parse dễ và ổn định hơn hẳn kiểu bóc regex bảng HTML mà `VesselFinderHtmlMapper` đang làm.

2. ⛔ **Vị trí bản free bị trễ ~14 giờ CÓ CHỦ Ý.** Trang tự khai:
   ```json
   "fresh_access":{"has_fresh_position":true,"fresh_position_time":"2026-08-14 09:37:57",
                   "fresh_locked":true,"fresh_age_minutes":65,"position_delay_hours":14,"access_mode":"free"}
   ```
   Vị trí mới **tồn tại nhưng bị khoá**; điểm track mới nhất mà bản free trả về đã cũ ~14 h. Với bản đồ tàu thời gian thực, đây là **loại ShipInfo ra khỏi vai trò nguồn vị trí sống**.

3. ✅ **Nhưng nó cho hai thứ VesselFinder hiện KHÔNG cho**: **mã cờ quốc gia** (`flag: "LR"` + `country: "Liberia"` — canonical `VesselFlag.code` hiện luôn null) và **lịch sử track ~268 điểm/tàu (~14 ngày)**.

**Kết luận:** POC tiếp, nhưng đóng khung ShipInfo là **nguồn identity + lịch sử track**, không phải nguồn vị trí realtime. Nếu mục tiêu P6 là vị trí realtime thì ShipInfo **không giải quyết được**, và nên đổi thứ tự ưu tiên nguồn.

⚠️ **Chặn pháp lý/kỹ thuật:** `robots.txt` **Disallow: /api/** cho mọi user-agent. Mọi endpoint JSON và **toàn bộ chức năng tìm theo tên** đều nằm dưới `/api/`. Xem §6.

---

## 2. Lookup mechanisms

URL trang tàu: `https://shipinfo.net/find_vessel_{Name}_IMO-{imo}_MMSI-{mmsi}`

| Operation | Supported | Mechanism | Notes |
|---|---|---|---|
| **IMO lookup** | ✅ Có | `GET /find_vessel_{bất kỳ}_IMO-{imo}_MMSI-{bất kỳ}` | Định tuyến bằng IMO. `find_vessel_X_IMO-9656864_MMSI-414708000` (sai tên) và `..._MMSI-000000000` (sai MMSI) **đều trả đúng tàu**. |
| **MMSI lookup** | ✅ Có | `GET /find_vessel_{tên}_IMO-0_MMSI-{mmsi}` | Đặt IMO=0 thì site tra bằng MMSI. Đã xác minh: `IMO-0_MMSI-414708000` trả đúng Qi Xian Ling, khoá trong `IMOs` đổi thành `"414708000"`. |
| **Name search** | ⛔ **Có nhưng bị robots cấm** | jQuery UI autocomplete → `POST api/find_ship_name.php` | `/api/` nằm trong `Disallow`. **Không fetch để xác minh.** Không có đường tìm theo tên nào khác được phép. |

Chi tiết đã xác minh:

- **Method:** `GET`. Không param query. Định danh nằm trong **path**.
- **Redirect:** không có. 200 trực tiếp.
- **Cookie/session:** **KHÔNG cần.** Server trả `Set-Cookie: PHPSESSID=...` nhưng dữ liệu đầy đủ ngay ở request đầu tiên, không gửi cookie nào.
- **Tên trong URL là trang trí.** `find_vessel_Isabelita_IMO-9493975_MMSI-257654000` (lấy từ chính sitemap của site) trả về tàu tên **"JAHAN BROTHERS I"**, MMSI **405000420** — khác cả tên lẫn MMSI trong URL. Sitemap đã cũ. **Không được tin tên/MMSI trong URL.**
- **404 thật sự** chỉ xảy ra khi thiếu hẳn segment: `/find_vessel_IMO-9656864` → `404`, `/find_vessel_MMSI-414708000` → `404`.

### Không tìm thấy = PHP fatal error, HTTP 200

`/find_vessel_Ghost_IMO-0000000_MMSI-000000000` trả **HTTP 200**, 187 byte:

```
<br /><b>Fatal error</b>:  Allowed memory size of 134217728 bytes exhausted
(tried to allocate 325068160 bytes) in <b>/var/www/shipinfo.net/vessels_map.php</b> on line <b>2794</b><br />
```

Ba hệ quả cho provider sau này:
1. **Không được dựa vào HTTP status để biết "không có tàu".** Phải phát hiện vắng mặt khối `var IMOs`.
2. Body rò đường dẫn server và số dòng → chất lượng xử lý lỗi phía site thấp.
3. `SourceRequestExecutor` (P4) sẽ xếp cái này thành `PARSE_ERROR` (không retry) chứ không phải `NOT_FOUND` — **đúng như mong muốn ở góc độ an toàn**, nhưng provider phải tự dịch sang `null` cho `getDetails`.

Ngoài ra IMO "vô lý" chưa chắc là không tồn tại: `IMO-1000019` → *LADY K II* (Houseboat, 0 track point), `IMO-9999999` → *ROSA DEI VENTI* (Passenger, 177 điểm). **Không dùng IMO giả để test not-found.**

---

## 3. Data transport

**Server-rendered HTML + embedded JSON state.** Không XHR cho dữ liệu chính, không WebSocket, không cần thực thi JavaScript.

| Cơ chế | Có dùng? | Ghi chú |
|---|---|---|
| Server-rendered HTML | ✅ chính | Apache/2.4.59 (Debian), PHP |
| Embedded JSON trong HTML | ✅ **nguồn dữ liệu chính** | `var IMOs = {...}` và `var vesselSeoContext = {...}` |
| XHR / JSON endpoint | ⚠️ có tồn tại | Tất cả dưới `/api/` → **robots cấm** |
| WebSocket | ❌ không thấy | |
| Dữ liệu trong DOM (bảng HTML) | ❌ **không có** | Không tìm thấy `<td>` nào chứa IMO/MMSI/Callsign/Length/Draught. Chỉ có `og:title` / `og:description` |
| JS bundle riêng | ❌ không cần | Dữ liệu inline, không nằm trong file `.js` |

### Khối 1 — `var IMOs` (nguồn chính)

Object khoá theo IMO (hoặc MMSI khi tra bằng `IMO-0`):

```json
"9467976": {
  "id":"...","imo":"9467976","mmsi":"636018086","name":"Agia Doxa","callsign":"D5OC7",
  "width":"29","length":"179","type":"Bulk Carrier\n",
  "flag":"LR","country":"Liberia","year":"2010","dwt":"33261",
  "text":null,"first":1,"image":"https://shipinfo.net/ships/...jpg","notes":"",
  "fresh_access":{"has_fresh_position":true,"fresh_position_time":"2026-08-14 09:42:31",
                  "fresh_locked":true,"fresh_age_minutes":65,
                  "position_delay_hours":14,"access_mode":"free"},
  "points":[ /* 268 phần tử */ ]
}
```

`points[]` — mỗi phần tử **14 khoá cố định**:

```json
{"updated":"2026-08-13 19:39:30","lat":"33.74968","lng":"-118.20887",
 "order":null,"destination":null,"eta":null,"inserted":"2026-08-13 19:39:55",
 "speed":"0","heading":null,"zone":null,"draught":null,"course":"58",
 "provider":"free","src":""}
```

**Mọi giá trị số đều là chuỗi.** Parser phải ép kiểu.

### Khối 2 — `var vesselSeoContext` (phụ, nhưng chứa mốc UTC)

```json
{"name":"Qi Xian Ling","geo_label":"Near Veracruz","last_seen":"about 14h ago",
 "updated_utc":"2026-08-13 18:07:53","type":"Bulk Carrier",
 "imo":"9656864","length_m":"29","width_m":"180","mmsi":"414708000"}
```

Đây là khối **duy nhất** có mốc thời gian ghi rõ là UTC (§5).

Trích xuất đề xuất: `/var IMOs = (\{[\s\S]*?\});[\r\n]/` rồi `JSON.parse`. Đã chạy đúng trên **5/5** trang.

---

## 4. Field capability evidence

Tổng hợp trên 5 tàu, **1073 track point** đã kiểm.

| Canonical field | Available | Source location | Evidence / Notes |
|---|---|---|---|
| `identity.mmsi` | ✅ 5/5 | `IMOs[k].mmsi` | ⚠️ Có thể khác MMSI trong URL (JAHAN BROTHERS I: URL 257654000, thực tế 405000420) |
| `identity.imo` | ✅ 5/5 | `IMOs[k].imo` | Khoá định tuyến chính |
| `identity.name` | ✅ 5/5 | `IMOs[k].name` | Cũng có ở `vesselSeoContext.name` và `og:title` |
| `identity.callsign` | ⚠️ 4/5 | `IMOs[k].callsign` | `null` với JAHAN BROTHERS I |
| `identity.flag` | ⚠️ 3/5 | `IMOs[k].flag` + `.country` | **Cho CẢ MÃ LẪN TÊN**: `"LR"` + `"Liberia"`, `"US"` + `"USA"`, `"BD"` + `"Bangladesh"`. Điền được `VesselFlag.code` mà VesselFinder không cho |
| `identity.vesselType` | ✅ 5/5 | `IMOs[k].type` | Nhãn chữ. ⚠️ **có `\n` ở cuối** (`"Bulk Carrier\n"`) — phải trim |
| `identity.vesselTypeCode` | ❌ 0/5 | — | Không có mã AIS số |
| `position.lat` | ✅ | `points[i].lat` | Chuỗi, decimal degrees |
| `position.lng` | ✅ | `points[i].lng` | Chuỗi |
| `position.speed` | ✅ 1073/1073 | `points[i].speed` | Chuỗi, knots |
| `position.course` | ⚠️ 1073/1073 | `points[i].course` | **Có sentinel `"-1"`** ở 2/4 tàu → nghĩa là "không rõ". `isValidCourse` (P1) sẽ loại → observation `PARTIAL`. Phải map `-1` → `null` **trước** khi vào canonical |
| `position.heading` | ❌ **0/1073** | `points[i].heading` | Khoá tồn tại nhưng **luôn null** trên mọi tàu, mọi điểm |
| `position.navStatus` | ❌ 0/5 | — | Không có khoá nào tương ứng |
| `position.receivedAt` | ✅ | `points[i].updated` | **Mốc của NGUỒN**, không phải giờ bot. Xem §5 về timezone |
| `particulars.type` | ✅ | (= `identity.vesselType`) | ShipInfo không tách hai khái niệm |
| `particulars.length` | ⛔ **không tin được** | `IMOs[k].length` | Xem cảnh báo bên dưới |
| `particulars.beam` | ⛔ **không tin được** | `IMOs[k].width` | Xem cảnh báo bên dưới |
| `particulars.draught` | ❌ **0/1073** | `points[i].draught` | Khoá tồn tại, luôn null. Không có ở cấp tàu |
| `particulars.grossTonnage` | ❌ 0/5 | — | Không có khoá |
| `particulars.deadweight` | ⚠️ 1/5 | `IMOs[k].dwt` | Chỉ Agia Doxa (`"33261"`) |
| `particulars.builtYear` | ⚠️ 2/5 | `IMOs[k].year` | Queen Of The West `1994`, Agia Doxa `2010` |
| `voyage.destination` | ❌ **0/1073** | `points[i].destination` | Khoá tồn tại, luôn null |
| `voyage.eta` | ❌ **0/1073** | `points[i].eta` | Khoá tồn tại, luôn null |
| `voyage.currentPort` / `nextPort` / `lastPort` | ❌ 0/5 | — | Không có |
| **Track history** *(ngoài canonical)* | ✅ 4/5 | `points[]` | **268–269 điểm ≈ 14 ngày**. VesselFinder free không cho. Canonical hiện chưa có nhóm nào chứa lịch sử |
| `image` | ✅ 5/5 | `IMOs[k].image` | URL ảnh tàu; canonical `Vessel.photoUrl` có sẵn cột (chưa nguồn nào ghi) |

### ⛔ `length` / `width` KHÔNG dùng được

Không phải bị hoán đổi một cách nhất quán — mà **không nhất quán**:

| Tàu | `length` | `width` | Thực tế |
|---|---|---|---|
| Agia Doxa (Bulk Carrier) | 179 | 29 | ✅ đúng |
| Queen Of The West (Passenger) | 67 | 16 | ✅ đúng |
| Qi Xian Ling (Bulk Carrier) | **29** | **180** | ❌ **đảo** |
| Admarine 100 (FSO) | **32** | **183** | ❌ **đảo** |

`vesselSeoContext` lặp lại đúng giá trị sai (`length_m: 29, width_m: 180`) → sai từ database, không phải lỗi hiển thị.

Suy ra "cái lớn hơn là chiều dài" là **đoán**, không phải dữ liệu. Với tàu đặc biệt (sà lan, ụ nổi) đoán này sai.
**Khuyến nghị: KHÔNG map `length`/`beam` từ ShipInfo.** Để `UNSUPPORTED` cho tới khi có cách kiểm chứng chéo.

---

## 5. Timestamp semantics

Trên trang có **ba** mốc thời gian, và chỉ hai trong số đó là của nguồn:

| Trường | Là gì | Dùng cho canonical |
|---|---|---|
| `points[i].updated` | **Mốc của NGUỒN** — thời điểm bản tin AIS được ghi nhận | → `VesselPositionReport.receivedAt` **và** `SourceMetadata.sourceReceivedAt` |
| `points[i].inserted` | Lúc **database ShipInfo** ghi bản ghi (trễ hơn `updated` vài giây–vài chục phút) | Không map. Là đồng hồ nội bộ của họ |
| `vesselSeoContext.updated_utc` | Cùng mốc với `points[cuối].updated` nhưng **đã đổi sang UTC** | Dùng để hiệu chỉnh timezone |
| *(giờ bot fetch)* | Đồng hồ của ta | → `SourceMetadata.fetchedAt` **duy nhất**. **Không bao giờ** dùng làm `sourceReceivedAt` |

### ⚠️ `points[].updated` là UTC+2, KHÔNG phải UTC

Xác minh trên 3 tàu, lệch chính xác **+2 giờ** mọi lần:

| Tàu | `points[cuối].updated` | `seoContext.updated_utc` | Lệch |
|---|---|---|---|
| Qi Xian Ling | 2026-08-13 20:07:53 | 2026-08-13 18:07:53 | +2h |
| Queen Of The West | 2026-08-13 19:57:25 | 2026-08-13 17:57:25 | +2h |
| Agia Doxa | 2026-08-13 19:39:30 | 2026-08-13 17:39:30 | +2h |

Kiểm chứng chéo độc lập bằng `fresh_access` — Qi Xian Ling, thời điểm fetch ≈ **08:43 UTC**:

```
fresh_position_time = 2026-08-14 09:37:57      fresh_age_minutes = 65
09:37:57 − 2h = 07:37:57 UTC ;  08:43 − 07:38 = 65 phút   ✅ khớp chính xác
```

→ **Mọi mốc thời gian trên site (trừ `updated_utc`) là UTC+2.** Parse chuỗi trần rồi coi là UTC sẽ đẩy mọi vị trí **sớm lên 2 giờ**.

⚠️ Chuỗi không mang offset (`"2026-08-13 19:39:30"`). `new Date(chuỗi)` trong Node hiểu là **giờ máy chủ chạy bot**, không phải UTC, không phải UTC+2 — **sai hai lần**. Parser phải cộng offset tường minh. Và +2h nhiều khả năng là **giờ mùa hè châu Âu** → mùa đông có thể thành +1h. **Phải kiểm lại sau tháng 10 hoặc tự suy offset bằng `updated_utc` mỗi lần parse** (an toàn hơn: lấy hiệu giữa `points[cuối].updated` và `updated_utc`).

### Độ trễ 14 giờ của bản free

`position_delay_hours: 14`, `fresh_locked: true`, `access_mode: "free"` — giống nhau trên **5/5** tàu.
Điểm track mới nhất mà bản free trả về cách vị trí thật ~13,5–14 h. `fresh_position_time` cho biết vị trí mới **tồn tại**, nhưng giá trị toạ độ không nằm trong HTML.

**Nếu map thẳng điểm cuối thành "vị trí hiện tại" thì đó là dữ liệu sai lệch 14 giờ.** Bắt buộc:
- đặt `sourceReceivedAt = points[cuối].updated` (đã đổi UTC) để resolver thấy được độ cũ, **và**
- để merge policy phase sau ưu tiên nguồn tươi hơn theo `sourceReceivedAt`.

---

## 6. Anti-bot / rate-limit observations

Chỉ ghi nhận. Không thử vượt qua bất kỳ hạn chế nào.

| Hạng mục | Quan sát |
|---|---|
| Cloudflare | ❌ Không thấy. `Server: Apache/2.4.59 (Debian)`, không có header `cf-*` |
| CAPTCHA | ❌ Không gặp trong ~25 request |
| Chặn theo User-Agent | ❌ Không. UA rỗng, `SooskyCrawlBot/1.0`, curl mặc định — **cả ba đều trả 200 + dữ liệu đầy đủ** |
| Bắt buộc cookie/session | ❌ Không. Có `Set-Cookie: PHPSESSID` nhưng không gửi lại vẫn có đủ dữ liệu |
| Header bắt buộc | ❌ Không |
| 403 / 429 | ❌ Không gặp ở nhịp ~1 req/2–4 s. **Không dò ngưỡng** — dò ngưỡng chính là hành vi lạm dụng mà runtime P4 sinh ra để tránh |
| Rate-limit công bố | Không có trong `robots.txt` cho `User-agent: *`. Chỉ `DataForSeoBot` bị đặt `Crawl-delay: 120` |
| Hạ tầng | Không cache (`Cache-Control: no-store`), `Transfer-Encoding: chunked`, `X-Frame-Options: SAMEORIGIN` |
| Độ ổn định server | ⚠️ Yếu. Input xấu → PHP fatal error *memory exhausted* (giới hạn 128 MB, đòi 325 MB). Trang tàu nặng **250–295 KB**, phần lớn là JSON nhúng |

### ⛔ Ràng buộc robots.txt — quan trọng nhất

```
User-agent: *
Disallow: /api/          ← mọi endpoint JSON
Disallow: /tracking/  /tracking_backend/  /js/  /lib/  /index.php  /items.php
Disallow: /vessel_position_ru*  /vessel_location_full_ru.php  /request.php  /total.php  ...
```

| Đường dẫn | Robots | Ghi chú |
|---|---|---|
| `/find_vessel_{Name}_IMO-x_MMSI-y` | ✅ **Cho phép** | Trang tàu — **toàn bộ dữ liệu §4 nằm ở đây** |
| `/find_vessel.php`, `/vessels_list.php`, `/popular_vessels.php` | ✅ Cho phép | Trang tìm kiếm/danh sách |
| `/sitemap.xml` | ✅ Cho phép | 1501 URL tàu — dùng làm danh sách hạt giống |
| `api/find_ship_name.php` | ⛔ **Cấm** | Tìm theo tên (autocomplete) |
| `api/find_vessel_position_free.php` | ⛔ **Cấm** | Vị trí "tươi" |
| `api/add_ship_to_map.php`, `api/client_message.php`, `api/save_geodata.php` | ⛔ **Cấm** | |

**May mắn là mọi thứ ta cần đều nằm ở đường được phép.** Nhưng `searchByName` thì không — endpoint duy nhất bị cấm.
→ **`operations.searchByName` phải để `false`** cho ShipInfo, bất kể chức năng có tồn tại. Muốn dùng thì phải xin phép hoặc mua API.

---

## 7. Proposed minimal implementation

Chưa implement gì ở P6.1. Đề xuất hình dạng nhỏ nhất, khớp kiến trúc P3/P4/P5 đã có:

```
ShipInfoClient          → dựng URL, gọi HTTP qua SourceRequestExecutor (P4)
      ↓ HTML thô
ShipInfoParser          → hàm THUẦN: HTML → { IMOs, vesselSeoContext } đã ép kiểu
      ↓
ShipInfoProvider        → implements VesselDataProvider (P3), map sang canonical
      ↓
ObservationRecorder     → (P5, đã có, không sửa)
```

Ba việc parser **bắt buộc** làm, đều rút ra từ audit này:

1. **Vắng `var IMOs` = không tìm thấy** → `getDetails` trả `null`. Không tin HTTP status.
2. **Hiệu chỉnh timezone tường minh**: `offset = points[cuối].updated − vesselSeoContext.updated_utc`, áp cho mọi `updated`. Tự suy mỗi lần parse, không hardcode `+2`.
3. **`course === "-1"` → `null`** trước khi vào canonical.

Config runtime (P4) đề xuất — bảo thủ hơn mặc định vì trang nặng ~290 KB và server PHP mỏng manh:

```ts
[VesselSource.SHIPINFO]: { maxConcurrency: 1, minDelayMs: 3000, maxDelayMs: 8000, timeoutMs: 20000 }
```

`parserVersion` khởi đầu: `"shipinfo-embedded-json-v1"`.

**Không** tạo abstraction mới, không framework crawler chung, không queue, không event bus.

---

## 8. Recommendation

### Nên implement trước ở P6.2/P6.3

| Thứ tự | Operation | Vì sao |
|---|---|---|
| **1** | `getDetails` | Đường duy nhất có bằng chứng đầy đủ. Một request cho ra identity + particulars(một phần) + track. Map sang `ProviderDetailsResult` với **`identity` + `position`**; **bỏ `particulars`** (xem dưới) |
| **2** | `getPosition` | Dùng lại chính request đó, chỉ lấy điểm cuối. Rẻ, nhưng **giá trị thấp** vì trễ 14 h |
| — | `searchByName` | ⛔ **Không implement.** Endpoint duy nhất bị robots cấm |
| — | `scanArea` | ⛔ **Không implement.** Không có cơ chế truy vấn theo bbox |

### Trạng thái field đề xuất khi promote (P6.3, sau khi parser chạy thật)

| Nhóm | Đề xuất | Lý do |
|---|---|---|
| `mmsi`, `imo`, `name`, `vesselType` | → `CONFIRMED` | 5/5 tàu |
| `flag` | → `CONFIRMED` | 3/5, có cả code lẫn name — **giá trị mới so với VesselFinder** |
| `callsign` | → `CONFIRMED` | 4/5 |
| `builtYear`, `deadweight` | giữ `CANDIDATE` | 2/5 và 1/5 — mẫu quá nhỏ để kết luận |
| `lat`, `lng`, `speed` | → `CONFIRMED` | Có ở mọi điểm |
| `course` | → `CONFIRMED` *kèm ghi chú sentinel `-1`* | |
| `heading`, `navStatus` | → **`UNSUPPORTED`** | 0/1073 điểm. Đây là **bằng chứng vắng mặt**, không phải "chưa audit" |
| `draught`, `destination`, `eta` | → **`UNSUPPORTED`** | 0/1073 điểm |
| `grossTonnage` | → **`UNSUPPORTED`** | Không có khoá nào |
| `length`, `beam` | → **`UNSUPPORTED`** | Có dữ liệu nhưng **đảo lộn không nhất quán** (§4). Dữ liệu sai còn tệ hơn không có |
| `operations.searchByName` | → `false` | Robots cấm |
| `operations.areaScan` | → `false` | Không có cơ chế |

### Định vị lại ShipInfo trong kiến trúc

Matrix P2 hiện xếp ShipInfo là ứng viên cho **cả position lẫn details**. Audit cho thấy nên đọc lại như sau:

- **Nguồn identity/flag tốt** — bổ khuyết đúng chỗ VesselFinder yếu (`VesselFlag.code` hiện luôn null).
- **Nguồn vị trí kém** — trễ 14 h theo thiết kế. Trong bất kỳ merge policy nào tương lai, vị trí ShipInfo phải xếp **sau** mọi nguồn tươi hơn, dựa trên `sourceReceivedAt`.
- **Nguồn lịch sử track độc nhất** — ~268 điểm/tàu. Canonical model hiện **chưa có nhóm nào** biểu diễn lịch sử; nếu muốn dùng, đó là quyết định thiết kế riêng, **không thuộc P6**.

### Rủi ro lớn nhất, xếp theo mức

1. **Trễ 14 h của bản free** — không sửa được bằng kỹ thuật. Nếu P6 nhắm vị trí realtime thì ShipInfo không đáp ứng.
2. **`length`/`beam` sai không nhất quán** — map vào là bơm dữ liệu sai vào hệ thống. Không map.
3. **Timezone ẩn (UTC+2, không có offset trong chuỗi)** — sai 2 h ở mọi vị trí nếu parse ngây thơ, và có thể đổi theo DST.
4. **`robots.txt` cấm `/api/`** — chặn vĩnh viễn `searchByName`.
5. **Server PHP mỏng** — fatal error 200 với input xấu; trang 290 KB.
6. **Sitemap cũ** — tên/MMSI trong URL không đáng tin.

---

## Phụ lục · Cách tái lập

```bash
# Trang tàu (được robots cho phép)
curl -s "https://shipinfo.net/find_vessel_Agia-Doxa_IMO-9467976_MMSI-636018086" -o v.html

# Trích khối JSON nhúng
node -e 'const h=require("fs").readFileSync("v.html","utf8");
         const m=h.match(/var IMOs = (\{[\s\S]*?\});[\r\n]/);
         const o=JSON.parse(m[1]); const v=Object.values(o)[0];
         console.log({...v, points:v.points.length});'
```

Không dùng endpoint `/api/*` nào trong audit này.
