# Rà soát nguồn ShipFinder — giai đoạn 7.1 (khảo sát)

> **Site:** `https://www.shipfinder.com` — vận hành bởi **Shipxy**. Xác định bằng probe, không đoán theo tên.
> **Ngày audit:** 2026-08-14, khoảng 15:43–15:52 UTC.
> **Phạm vi:** 4 tàu + vài request chẩn đoán, ~30 request tổng, giãn 2–4 s. Không bulk crawl, không quét bản đồ, không ghi DB.
> **Matrix:** ShipFinder giữ nguyên `CANDIDATE`. Audit chỉ tạo bằng chứng.

Tàu dùng để audit — cố ý **trùng** với ShipInfo để so trực tiếp:

| Tàu | MMSI | IMO | Vì sao chọn |
|---|---|---|---|
| AGIA DOXA | 636018086 | 9467976 | Tàu chuẩn của POC ShipInfo |
| QI XIAN LING | 414708000 | 9656864 | ShipInfo **đảo** kích thước tàu này |
| QUEEN OF THE WEST | 367452710 | 8642957 | Đang chạy (10.6 kn), có flag/year ở ShipInfo |
| — | 232003657 | — | Trường hợp không tìm thấy |

---

## Tóm tắt cho người ra quyết định

# ✅ DÙNG ĐƯỢC, NHƯNG CÓ GIỚI HẠN

ShipFinder giải quyết **đúng** vấn đề mà P7 sinh ra để giải quyết.

| | ShipInfo | ShipFinder |
|---|---|---|
| Tuổi vị trí | **~14 giờ** (khoá có chủ ý) | **~30 giây – 37 phút** |
| Heading | ❌ 0/1073 điểm | ✅ có |
| Nav status | ❌ không có khoá | ✅ `Moored`, `Under way using engine` |
| Draught | ❌ 0/1073 điểm | ✅ có |
| Destination / ETA | ❌ 0/1073 điểm | ✅ có |
| Kích thước tàu | ⛔ **đảo không nhất quán** | ✅ đúng chiều trên cả 3 tàu |
| Lookup | MMSI + IMO | **chỉ MMSI** |
| GT / DWT / năm đóng | 1–2 / 5 tàu | ❌ nằm sau API ký chữ ký |

Ba lý do GO:
1. **Vị trí tươi hơn ~450 lần.** Đây là điều ShipInfo về bản chất không làm được.
2. **Thêm 5 field mà ShipInfo không có**: heading, navStatus, draught, destination, ETA.
3. **Sửa được lỗi dữ liệu đã biết của ShipInfo**: Qi Xian Ling ở ShipInfo là `length=29 / width=180` (bất khả thi), ShipFinder cho `180 / 29` — đúng.

