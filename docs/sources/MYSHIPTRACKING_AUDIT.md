# Rà soát nguồn MyShipTracking — giai đoạn 9.5

> Audit nguồn **TRẢ TIỀN** duy nhất trong capability matrix, để trả lời một câu: **có đáng viết client không, và nếu có thì mua cái gì?**
>
> ⚠️ Audit này đọc **TÀI LIỆU CHÍNH THỨC**, chưa gọi API. Không request nào được thực hiện, không credential nào tồn tại trong repo.
>
> Hệ quả bắt buộc: **matrix vẫn giữ 28 CANDIDATE.** Quy trình nâng CONFIRMED đòi POC trên dữ liệu thật ([SOURCE_CAPABILITY_MATRIX.md §10](../SOURCE_CAPABILITY_MATRIX.md)) — "đọc tài liệu rồi tin" là đúng thứ quy trình đó tồn tại để ngăn.

Nguồn: [api.myshiptracking.com](https://api.myshiptracking.com/) · [Vessel Status endpoint](https://api.myshiptracking.com/docs/vessel-current-position-api) · [Terms](https://api.myshiptracking.com/docs/terms)

---

## A. Tổng quan API

| | |
|---|---|
| Base URL | `https://api.myshiptracking.com/api/v2/` |
| Giao thức | REST · JSON (XML nếu đặt `Accept: application/xml`) |
| Dữ liệu | **Terrestrial AIS** — trạm bờ, **không** vệ tinh |
| Đăng ký | Một trial key mỗi tài khoản |

⚠️ **Giới hạn phủ sóng, nêu ngay đầu vì nó đổi kết luận:** tài liệu nói rõ chỉ có AIS mặt đất, và *"historical data is restricted to nearshore areas, and vessel routes may be incomplete"*. Tàu giữa đại dương có thể **không có dữ liệu** — trả tiền **không** đảm bảo có vị trí ở nơi nguồn free cũng chịu. Cả hai cùng phụ thuộc một hạ tầng AIS bờ.

---

## B. Xác thực

Hai cách, tương đương:

```
Authorization: Bearer <API_KEY>
x-api-key: <API_KEY>
```

Tên biến môi trường đề xuất khi tới lúc dùng: **`MYSHIPTRACKING_API_KEY`**.

⛔ Repo hiện **không có** biến này, và P9.5 **không** thêm. Không giá trị nào được ghi vào code, doc, fixture hay log.

⚠️ `API_KEY` đang có trong `.env.example` là auth của **HTTP server của chính bot**, hoàn toàn không liên quan.

---

## C. Endpoint

Đã audit kỹ **một** endpoint — endpoint duy nhất tầng acquisition cần:

### `GET /api/v2/vessel`

| Tham số | Kiểu | Ghi chú |
|---|---|---|
| `mmsi` | integer 9 chữ số | bắt buộc nếu không có `imo` |
| `imo` | integer 7 chữ số | bắt buộc nếu không có `mmsi` |
| `response` | `simple` (mặc định) \| `extended` | |

Các endpoint khác có tồn tại nhưng **ngoài phạm vi**: Vessels Status (bulk ≤100 tàu), Vessels In Zone, Vessels Nearby, Vessel History Track (≤3000 điểm, ≤2 năm), Vessel Search, nhóm Port, nhóm Fleet, Account Info.

⚠️ **Bulk và Zone cố ý không audit sâu.** Chúng phục vụ crawl hàng loạt; P9 là fallback **một tàu, khi free đã cạn**. Audit thứ ta không định dùng là mời gọi dùng nó.

---

## D. Hỗ trợ định danh

| Trục | Hỗ trợ |
|---|---|
| MMSI | ✅ |
| IMO | ✅ |

⚠️ Đây là **lợi thế thật** so với nguồn free: ShipFinder trả **404** cho `/ship/detail/imo/{imo}` — yêu cầu chỉ có IMO không dùng được nguồn vị trí tốt nhất của ta. MyShipTracking lấp đúng khoảng trống đó.

---

## E. Nguồn cấp được những trường nào

Cột **Giá trị trả tiền** là kết luận của §7 spec: dựa vào **nguồn free hiện có đã cấp được gì**, không dựa vào việc API có field hay không. Field API có mà free cũng có thì giá trị trả tiền bằng **không**.

Mã hoá máy đọc được: [`PaidSourceCapability.ts`](../../src/application/acquisition/PaidSourceCapability.ts).

### Nhóm A · Identity

| Canonical | Có? | Field API | Giá trị trả tiền | Vì sao |
|---|---|---|---|---|
| `mmsi` | ✅ | `mmsi` | ENRICHMENT_ONLY | 3/3 nguồn free CONFIRMED |
| `imo` | ✅ | `imo` | ENRICHMENT_ONLY | 3/3 free CONFIRMED |
| `name` | ✅ | `vessel_name` | ENRICHMENT_ONLY | 3/3 free CONFIRMED |
| `callsign` | ✅ ext | `callsign` | ENRICHMENT_ONLY | 3/3 free CONFIRMED |
| `flag` | ✅ ext | `flag`, `flag_mid` | ENRICHMENT_ONLY | 3/3 free CONFIRMED |
| `vesselType` | ✅ | `vtype`, `vessel_type` | ENRICHMENT_ONLY | 3/3 free CONFIRMED |
| `vesselTypeCode` | 🟡 | `ais_type` | ENRICHMENT_ONLY | có field, nhưng **ánh xạ sang mã canonical chưa audit** |

### Nhóm B · Position

| Canonical | Có? | Field API | Giá trị trả tiền | Vì sao |
|---|---|---|---|---|
| `lat` | ✅ | `lat` | **CRITICAL** | đường cuối khi free cạn |
| `lng` | ✅ | `lng` | **CRITICAL** | |
| `speed` | ✅ | `speed` (knots) | **CRITICAL** | |
| `course` | ✅ | `course` | **CRITICAL** | |
| `navStatus` | ✅ | `nav_status` (mã AIS) | **CRITICAL** | |
| `positionReceivedAt` | ✅ | `received` | **CRITICAL** | ISO-8601 UTC, ngữ nghĩa nguồn khai rõ |
| **`heading`** | ❌ | — | **UNSUPPORTED** | ⚠️ xem dưới |

⚠️ **Phát hiện quan trọng nhất của audit: response KHÔNG có `heading`** — cả `simple` lẫn `extended`. ShipFinder (**miễn phí**) thì CONFIRMED `heading`.

Nguồn trả tiền **thua** nguồn miễn phí ở đúng một field. Hệ quả trực tiếp: MyShipTracking **không** thay thế được ShipFinder cho nhóm vị trí đầy đủ — nó chỉ là phao khi ShipFinder không dùng được.

### Nhóm C · Particulars

| Canonical | Có? | Field API | Giá trị trả tiền | Vì sao |
|---|---|---|---|---|
| `length` | 🟡 suy | `size_a + size_b` | ENRICHMENT_ONLY | ⚠️ **không có field trực tiếp** |
| `beam` | 🟡 suy | `size_c + size_d` | ENRICHMENT_ONLY | ⚠️ như trên |
| `draught` | ✅ ext | `draught` | ENRICHMENT_ONLY | ShipFinder + VesselFinder CONFIRMED |
| `builtYear` | ✅ ext | `built` | ENRICHMENT_ONLY | ShipInfo CONFIRMED |
| `deadweight` | ✅ ext | `dwt` | ENRICHMENT_ONLY | ShipInfo CONFIRMED |
| **`grossTonnage`** | ✅ ext | `gt` | **USEFUL** | ⚠️ **0/3 nguồn free CONFIRMED** |

⚠️ `size_a..size_d` là khoảng cách từ **ăng-ten AIS** tới mũi / lái / mạn trái / mạn phải, đúng theo tài liệu:

```
size_a: Length from GPS antenna to the bow (meters)
size_b: Length from GPS antenna to the stern (meters)
size_c: Distance from GPS antenna to the port side (meters)
size_d: Distance from GPS antenna to the starboard side (meters)
```

`length = a + b`, `beam = c + d` là công thức AIS chuẩn — nhưng đó là **phép suy, chưa POC**, và nó thừa hưởng mọi sai sót khai báo AIS của tàu. Nguồn free đã CONFIRMED cả hai nên không có lý do mạo hiểm.

`grossTonnage` là **ứng viên trả tiền hợp lệ duy nhất** trong nhóm này — đúng như [ACQUISITION_POLICY.md §O.2](../ACQUISITION_POLICY.md) đã dự đoán ở P9.1.

### Nhóm D · Voyage

| Canonical | Có? | Field API | Giá trị trả tiền | Vì sao |
|---|---|---|---|---|
| `destination` | ✅ ext | `destination` | ENRICHMENT_ONLY | ShipFinder CONFIRMED |
| **`eta`** | ✅ ext | `eta` (datetime UTC) | **USEFUL** | ⚠️ xem dưới |
| `currentPort` | ✅ ext | `current_port` (+ `_id`, `_unloco`, `_country`) | USEFUL | 0/3 free CONFIRMED |
| `currentPortArrivalAt` | ✅ ext | `current_port_arr_utc` / `_local` | USEFUL | 0/3 free CONFIRMED |
| `nextPort` | ✅ ext | `next_port` + phụ | USEFUL | 0/3 free CONFIRMED |
| `nextPortEta` | ✅ ext | trường `_utc` của next_port | USEFUL | 0/3 free CONFIRMED |
| `lastPort` | ✅ ext | `last_port` + phụ | USEFUL | 0/3 free CONFIRMED |
| `lastPortDepartureAt` | ✅ ext | trường `_utc` của last_port | USEFUL | 0/3 free CONFIRMED |

⚠️ **`eta` là thứ tiền thật sự mua được.** ShipFinder cho `"07-29 07:01"` — **thiếu năm** — nên mapper P7 cố ý không map. MyShipTracking khai `eta` kiểu `datetime`, mô tả *"Estimated Time of Arrival (UTC)"*. Đây là field mà [ACQUISITION_POLICY.md §D.4](../ACQUISITION_POLICY.md) đã ghi "không nguồn free nào có, ⛔ không được kích hoạt crawl".

⚠️ Sáu field cảng ở trên có giá trị **lý thuyết**: `ResolvedVoyage` hiện **không phân xử** `currentPortArrivalAt` và `nextPortEta` (P8.4 §R.3). Mua về cũng không có chỗ chứa cho tới khi resolver mở rộng.

### Ngoài canonical

`avg_sog`, `max_sog`, `distance_covered`, `wind_knots`, `wind_direction`, `humidity`, `pressure`, `temperature`, `visibility`. Không field nào ánh xạ vào canonical model A1 — **bỏ qua**, không mở rộng model để chứa dữ liệu thời tiết.

---

## F. Ngữ nghĩa mốc thời gian

| Field | Kiểu | Ngữ nghĩa tài liệu khai |
|---|---|---|
| `received` | datetime | *"UTC timestamp when the position was received"* |
| `eta` | datetime | *"Estimated Time of Arrival (UTC)"* |
| `*_utc` / `*_local` | datetime | cặp UTC/giờ địa phương cho mốc cảng |

Ví dụ trong tài liệu: `"received": "2026-08-15T22:47:28Z"` — ISO-8601, có `Z`.

**Ánh xạ canonical:**

| Canonical | Lấy từ |
|---|---|
| `sourceReceivedAt` | `received` — **trực tiếp**, không suy |
| `fetchedAt` | đồng hồ của bot lúc gọi |

⚠️ Đây là **ưu điểm rõ ràng** so với ShipFinder: nguồn đó không khai múi giờ ở bất kỳ đâu, P7.1 phải **giả định** UTC+8 và bắt khai tường minh qua `SHIPFINDER_SOURCE_UTC_OFFSET_MINUTES`, nếu không thì **không phát nhóm position**. MyShipTracking khai `Z` — hết chuyện.

⛔ Vẫn giữ luật gốc: `sourceReceivedAt` **không bao giờ** được gán bằng `fetchedAt`. Nếu `received` vắng mặt trong một response thật thì để `null`, không mượn.

---

## G. Ngữ nghĩa lỗi

| HTTP | Ý nghĩa | Ánh xạ `SourceErrorCategory` (P4) |
|---|---|---|
| 400 | sai tham số / định danh | `PARSE_ERROR`* |
| 401 | sai/thiếu API key | `BLOCKED` |
| **402** | **không đủ credit** | `BLOCKED` ⚠️ |
| 403 | không có quyền | `BLOCKED` |
| 404 | không tìm thấy tàu | `NOT_FOUND` |
| 429 | vượt rate limit (`ERR_RATE_LIMIT`) | `RATE_LIMITED` |
| 5xx | lỗi phía nguồn | `SERVER_ERROR` |

\* 400 do ta gửi sai, không phải nguồn hỏng — nhưng P4 không có mã "lỗi của ta". Đề xuất P9.6: giữ `PARSE_ERROR` và log riêng, **không** để nó tính vào chuỗi hỏng của nguồn.

⚠️ **402 là mã đặc biệt và cần xử lý riêng.** Nó nghĩa là *hết tiền*, không phải *nguồn hỏng*. Retry nó là vô nghĩa và cooldown nó cũng sai — thứ đúng phải làm là tắt ngân sách trong `PaidBudgetSnapshot` cho tới khi người vận hành nạp thêm. Xếp chung `BLOCKED` chỉ là giải pháp tạm để P4 không retry.

⚠️ `404` **không** có nghĩa tàu không tồn tại — chỉ nghĩa AIS bờ chưa thấy nó. Giữ đúng ngữ nghĩa `NOT_FOUND` của [ACQUISITION_POLICY.md §G.1](../ACQUISITION_POLICY.md).

---

## H. Hạn mức · quota · chi phí

### Rate limit — **CÓ công bố**

| | |
|---|---|
| Trial | **90 calls/phút** |
| Standard | **2000 calls/phút** |
| Vượt | `ERR_RATE_LIMIT` (429) |

Cả hai đều **cao hơn nhiều** so với nhu cầu của P9: fallback một tàu, chỉ khi free cạn. Rate limit **không phải** ràng buộc thực tế ở đây.

### Credit — **CÓ công bố phần cơ chế**

| | |
|---|---|
| `response=simple` | **1 credit** |
| `response=extended` | **3 credit** |
| Không có kết quả | **không tính phí** ⚠️ |
| Trần một request | không quá 500 credit |
| Trial key | 2000 coin · tối đa **10 ngày** · một key mỗi tài khoản |
| Bảo vệ | hệ thống chặn tiêu quá số dư |

⚠️ *"No charge if no results returned"* là điều khoản **quan trọng**: một lần tra trượt không tốn credit. Nó làm giảm rủi ro của việc thử — nhưng **không** làm thay đổi luật gate, vì gọi trượt vẫn tốn thời gian của người dùng và vẫn có thể trả kết quả rỗng có tính phí trong các ca biên.

### Giá tiền — **KHÔNG công bố**

> **UNKNOWN — VERIFY IN ACCOUNT DASHBOARD.**

Không có bảng giá công khai cho credit hay gói tháng. Datarade ghi rõ nhà cung cấp chưa công bố giá dịch vụ dữ liệu và phải liên hệ trực tiếp.

⛔ P9.5 **không đoán**. Đây là lý do `PaidBudgetSnapshot.remainingCalls = null` được thiết kế thành **DENY**, không phải "chắc là còn".

---

## I. Code sẵn có trong repo

Đã quét toàn repo (`myshiptracking` / `MST` / `api.myshiptracking` / `apiKey`, loại trừ `node_modules` và `dist`):

| Hạng mục | Trạng thái |
|---|---|
| API client | **DOES NOT EXIST** |
| Provider | **DOES NOT EXIST** |
| DTO / parser / mapper | **DOES NOT EXIST** |
| Endpoint string | **DOES NOT EXIST** |
| Response mẫu / fixture | **DOES NOT EXIST** |
| Biến môi trường | **DOES NOT EXIST** |

Tất cả những gì tồn tại là **ba khai báo, không dòng nào chạm mạng**:

| Nơi | Nội dung |
|---|---|
| `VesselSource.ts` | `MYSHIPTRACKING: "myshiptracking"` |
| `sourceCapabilityMatrix.ts` | 7 operation `true`, **28 field CANDIDATE**, `costType: PAID`, `enabled: true`, `defaultPriority: 900` |
| `SourceRuntimeConfig.ts` | override `minDelayMs: 0`, `maxDelayMs: 0`, `maxRetries: 1` (API trả tiền, không phải crawl web nên không áp nhịp nghỉ lịch sự) |

**Không có gì để tái sử dụng. Cũng không có gì phải gỡ.**

---

## J. Client tối thiểu đề xuất (cho P9.6, nếu GO)

Đúng một endpoint, đúng một hình dạng:

```
GET /api/v2/vessel?mmsi={mmsi}&response=extended
GET /api/v2/vessel?imo={imo}&response=extended
Authorization: Bearer ${MYSHIPTRACKING_API_KEY}
```

Vì sao **luôn** `extended` dù tốn 3 credit thay vì 1: `simple` **không** có `gt`, `eta`, cảng — tức là không có bất kỳ field nào thuộc diện *đáng tiền*. Một lần `simple` chỉ cho lại thứ nguồn free đã có, cộng thêm `heading` bị thiếu. Trả 1 credit cho thứ vô dụng đắt hơn trả 3 credit cho thứ dùng được.

Cần POC xác minh trước khi tin, **theo thứ tự ưu tiên**:

1. `received` có thật là ISO-8601 UTC trong response thật không, và tuổi thực tế bao nhiêu.
2. `heading` có thật sự vắng mặt không (audit này khẳng định là có, nhưng đó là đọc tài liệu).
3. `size_a..d` có đủ để suy `length`/`beam` không.
4. `eta` có năm trong response thật không.
5. `gt` có giá trị thật cho tàu hàng rời thông thường không.
6. Response khi tàu ngoài vùng phủ AIS bờ — 404 hay 200 với trường rỗng?

---

## K. Kết luận

# 🟡 DÙNG ĐƯỢC, NHƯNG CÓ GIỚI HẠN

**GO vì** — có ba thứ nguồn free thật sự không cấp được, và chúng đã đo được chứ không phải suy đoán:

1. **Tra bằng IMO.** ShipFinder 404 với IMO; yêu cầu chỉ có IMO hiện không dùng được nguồn vị trí tốt nhất.
2. **`eta` có năm.** Nguồn free duy nhất có ETA cho chuỗi thiếu năm nên canonical bỏ.
3. **`grossTonnage`.** 0/3 nguồn free CONFIRMED.

Cộng thêm `received` khai UTC tường minh — không phải giả định múi giờ như ShipFinder.

**LIMITATIONS — năm điều, tất cả đều đổi cách dùng:**

| # | Giới hạn | Hệ quả |
|---|---|---|
| 1 | **Không có `heading`** | không thay thế được ShipFinder cho vị trí đầy đủ; chỉ là phao |
| 2 | **Chỉ AIS mặt đất** | tàu xa bờ có thể vẫn không có dữ liệu — trả tiền không mua được vùng phủ |
| 3 | **Giá UNKNOWN** | không lập được ngân sách thật; `remainingCalls = null` phải là DENY |
| 4 | **`length`/`beam` phải suy** từ `size_a..d` | phép suy chưa POC; free đã CONFIRMED nên không dùng |
| 5 | **Toàn bộ 28 field vẫn CANDIDATE** | mọi kết luận ở đây là đọc tài liệu, chưa xác minh |

**Phạm vi được phép của paid, hẹp có chủ ý:**

> Chỉ khi **vị trí** thiếu và mọi nguồn free đã cạn, **hoặc** khi cần đích danh `eta` / `grossTonnage` / thông tin cảng — và luôn với `allowPaidFallback = true` tường minh cùng ngân sách đã biết.

⛔ **KHÔNG** dùng paid cho: `heading` (không có) · `name`/`callsign`/`flag`/`vesselType` (free có đủ) · `length`/`beam`/`draught`/`builtYear`/`deadweight` (free có) · `destination` (ShipFinder có) · crawl hàng loạt · làm nguồn mặc định.

Luật này đã được mã hoá và khoá bằng test: [`PaidSourceCapability.ts`](../../src/application/acquisition/PaidSourceCapability.ts) · [`PaidFallbackGate.ts`](../../src/application/acquisition/PaidFallbackGate.ts).