Ba giới hạn (nên là "WITH LIMITATIONS", không phải GO thuần):
1. **Chỉ tra được bằng MMSI.** `/ship/detail/imo/...` trả 404.
2. **Múi giờ suy luận, không được khai báo** — xem [Timestamp semantics](#timestamp-semantics).
3. **GT / DWT / năm đóng nằm sau API ký chữ ký** — không lấy được nếu không tái tạo chữ ký, và ta **không** làm việc đó.

---

## Xác định danh tính nguồn

| | |
|---|---|
| Domain | `https://www.shipfinder.com` (`shipfinder.com` → 308 → `www.`) |
| Vận hành | Shipxy (bundle JS đều tên `Shipxy.*.js`, `elane.*.js`) |
| Nền tảng | ASP.NET MVC 4 (`X-AspNetMvc-Version: 4.0`) |
| Tự mô tả | *"Free Satellite AIS Ship Tracking \| Global Real-Time Marine traffic"* |
| Cloudflare | ❌ không có |

**robots.txt** — cực kỳ thoáng, ngược hẳn ShipInfo:

```
User-agent: *
Allow: /
Sitemap: https://www.shipfinder.com/sitemap.xml
```

**Không một đường dẫn nào bị cấm.** Không có `Crawl-delay`. Sitemap gồm 26 file `sitemap-vessels-N.xml.gz`, mỗi file 30 000 URL → **~780 000 tàu**, tất cả theo dạng `/ship/detail/mmsi/{mmsi}`.

### Hai domain KHÁC, không phải mục tiêu

| Domain | Trạng thái | Xử lý |
|---|---|---|
| `shipfinder.co` | **403, Cloudflare challenge** (`Cf-Mitigated: challenge`) | Site khác, không liên quan AIS của dự án. **Không đụng, không bypass.** |
| `shipfinder.net` | Trang "Coming Soon" đỗ tên miền | Bỏ qua |

### Ranh giới free / trả tiền

| Nội dung | Truy cập |
|---|---|
| Vị trí + lý lịch cơ bản trên trang chi tiết | ✅ **công khai**, không cần đăng nhập, không cần cookie |
| Port Call (lịch sử cập cảng) | 🔒 *"Please log in to view the complete Port Call records"* |
| Ship Event | 🔒 *"Ship Event is a premium feature. Please upgrade your plan"* |
| API JSON (`/Ship/GetShip`, `/ship/GetIHSData`, …) | 🔒 **ký chữ ký** (xem [Transport](#transport)) |
| `/ais-data-api` | Gói API thương mại |

Nút *"Unlock Live AIS Position"* có trên trang, **nhưng** vị trí hiển thị công khai đã tươi ~2 phút — nút này nhiều khả năng bán AIS vệ tinh / tần suất cao hơn, **không** phải khoá vị trí cơ bản. Không xác minh thêm vì đụng tới ranh giới trả tiền.

---

## Bảng cách tra cứu

| Operation | Supported | Mechanism | Evidence |
|---|---|---|---|
| **MMSI lookup** | ✅ **Có** | `GET /ship/detail/mmsi/{mmsi}` → HTML server-render | 3/3 tàu trả đúng dữ liệu. Không cookie, không UA, không session |
| **IMO lookup** | ❌ **Không** | — | `/ship/detail/imo/9467976` → **404**. Đặt IMO vào khe mmsi (`/mmsi/9467976`) → HTTP 200 nhưng **mọi field là `-`** |
| **Name search** | ⚠️ **Chỉ qua API ký chữ ký** | `POST /Home/Suggest` | Không nằm trong robots cấm, nhưng đòi header chữ ký → không truy cập được nếu không tái tạo chữ ký. **Không làm.** |

Chi tiết đã xác minh:
- **Method** `GET`, định danh nằm trong **path**, không query param.
- **Redirect**: không có. 200 trực tiếp.
- **Cookie/session**: **không cần**. Site có set `token=...` và `culture=en-US` ở trang chủ, nhưng trang chi tiết trả đủ dữ liệu với `curl` trần không cookie.
- IMO **có mặt** trong dữ liệu trả về, chỉ là **không dùng để tra** được.

### Không tìm thấy = HTTP 200, mọi field là `-`

`/ship/detail/mmsi/232003657` → HTTP 200, 58 KB, layout đầy đủ, nhưng `IMO`, `MMSI`, `Lat`, `Lon`, `Last update`… **tất cả là `"-"`**.

Giống hệt bài học ShipInfo: **status code vô dụng để phát hiện không-có-tàu**. Provider sau này phải nhận diện bằng nội dung (`MMSI === "-"`), không phải bằng HTTP status.

---

## Cách truyền dữ liệu

| Mechanism | Used? | Notes |
|---|---|---|
| **Server-rendered HTML** | ✅ **nguồn chính** | **Toàn bộ field lõi nằm sẵn trong HTML.** Không cần JS, không cần trình duyệt |
| DOM label → value | ✅ | Cấu trúc `Ship Info` với cặp nhãn/giá trị: `IMO`→`9467976`, `Lat`→`33-44.980 N`… |
| Meta tags | ✅ phụ | `og:description` lặp lại IMO/MMSI/Call Sign |
| Embedded JSON | ❌ **không có** | Khác hẳn ShipInfo — không có `var X = {...}` nào mang dữ liệu tàu |
| XHR / JSON API | ⚠️ có nhưng **bị khoá** | `POST /Ship/GetShip`, `/Ship/GetVoyage`, `/ship/GetIHSData`, `/ship/getshipevent`, `/Ship/GetSimilarShip` |
| WebSocket / SSE | ❌ không thấy | |
| Binary / map tiles | — | Không audit (không thuộc phạm vi tra một tàu) |

### API JSON bị khoá bằng chữ ký

```
POST /Ship/GetShip   body: mmsi=636018086
→ {"status":401,"msg":"Unauthorized"}
```

401 **kể cả khi** đã có cookie `token` lấy từ trang chủ. Đọc `Content/js/base.js` cho thấy lý do:

```js
setRequestHeader("s", gst.sign)        // chữ ký
setRequestHeader("t", gst.timestamp)   // dấu thời gian
```

kèm `Content/js/lib/elane.md5.min.js` → cơ chế ký MD5 phía client.

**Đây là rào chống tự động hoá có chủ ý của nhà vận hành. Audit này CHỈ ghi nhận, KHÔNG tái tạo chữ ký, KHÔNG xây workaround.** May mắn là **không cần**: HTML server-render đã có mọi thứ trừ GT/DWT/năm đóng.

`/VerifyCode/VerifyCode` tồn tại trong bundle → có CAPTCHA ở đâu đó trên site, nhưng **không gặp** trên đường trang chi tiết.

---

## Bằng chứng về các trường lấy được

Tất cả từ HTML server-render của `/ship/detail/mmsi/{mmsi}`, khối `Ship Info`.

| Trường chuẩn | Có không | Nằm ở đâu trong nguồn | Bằng chứng |
|---|---|---|---|
| `identity.mmsi` | ✅ 3/3 | nhãn `MMSI` | `636018086` |
| `identity.imo` | ✅ 3/3 | nhãn `IMO` | `9467976`. **Có** trong dữ liệu nhưng **không tra** được bằng nó |
| `identity.name` | ✅ 3/3 | `<title>` / `og:title` / H1 | `AGIA DOXA` |
| `identity.callsign` | ✅ 3/3 | nhãn `Call Sign` | `D5OC7`, `BRNX`, `WDF4506` — **3/3**, tốt hơn ShipInfo (4/5) |
| `identity.flag` | ⚠️ 3/3 nhưng **khác định dạng** | câu mô tả *"sailing under the flag of LBR"* | Mã **3 ký tự** (`LBR`/`CHN`/`USA`), ShipInfo dùng **2 ký tự** (`LR`). Cần bảng quy đổi; canonical `VesselFlag.code` chưa quy định độ dài |
| `identity.vesselType` | ✅ 3/3 | nhãn `Type` | `Cargo ship`, `Passenger ship` — **thô hơn** ShipInfo (`Bulk Carrier`) |
| `identity.vesselTypeCode` | ❌ | — | Không có mã AIS số |
| `position.lat` | ✅ 3/3 | nhãn `Lat` | `33-44.980 N` — **độ + phút thập phân (DDM)**, không phải decimal degrees |
| `position.lng` | ✅ 3/3 | nhãn `Lon` | `118-12.537 W` |
| `position.speed` | ✅ 3/3 | nhãn `Speed` | `0 kn`, `10.6 kn` — có đơn vị trong chuỗi |
| `position.course` | ✅ 3/3 | nhãn `Course` | `0.9 °`, `304.1 °`, `97.5 °` |
| `position.heading` | ✅ 2/3 | nhãn `Heading` | `58.0 °`, `349.0 °`; tàu thứ 3 = `Unknown` (sentinel). **ShipInfo: 0/1073** |
| `position.navStatus` | ✅ 3/3 | nhãn `Status` | `Moored`, `Under way using engine` — **đúng từ vựng AIS**. ShipInfo không có |
| `position.receivedAt` | ✅ 3/3 | nhãn `Last update` | `2026-08-14 23:45:34` — ⚠️ múi giờ không khai báo |
| `particulars.length` | ✅ 3/3 | nhãn `Length` | `179 m`, `180 m`, `67 m` — **đúng chiều** (xem [Anomalies](#data-quality-anomalies)) |
| `particulars.beam` | ✅ 3/3 | nhãn `Width` | `29 m`, `29 m`, `16 m` |
| `particulars.draught` | ✅ 3/3 | nhãn `Draught` | `5.9 m`, `10.5 m`, `2.5 m`. **ShipInfo: 0/1073** |
| `particulars.builtYear` | ❌ | — | Không có trên trang. Nằm sau `/ship/GetIHSData` (ký chữ ký) |
| `particulars.deadweight` | ❌ | — | Như trên |
| `particulars.grossTonnage` | ❌ | — | Như trên |
| `voyage.destination` | ✅ 3/3 | nhãn `Dest` | `LONG BEACH,  US`, `VERACRUZ,  MX`, `RICHLAND, WA.` — chuỗi thô do thuyền viên gõ |
| `voyage.eta` | ⚠️ 3/3 nhưng **thiếu năm** | nhãn `ETA` | `07-29 07:01`, `08-05 00:00` — **không có năm**, xem Anomalies |
| `voyage.currentPort` / `nextPort` / `lastPort` | 🔒 | mục Port Call | Cần **đăng nhập**; mục Ship Event cần gói **premium** |
| Track history | 🔒 | — | Không public trên trang chi tiết. `/Ship/GetHistoryVoyage` tồn tại nhưng bị ký chữ ký |

---

## Độ tươi của vị trí

Đây là lý do P7 tồn tại.

Múi giờ trang **không được khai báo**; các mốc dưới đây quy đổi theo **UTC+8** (lập luận ở [Timestamp semantics](#timestamp-semantics)).

| Tàu | `Last update` (như trang hiển thị) | Quy đổi UTC | Lúc audit (UTC) | **Tuổi** |
|---|---|---|---|---|
| AGIA DOXA `636018086` | `2026-08-14 23:45:34` | `15:45:34Z` | `15:47:26Z` | **≈ 1 phút 52 giây** |
| QI XIAN LING `414708000` | `2026-08-14 23:47:00` | `15:47:00Z` | `15:47:31Z` | **≈ 31 giây** |
| QUEEN OF THE WEST `367452710` | `2026-08-14 23:10:46` | `15:10:46Z` | `15:47:36Z` | **≈ 36 phút 50 giây** |
| `232003657` | `-` | — | — | không tìm thấy |

**Bằng chứng cập nhật thời gian thực:** cùng tàu AGIA DOXA, hai lần tải cách nhau 2 phút 28 giây:

```
15:44:57Z  ->  Last update 23:42:34   Lat 33-44.979 N
15:47:25Z  ->  Last update 23:45:34   Lat 33-44.980 N
```

Mốc thời gian tiến **3 phút 00 giây**, toạ độ đổi. Đây là dữ liệu sống, không phải ảnh chụp tĩnh.

Vị trí công khai **không** bị khoá sau paywall: nút *"Unlock Live AIS Position"* tồn tại nhưng dữ liệu hiển thị đã tươi ~2 phút.

---

## So sánh với ShipInfo

Đo **cùng ngày, cách nhau ~2 phút**, cùng 3 tàu. ShipInfo đo bằng chính `ShipInfoProvider` của dự án (`getPosition`), lấy `sourceReceivedAt` thật.

| Tàu | Tuổi dữ liệu ShipInfo | Tuổi dữ liệu ShipFinder | Nguồn tốt hơn |
|---|---|---|---|
| AGIA DOXA `636018086` | **14.49 h** | **≈ 1.9 phút** | 🏆 ShipFinder (~460×) |
| QI XIAN LING `414708000` | **14.02 h** | **≈ 31 giây** | 🏆 ShipFinder (~1600×) |
| QUEEN OF THE WEST `367452710` | **14.18 h** | **≈ 36.8 phút** | 🏆 ShipFinder (~23×) |

Dữ liệu thô ShipInfo (đo lúc `2026-08-14T15:49:50Z`):

```
636018086  sourceReceivedAt=2026-08-14T01:20:06Z  age=14.49h
414708000  sourceReceivedAt=2026-08-14T01:48:41Z  age=14.02h
367452710  sourceReceivedAt=2026-08-14T01:38:49Z  age=14.18h
```

Độ trễ 14 giờ của ShipInfo là **có chủ ý** (`fresh_locked: true`, `position_delay_hours: 14`) — không phải sự cố nhất thời. ShipFinder không có cơ chế trễ tương đương trên đường công khai.

### Chồng chéo và bổ sung

| Field | ShipInfo | ShipFinder | Ghi chú |
|---|---|---|---|
| `heading` | ❌ | ✅ | ShipFinder mở khoá field ShipInfo không bao giờ có |
| `navStatus` | ❌ | ✅ | |
| `draught` | ❌ | ✅ | |
| `destination` / `eta` | ❌ | ✅ | ETA thiếu năm |
| `length` / `beam` | ⛔ đảo, không dùng được | ✅ đúng chiều | |
| `builtYear` / `deadweight` | ✅ (1–2/5 tàu) | ❌ (sau API ký) | **ShipInfo vẫn hơn ở đây** |
| `grossTonnage` | ❌ | ❌ | Cả hai đều không |
| `vesselType` | `Bulk Carrier` | `Cargo ship` | ShipInfo **mịn hơn** |
| `flag` | `LR` (2 ký tự) | `LBR` (3 ký tự) | Khác định dạng |
| Lookup theo IMO | ✅ | ❌ | ShipInfo hơn |
| Track history | ✅ ~270 điểm công khai | 🔒 khoá | ShipInfo hơn |

→ Hai nguồn **bổ sung** nhau, không thay thế. ShipFinder cho vị trí; ShipInfo giữ vai trò lý lịch (năm đóng, DWT, loại tàu mịn, tra theo IMO).

---

## Ý nghĩa của mốc thời gian

| Trường | Định dạng | Múi giờ |
|---|---|---|
| `Last update` | `2026-08-14 23:45:34` | ⚠️ **không khai báo** |
| `ETA` | `07-29 07:01` | ⚠️ **không khai báo, và không có NĂM** |

**Không tìm thấy** bất kỳ nhãn `UTC` / `GMT` / `+08` / tên múi giờ nào trên trang.

### Suy luận UTC+8 — và cơ sở

1. **Lập luận bất khả thi.** Lúc audit là `15:47:25Z`; trang ghi `Last update 23:47:00`. Nếu là UTC thì mốc "cập nhật lần cuối" nằm **8 giờ trong tương lai** — không thể. Lệch đúng **8 giờ chẵn**.
2. **Kiểm chứng bằng tốc độ trôi.** Hai lần tải cách 2 phút 28 giây, mốc trang tiến 3 phút 00 giây → cùng nhịp đồng hồ, chỉ khác hằng số offset.
3. **Bối cảnh.** Shipxy là nhà vận hành Trung Quốc; CST = UTC+8.
4. **Điểm cộng so với ShipInfo:** Trung Quốc **không có giờ mùa hè**, nên +8 ổn định quanh năm — trong khi offset của ShipInfo (+2h) là giờ mùa hè châu Âu và **sẽ đổi** vào mùa đông.

⚠️ **Nhưng đây vẫn là SUY LUẬN, không phải hợp đồng.** Không có mỏ neo tự khai như `vesselSeoContext.updated_utc` của ShipInfo để tự suy offset mỗi lần parse. Nếu site đổi múi giờ hiển thị theo cookie `culture` hoặc theo IP, mọi mốc sẽ lệch **hàng giờ mà không có dấu hiệu nào**.

Việc P7.2 cần làm trước khi tin mốc thời gian: kiểm cookie `culture` có đổi múi giờ hiển thị không, và cân nhắc một kiểm tra vệ sinh (mốc không được nằm ở tương lai; lệch quá N giờ thì từ chối).

### ETA thiếu năm

`07-29 07:01` — không có năm. Với tàu AGIA DOXA, ETA `07-29` nằm **trước** ngày audit (14/08), nên có thể là ETA cũ chưa cập nhật của năm nay, hoặc năm sau. **Không suy đoán được.** P7.2 hoặc bỏ ETA, hoặc chỉ nhận khi suy được năm một cách an toàn.

---

## Những bất thường về chất lượng dữ liệu

1. **Toạ độ ở dạng DDM, không phải decimal degrees.**
   `33-44.980 N` = 33° 44.980′ = `33.749667`. `118-12.537 W` = `-118.208950`.
   Parser **bắt buộc** phải chuyển đổi; đọc thẳng `33-44.980` thành số sẽ ra rác. (Đối chiếu: ShipInfo cho thẳng `33.74833` cho cùng tàu — lệch nhỏ vì cách nhau 14 giờ.)

2. **✅ Kích thước tàu ĐÚNG CHIỀU — sửa được lỗi của ShipInfo.**

   | Tàu | ShipInfo | ShipFinder | Thực tế |
   |---|---|---|---|
   | AGIA DOXA | 179 / 29 ✅ | 179 / 29 ✅ | khớp |
   | QI XIAN LING | **29 / 180** ⛔ | **180 / 29** ✅ | ShipFinder đúng |
   | QUEEN OF THE WEST | 67 / 16 ✅ | 67 / 16 ✅ | khớp |

   3/3 tàu đúng chiều, kể cả tàu mà ShipInfo sai. Vẫn nên kiểm trên mẫu lớn hơn ở P7.2 trước khi CONFIRMED.

3. **Sentinel `Unknown` cho heading** (QUEEN OF THE WEST). Phải map thành thiếu dữ liệu, không phải chuỗi `"Unknown"`.

4. **Không tìm thấy = HTTP 200 + mọi field `"-"`.** Dấu gạch ngang cũng là sentinel: `Draught: "-"` không phải mớn nước bằng 0.

5. **Đơn vị nằm TRONG chuỗi giá trị**: `179 m`, `10.6 kn`, `0.9 °`, `5.9 m`. Phải bóc đơn vị. Mặt tốt: đơn vị **tường minh** (mét, knot, độ) — không mơ hồ như feet/mét.

6. **Mã cờ 3 ký tự** (`LBR`) vs ShipInfo 2 ký tự (`LR`). Hai nguồn cùng field `flag.code` sẽ **không so sánh trực tiếp được** nếu không chuẩn hoá — đây là việc resolver phải xử lý.

7. **Khoảng trắng kép trong destination**: `"LONG BEACH,  US"`. Cần gộp khoảng trắng.

8. **`Course 0.9°` trong khi `Heading 58.0°`** ở tàu đang neo. Không phải lỗi — course vô nghĩa khi speed = 0 kn. Nhưng nhắc lại: **course ≠ heading**, không được suy cái này từ cái kia.

9. **Sitemap khai ~780 000 URL** (26 file × 30 000). Nhiều MMSI khởi đầu `1000000xx` — dải không hợp lệ, giống rác. Không kiểm sâu.

10. **Cùng giá trị trả về trong 3 request liên tiếp** (khác UA) → có cache ngắn phía server. Không ảnh hưởng, nhưng đừng kỳ vọng mỗi request là một lần đọc mới.

---

## Cơ chế chặn bot và giới hạn tần suất

Chỉ ghi nhận. **Không dò ngưỡng** — dò ngưỡng chính là hành vi lạm dụng mà crawl runtime P4 sinh ra để tránh.

| Hạng mục | Quan sát trên trang chi tiết |
|---|---|
| Cloudflare | ❌ không (`Server` không phải cloudflare; `shipfinder.co` mới có, là site khác) |
| CAPTCHA | ❌ không gặp. `/VerifyCode/VerifyCode` có trong bundle → tồn tại ở nơi khác |
| Chặn theo User-Agent | ❌ không. UA rỗng, `SooskyCrawlBot/1.0`, curl mặc định — **cả ba đều 200, 59 730 B, dữ liệu đầy đủ** |
| Bắt buộc cookie/session | ❌ không. Có set `token`, `culture` nhưng không gửi lại vẫn đủ dữ liệu |
| Đăng nhập | ❌ cho vị trí + lý lịch. ✅ **bắt buộc** cho Port Call |
| Paywall | ✅ cho Ship Event (*"premium feature"*) |
| 403 / 429 | ❌ không gặp trong ~30 request / ~9 phút ở nhịp 2–4 s |
| Header rate-limit | ❌ không thấy |
| robots.txt | `Allow: /` — không cấm gì, không `Crawl-delay` |
| **Ký chữ ký cho API JSON** | ✅ **có** — header `s` + `t`, MD5 phía client. 401 nếu thiếu |

**Kết luận truy cập:** đường HTML công khai **không** có rào chống bot. Rào duy nhất nằm ở API JSON, và ta **không cần** nó cho các field lõi. Không có gì phải bypass.

---

## Đánh giá độ ổn định

| Mechanism | Đánh giá | Lý do |
|---|---|---|
| HTML server-render, bóc theo **nhãn** (`IMO`, `Lat`, `Speed`…) | **MODERATE** | Không phụ thuộc CSS class sinh tự động — ổn hơn selector class. Nhưng nhãn là **tiếng Anh** và site có cookie `culture`; đổi ngôn ngữ là parser mù. Nên ghim `culture=en-US` và coi nhãn là hợp đồng |
| URL `/ship/detail/mmsi/{mmsi}` | **STABLE** | Được khai trong sitemap chính thức, ~780 k URL, phục vụ SEO → nhà vận hành có động cơ giữ nguyên |
| Meta `og:description` (IMO/MMSI/Call Sign) | **STABLE** | Dự phòng tốt cho identity nếu bảng đổi |
| Định dạng DDM của toạ độ | **MODERATE** | Ổn định về cấu trúc nhưng phải chuyển đổi; đổi sang decimal sẽ làm hỏng parser nếu không phòng bị |
| Suy luận múi giờ UTC+8 | **FRAGILE** | Không khai báo ở đâu, không có mỏ neo tự suy như ShipInfo. Rủi ro cao nhất của nguồn này |
| API JSON `/Ship/*` | **FRAGILE + bị khoá** | Riêng tư, không tài liệu, ký chữ ký. **Không dùng** |

So với ShipInfo: ShipInfo có JSON nhúng (parse **sạch hơn**) nhưng dữ liệu **cũ 14 giờ**. ShipFinder phải bóc DOM (bẩn hơn) nhưng dữ liệu **tươi theo phút**. Với mục tiêu vị trí thì đánh đổi này đáng.

---

## Đề xuất bản hiện thực tối giản

Chỉ đề xuất. **Không implement ở P7.1.** Khuôn y hệt ShipInfo, tái dùng P3/P4/P5, không framework mới:

```
ShipFinderClient    -> dựng URL /ship/detail/mmsi/{mmsi}, GET qua SourceRequestExecutor (P4)
       ↓ HTML
ShipFinderParser    -> hàm THUẦN: bóc cặp nhãn/giá trị trong khối "Ship Info" -> raw DTO
       ↓ raw DTO (giữ "179 m", "33-44.980 N", "Unknown", "-")
ShipFinderMapper    -> DDM->decimal, bóc đơn vị, sentinel -> null, quy đổi múi giờ
       ↓ canonical
ShipFinderProvider  -> implements VesselDataProvider (P3)
```

Năm việc parser/mapper **bắt buộc** làm, rút ra từ audit này:

1. **`MMSI === "-"` ⇒ không tìm thấy.** Không tin HTTP status.
2. **Chuyển DDM → decimal degrees**, kèm dấu theo `N/S`, `E/W`.
3. **Sentinel → null**: `"Unknown"` (heading), `"-"` (mọi field).
4. **Bóc đơn vị** khỏi `"179 m"`, `"10.6 kn"`, `"0.9 °"`.
5. **Múi giờ**: cộng offset **tường minh** + kiểm vệ sinh (mốc không được ở tương lai). Nếu kiểm thất bại → **không phát ra vị trí**, giống cách ShipInfo xử lý khi thiếu mỏ neo.

Config runtime P4 đề xuất (bảo thủ, trang 59 KB nhẹ hơn ShipInfo nhiều):
`concurrency 1 · delay 3–8 s · timeout 15 s · maxRetries 1 · cooldown 15 phút`

`parserVersion` khởi đầu: `"shipfinder-ssr-labels-v1"`.

---

## Khuyến nghị cuối cùng

# DÙNG ĐƯỢC, NHƯNG CÓ GIỚI HẠN

### P7.2 nên implement `getPosition` TRƯỚC

Vị trí là giá trị áp đảo và duy nhất mà ShipInfo không thể cho: **giây/phút thay vì 14 giờ**. Một request `/ship/detail/mmsi/{mmsi}` cho trọn nhóm Position: `lat`, `lng`, `speed`, `course`, `heading`, `navStatus`, `receivedAt`.

Thứ tự đề xuất:

| # | Operation | Lý do |
|---|---|---|
| **1** | `getPosition` | Lý do tồn tại của P7. 7/7 field nhóm Position đều có |
| **2** | `getDetails` | Cùng một request, thêm identity + `length`/`beam`/`draught` + voyage |
| — | `searchByName` | ❌ **không** — chỉ có qua API ký chữ ký |
| — | `scanArea` | ❌ **không** — không có truy vấn theo bbox trên đường công khai |

### Phải giải quyết trước khi CONFIRMED bất kỳ field nào

1. **Xác nhận múi giờ.** Rủi ro lớn nhất. Kiểm cookie `culture`, cân nhắc kiểm vệ sinh "không ở tương lai".
2. **Kiểm `length`/`beam` trên mẫu lớn hơn** (10–15 tàu). 3/3 đúng là tín hiệu tốt, chưa phải bằng chứng đủ — nhất là khi ShipInfo đã dạy rằng nguồn có thể sai không nhất quán.
3. **Quyết định về ETA thiếu năm** — nhiều khả năng nên bỏ.
4. **Chuẩn hoá mã cờ** 3 ký tự ↔ 2 ký tự của ShipInfo.

### Vai trò hai nguồn

**Không** thay thế ShipInfo. Hai nguồn bổ sung nhau:
- **ShipFinder** → vị trí + trạng thái hành hải + mớn nước + chuyến đi
- **ShipInfo** → năm đóng, DWT, loại tàu mịn hơn, tra theo IMO, lịch sử track công khai

Đây chính là tình huống mà resolver đa nguồn sinh ra để xử lý — và resolver **vẫn chưa tồn tại**.

---

## Phụ lục · Cách tái lập

```bash
# Trang tàu (robots Allow: /, không cần cookie/UA)
curl -s "https://www.shipfinder.com/ship/detail/mmsi/636018086" -o v.html

# Dữ liệu nằm trong DOM theo cặp nhãn/giá trị, không phải JSON nhúng
node -e 'const h=require("fs").readFileSync("v.html","utf8")
  .replace(/<script[\s\S]*?<\/script>/gi," ");
 const t=h.replace(/<[^>]+>/g,"\n").split("\n").map(s=>s.trim()).filter(Boolean);
 const i=t.indexOf("Ship Info");
 console.log(t.slice(i,i+34).join(" | "));'
```

Không gọi endpoint `/Ship/*` nào trong audit này (đều bị ký chữ ký).
