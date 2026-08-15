# SHIPINFO_DISCOVERY_AUDIT — Phase 10.2

> Audit `https://shipinfo.net/vessels_list.php` để trả lời: có dùng được làm **A · live discovery** và/hoặc **B · bootstrap vessel universe** không?
>
> Tiền đề: [GLOBAL_DISCOVERY_ARCHITECTURE.md](../GLOBAL_DISCOVERY_ARCHITECTURE.md) · [SHIPINFO_AUDIT.md](./SHIPINFO_AUDIT.md) (P6.1) · [CRAWL_RUNTIME.md](../CRAWL_RUNTIME.md)
>
> **P10.2 chỉ audit.** Không crawler, không Mongo, không scheduler, không proxy, không API/XHR.
>
> **Đã dùng 45 request HTML**, nhịp 3,5–4 s, chỉ trang công khai. Không dò ngưỡng, không load test.

---

## 1. Tóm tắt

| | Kết luận |
|---|---|
| **BOOTSTRAP (B)** | 🟢 **GO** |
| **LIVE DISCOVERY (A)** | 🔴 **NO-GO** |

Trang này là **danh mục AIS tĩnh, sắp theo bảng chữ cái** — không phải danh sách tàu đang hoạt động.

Ba con số quyết định:

| | |
|---|---|
| Vũ trụ tàu | **1.250.378** bản ghi · **31.278** trang · **40 tàu/trang** |
| MMSI dùng được | **96,4 %** (sample 1.440 dòng) — ⚠️ nhưng chỉ **80,3 %** có MID hợp lệ |
| Vị trí / mốc thời gian | **0 %** — trang **không** có `lat`/`lng`, **không** có timestamp |

Không có vị trí và không có mốc thời gian ⇒ theo [§24 của P10.1](../GLOBAL_DISCOVERY_ARCHITECTURE.md), nguồn này **chỉ phát hiện được, không theo dõi được**. Thêm nữa, không có `sort=newest`, không có `updated`, không có `ETag`/`Last-Modified`, và thứ tự alphabet khiến tàu mới **chèn vào giữa** — không có cách nào đọc phần đuôi để bắt cái mới.

---

## 2. Nguồn · truy cập

| | |
|---|---|
| URL | `https://shipinfo.net/vessels_list.php?letter={A-Z0-9}&page={n}` |
| Method | `GET`, HTML thuần |
| Server | `Apache/2.4.59 (Debian)` |
| Đăng nhập | ❌ không cần |
| Cloudflare / JS challenge / CAPTCHA | ❌ không thấy |

### robots.txt — ✅ ĐƯỢC PHÉP

Đã tải lại `robots.txt` (1.167 B, 200). `User-agent: *` cấm 34 đường dẫn, trong đó có `/api/`. **`/vessels_list.php` không nằm trong danh sách cấm** — khớp với kết luận P6.1.

⚠️ Nhắc lại ràng buộc cũ vẫn còn hiệu lực: mọi endpoint JSON của ShipInfo nằm dưới `/api/` và **bị robots cấm**. Audit này **không** chạm tới bất kỳ đường nào trong đó.

`Crawl-delay` chỉ đặt cho `DataForSeoBot` (120 s), không cho `*`.

---

## 3. Cấu trúc HTML

Một dòng tàu:

```html
<div class="item">
  <i class="large ship middle aligned icon"></i>
  <div class="content">
    <a href = "/find_vessel_'A SALES CALL'_IMO-0_MMSI-338216773" class="header">"'A SALES CALL'" vessel position</a>
    <div class="description"> IMO: 0; MMSI: 338216773</div>
  </div>
</div>
```

Header của trang mang **toàn bộ metadata phân trang**:

```html
<h4>Total vessels starting with a '<b>A</b>': 39861, pages: 997, page 0 </h4>
```

⚠️ **Cạm bẫy parser đã đo được.** Đếm dòng bằng ba pattern trên cùng một trang (`letter=Q&page=101`) cho **ba kết quả khác nhau**:

| Pattern | Đếm được |
|---|---|
| `href="/find_vessel_` | **30** ✅ |
| chuỗi `IMO:` | **30** ✅ |
| `<div class="description">\s*IMO:` | **22** ❌ |

Khoảng trắng giữa `<div class="description">` và `IMO:` **không nhất quán** giữa các dòng. Parser tương lai phải bám vào `href="/find_vessel_..."`, không bám vào khối `description`.

Tương tự, `<div class="item">` **không** đếm được dòng tàu: nav chữ cái cũng dùng class đó (45 vs 40 trên `letter=A&page=500`).

---

## 4. Phân trang

| | |
|---|---|
| Tham số | `letter` (A–Z, 0–9 → **36** giá trị) · `page` |
| Đánh số | **0-based** |
| Dòng/trang | **40**, cố định |
| Trang cuối | phần dư |
| Tổng số trang | **có sẵn trong HTML** (`pages: N`) |
| Tổng số bản ghi | **có sẵn trong HTML** (`Total vessels …: N`) |
| Ngoài phạm vi (`page=99999`) | `200 OK`, **0 dòng**, header vẫn đúng — không lỗi, không redirect |

Công thức đã kiểm chứng trên `letter=Q`: 4.070 tàu, 102 trang → `101 × 40 + 30 = 4.070` ✅.

Không cần dò trang cuối: **đọc `pages:` từ trang bất kỳ là biết**. Đây là hợp đồng phân trang tốt nhất có thể mong đợi.

⚠️ **`vessels_list.php` không tham số trả về một chữ cái NGẪU NHIÊN.** Ba lần gọi liên tiếp cho `G`, `N`, `H`. Không có "trang đầu" ổn định — mọi lần đọc phải khai `letter` tường minh.

Không có tham số nào khác. Toàn trang chỉ lộ đúng `letter`; **không** `sort`, **không** `order`, **không** `since`, **không** `updated`.

---

## 5. Trường trong một dòng

| Trường | Có | Nguồn |
|---|---|---|
| `name` | ✅ | text liên kết + trong URL |
| `MMSI` | ✅ | `description` + URL (`_MMSI-{n}`) |
| `IMO` | ✅ (thường `0`) | `description` + URL (`_IMO-{n}`) |
| `callsign` | ❌ | |
| `type` | ❌ | |
| `flag` | ❌ | |
| **`lat` / `lng`** | ❌ | |
| **timestamp** | ❌ | |
| detail URL | ✅ | xem §7 |

⚠️ **`IMO: 0` và `MMSI: 0` là sentinel "không có"**, không phải giá trị. Parser phải coi `0` là vắng mặt.

Đúng hình dạng `DiscoveredVessel` của [§8 P10.1](../GLOBAL_DISCOVERY_ARCHITECTURE.md): định danh + tên, không có lý lịch. Không có gì cám dỗ nhét vào particulars.

---

## 6. Độ phủ định danh

Sample **1.440 dòng** = trang 0 của cả 36 chữ cái.

| Loại | Số | Tỷ lệ |
|---|---|---|
| MMSI + IMO | 97 | **6,7 %** |
| **MMSI only** | 1.343 | **93,3 %** |
| IMO only | 0 | 0,0 % |
| **NAME only** | **0** | **0,0 %** |

✅ **Không có dòng nào chỉ có tên.** Luật name-only của [§8 P10.1](../GLOBAL_DISCOVERY_ARCHITECTURE.md) không bị kích hoạt — mọi dòng đều enqueue được.

⚠️ Sample lấy ở trang 0 nên **thiên lệch**: đó là các tên đứng đầu bảng chữ cái, nhiều bản ghi rác. Ở `letter=A&page=500` đã quan sát dòng **IMO-only** thật (`AMY KONISHI_IMO-9122540_MMSI-0`), nên tỷ lệ IMO-only toàn site **> 0**.

### Chất lượng định danh — phần quan trọng

| Kiểm tra | Kết quả |
|---|---|
| MMSI đúng định dạng `^[1-9]\d{8}$` (validator A1) | **1.387 / 1.440 = 96,3 %** |
| MMSI có mặt nhưng **sai định dạng** | **53** — vd `20000002`, `3002318`, `40005`, `30073091` |
| MMSI có **MID hợp lệ (201–775)** | **1.157 / 1.440 = 80,3 %** |
| IMO có mặt | 97 · **đúng checksum ISO 8713: 81** (16 sai) |
| **Định danh dùng được** (MMSI hợp lệ **hoặc** IMO hợp lệ) | **1.388 / 1.440 = 96,4 %** |

⚠️ **Đây là danh mục AIS THÔ, không phải sổ đăng kiểm.** Gần **20 %** bản ghi có MMSI đúng 9 chữ số nhưng MID nằm ngoài dải quốc gia hợp lệ — tàu sông, thiết bị AIS thử nghiệm, bản ghi hỏng. Tên như `'A AIS TEST SHIP'` (MMSI `100901001`) và `'H Y 66856'` xuất hiện ngay trang đầu.

**Hệ quả cho enrichment:** con số dùng để lập ngân sách **không phải** 1,25 triệu mà là ~**1,0 triệu** (80,3 %) — và ngay cả trong đó, phần đáng làm giàu còn nhỏ hơn nhiều. `mmsiIdentifier()` (validator A1) sẽ tự chặn 3,7 % sai định dạng; phần MID lạ thì lọt qua và chỉ lộ ra khi enrichment trả `NOT_FOUND`.

---

## 7. URL trang chi tiết

```
/find_vessel_{NAME}_IMO-{imo}_MMSI-{mmsi}
```

✅ Chứa **cả hai định danh** ngay trong URL — không cần mở trang chi tiết để lấy chúng.

⚠️ **Không dùng URL này làm khoá phân tích.** Phần `{NAME}` không nhất quán:

```
/find_vessel_'A  SALES CALL'_IMO-0_MMSI-338216773     ← có nháy đơn, hai dấu cách
/find_vessel_AMY KONISHI_IMO-9122540_MMSI-0           ← không nháy
```

Có nháy hay không tuỳ dữ liệu, có dấu cách thô chưa encode. Chỉ nên dùng URL để bắt cặp `IMO-(\d+)_MMSI-(\d+)`, phần tên đọc từ text liên kết.

Không có internal ID. Khoá dedupe theo [§13 spec](../GLOBAL_DISCOVERY_ARCHITECTURE.md): **MMSI trước, IMO sau** — đúng thứ tự `ICurrentVesselRepository` (P8.5) đang dùng.

---

## 8. Ước tính bootstrap

### Quy mô đo được

| Chữ cái | Tàu | Trang | | Chữ cái | Tàu | Trang |
|---|---|---|---|---|---|---|
| `M` | 195.684 | 4.893 | | `S` | 76.158 | 1.904 |
| `4` | 151.280 | 3.782 | | `9` | 46.030 | 1.151 |
| `2` | 87.730 | 2.194 | | `3` | 42.966 | 1.075 |
| `1` | 40.862 | 1.022 | | `A` | 39.861 | 997 |
| … | … | … | | `Q` (nhỏ nhất) | 4.070 | 102 |
| **TỔNG** | **1.250.378** | **31.278** | | | | |

⚠️ Phân bố **rất lệch**: `M` một mình = 15,6 % toàn bộ, `M` + `4` + `2` = 34,7 %. Bootstrap chia theo chữ cái sẽ có nhánh dài gấp 48 lần nhánh ngắn.

### Request · thời gian · băng thông

| | |
|---|---|
| Request | **31.278** (1 trang = 1 request, không có sub-request) |
| HTML/trang | 35,6–36,7 KB · **trung bình 36,3 KB** |
| Bytes/tàu | **~907 B** |
| **Băng thông** | **~1,14 GB** |

Thời gian, theo nhịp bảo thủ của [CRAWL_RUNTIME](../CRAWL_RUNTIME.md) (ShipInfo hiện `minDelayMs 3000` / `maxDelayMs 8000`, `maxConcurrency 1`):

| Nhịp | Thời gian |
|---|---|
| 3,0 s (nhanh nhất) | **~26,1 giờ** |
| 5,5 s (trung bình) | **~47,8 giờ** |
| 8,0 s (chậm nhất) | **~69,5 giờ** |

Theo **ngân sách discovery** của [§18 P10.1](../GLOBAL_DISCOVERY_ARCHITECTURE.md) (3.000–8.000 request/ngày, cộng dồn mọi nguồn):

| Ngân sách/ngày | Số ngày |
|---|---|
| 3.000 | **10,4 ngày** |
| 5.000 | **6,3 ngày** |
| 8.000 | **3,9 ngày** |

✅ Chấp nhận được **vì đây là việc một lần**. Đối chiếu: `ScanArea` legacy tốn ~92 giờ cho **mỗi vòng** ([§1 P10.1](../GLOBAL_DISCOVERY_ARCHITECTURE.md)) và không bao giờ dừng.

### Hiệu quả — so với hỏi từng tàu

| Cách | Request cho 1,25 M tàu |
|---|---|
| Trang danh sách | **31.278** |
| Hỏi từng tàu qua `getDetails` | **1.250.378** |
| **Khuếch đại** | **40×** |

---

## 9. Khả năng incremental

🔴 **Không có đường incremental nào rẻ hơn quét lại toàn bộ.**

| Cơ chế | Có? | Bằng chứng |
|---|---|---|
| Sắp theo mới nhất | ❌ | chỉ có alphabet |
| "Recent additions" | ❌ | không trang nào |
| Cột ngày cập nhật | ❌ | không trong dòng tàu |
| `Last-Modified` | ❌ | §10 |
| Phân vùng theo prefix | ✅ (chỉ 36) | quá thô — `M` = 4.893 trang |
| Thứ tự trang ổn định | ✅ | hai lần fetch `letter=Q&page=50` cho **dãy 40 MMSI y hệt, cùng thứ tự** |

⚠️ **Sắp xếp alphabet là điểm chí mạng.** Tàu mới tên `MARINA STAR` chèn vào **giữa** nhánh `M` (trang ~2.000/4.893), không phải cuối. Không có cách nào đọc "phần đuôi" để bắt cái mới — phải quét lại cả nhánh.

Thứ tự ổn định **giúp làm bootstrap có thể tiếp tục sau khi ngắt** (nhớ `letter` + `page` là chạy tiếp được), nhưng **không** giúp phát hiện thay đổi.

Rẻ nhất có thể nghĩ ra: quét lại toàn bộ theo chu kỳ (30–90 ngày) để làm mới danh bạ. Đó là **làm mới**, không phải incremental.

---

## 10. Header cache HTTP

```
Cache-Control: no-store, no-cache, must-revalidate
Set-Cookie: PHPSESSID=…; path=/
X-Frame-Options: SAMEORIGIN
```

| Header | Có? |
|---|---|
| `ETag` | ❌ |
| `Last-Modified` | ❌ |
| `Cache-Control` | ✅ nhưng là `no-store, no-cache` |

🔴 **`If-None-Match` và `If-Modified-Since` vô dụng.** Nguồn khai rõ không cache. Mỗi lần đọc là tải lại đủ 36 KB — không có đường nào rẻ hơn.

⚠️ Server phát `PHPSESSID` mỗi request. ⛔ **Không** giữ lại cookie: [luật P5](../OBSERVATION_STORAGE.md) cấm lưu cookie/session token, và ở đây nó cũng không mang lợi ích gì.

---

## 11. Chống bot

Trong **45 request** ở nhịp 3,5–4 s:

| Tín hiệu | Quan sát |
|---|---|
| `200 OK` | **45/45** |
| `403` | ❌ không |
| `429` | ❌ không |
| Cloudflare (`cf-*`) | ❌ không |
| JS / cookie challenge | ❌ không |
| CAPTCHA | ❌ không |
| Chặn tạm thời | ❌ không |
| Latency | ~1,1 s cho trang đầu |

⛔ **Không dò ngưỡng.** 45 request nói lên rất ít về hành vi ở 31.278 request. Bootstrap thật phải chạy qua `SourceRequestExecutor` (P4) với cooldown 15 phút cho 403/429 đã cấu hình sẵn cho ShipInfo, và phải **dừng lại** khi gặp tín hiệu chặn thay vì đổi chiến thuật.

---

## 12. Độ ổn định HTML

### 🟡 MODERATE

| Yếu tố | Đánh giá |
|---|---|
| Metadata phân trang trong text | ⚠️ **yếu** — `Total vessels starting with a '<b>X</b>': N, pages: M` là câu tiếng Anh, đổi chữ là hỏng |
| Định danh trong `href` | ✅ **mạnh** — `_IMO-{n}_MMSI-{n}` là khuôn máy sinh |
| Class CSS | 🟡 Semantic UI (`ui relaxed divided list`, `item`, `content`, `header`) — tên có nghĩa, **không** phải hash sinh tự động, nhưng dùng chung với nav |
| Khoảng trắng trong `description` | 🔴 **không nhất quán** — đã đo (§3) |
| Phụ thuộc JS | ✅ không — dữ liệu nằm trong HTML server-render |

**Khuyến nghị parser:** bám `href="/find_vessel_..._IMO-(\d+)_MMSI-(\d+)"` cho định danh, `pages:\s*(\d+)` cho tổng trang. ⛔ Không bám `<div class="description">`, ⛔ không đếm `<div class="item">`.

Cần **canary test** giống P6/P7: một fixture HTML thật, một test khẳng định vẫn bóc đúng 40 dòng.

---

## 13. Chỉ số hiệu quả discovery

Đo trên sample 1.440 dòng / 36 request:

| Chỉ số | Giá trị |
|---|---|
| `vesselsPerRequest` | **40,0** |
| `uniqueMmsiPerRequest` | **40,0** (0 trùng trong sample) |
| `uniqueImoPerRequest` | **2,7** (6,7 %) |
| `usableIdentifiersPerRequest` | **38,6** (96,4 %) |
| `usableWithPlausibleMid` | **32,1** (80,3 %) |
| `htmlBytesPerRequest` | **36.277 B** |
| `bytesPerVessel` | **~907 B** |
| `duplicateRatio` (trong sample) | **0,0** |

⚠️ `newVesselsPerRequest` — chỉ số quan trọng nhất theo [§18 P10.1](../GLOBAL_DISCOVERY_ARCHITECTURE.md) — **không đo được ở P10.2** vì chưa có `known_vessels` để so. Ở lần bootstrap đầu nó **bằng** `vesselsPerRequest` (mọi thứ đều mới); ở lần quét lại thứ hai nó sẽ **sụp gần 0**. Chính con số đó là lý do §14 xếp nguồn này là bootstrap chứ không phải live.

**Trùng lặp giữa các chữ cái:** không thể xảy ra theo thiết kế — `letter` là chữ cái đầu của tên, mỗi tàu thuộc đúng một nhánh. Rủi ro trùng thật nằm ở chỗ khác: một tàu **đổi tên** sẽ xuất hiện ở nhánh mới với **cùng MMSI**. Dedupe theo MMSI xử lý được; dedupe theo tên thì không.

---

## 14. Vai trò trong A + B

| Vai trò | Kết luận | Vì sao |
|---|---|---|
| **B · Bootstrap** | 🟢 **MẠNH** | 1,25 M định danh, 31 K request, khuếch đại 40×, tổng số có sẵn trong HTML, phân trang tất định |
| **A · Live discovery** | 🔴 **YẾU** | không vị trí · không timestamp · không sort-by-new · không cache header · alphabet chèn giữa |

Đây đúng là trường hợp [§15 spec](../GLOBAL_DISCOVERY_ARCHITECTURE.md) cảnh báo: **danh mục, không phải danh sách đang hoạt động**. Trang có cập nhật, nhưng không có cách nào biết *cái gì* vừa đổi — nên nó không phải nguồn live dù nội dung có mới.

⚠️ Nó cũng **không** trả lời được câu "tàu nào đang ở cảng X" — không có khái niệm cảng hay vùng trong trang này. Vùng discovery ([§10 P10.1](../GLOBAL_DISCOVERY_ARCHITECTURE.md)) phải đến từ nguồn khác.

---

## 15. Khuyến nghị

### BOOTSTRAP: 🟢 **GO**

Chạy một lần, có chặn, tiếp tục được sau khi ngắt:

1. Với mỗi `letter` trong 36 giá trị: đọc trang 0 → lấy `pages: N`.
2. Duyệt `page = 0..N-1`, bóc `IMO-(\d+)_MMSI-(\d+)` + tên.
3. **Ghi hàng loạt** vào `known_vessels` ([§14 P10.1](../GLOBAL_DISCOVERY_ARCHITECTURE.md) — một `bulkWrite`/trang, ⛔ không N+1 như `ScanArea`).
4. Lưu tiến độ `(letter, page)` để chạy tiếp.
5. Đi qua `SourceRequestExecutor` của ShipInfo (P4) — nhịp nghỉ, cooldown, health có sẵn.

⚠️ **Bắt đầu từ chữ cái NHỎ** (`Q` = 102 trang, `0` = 122, `U` = 148). Nếu có gì sai, hỏng 102 request chứ không phải 4.893.

⛔ **Không** enqueue enrichment ngay sau bootstrap. 1,25 M tàu × 1 request là 1,25 triệu request — chính xác điều [§5 P10.1](../GLOBAL_DISCOVERY_ARCHITECTURE.md) cấm. Bootstrap chỉ dựng **danh bạ**.

### LIVE DISCOVERY: 🔴 **NO-GO**

Không có tín hiệu thay đổi nào để bám vào. Làm mới danh bạ theo chu kỳ **30–90 ngày** (cùng thang với `PARTICULARS` ở [§13 P10.1](../GLOBAL_DISCOVERY_ARCHITECTURE.md)) là cách dùng đúng — và đó là *làm mới*, không phải *discovery*.

Live discovery phải tìm ở nguồn có **trang cảng/vùng kèm timestamp**. Đó là việc của P10.3–P10.5.

---

## 16. Đề xuất mục capability cho P10.7

⛔ **Chưa cập nhật `SOURCE_CAPABILITY_MATRIX` ở P10.2** — [§27 spec](../GLOBAL_DISCOVERY_ARCHITECTURE.md) và luật §12 (D12) của P10.1: không CONFIRMED khi chưa có implementation + POC.

Đề xuất khi P10.7 tới:

```ts
// ĐỀ XUẤT — chưa áp dụng.
shipinfo.discovery = {
  listPage:   CONFIRMED,   // 1.250.378 tàu · 31.278 trang · đã đo
  portPage:   UNSUPPORTED, // không có khái niệm cảng
  regionPage: UNSUPPORTED,
  identifiers: { mmsi: CONFIRMED, imo: CONFIRMED },
  position:    UNSUPPORTED, // không lat/lng
  timestamp:   UNSUPPORTED, // không mốc thời gian
  role: { bootstrap: "STRONG", live: "WEAK" },
}
```

⚠️ Matrix hiện tại mô tả *field lấy được từ MỘT tàu*. Khả năng discovery là **trục thứ hai** — [§6 P10.1](../GLOBAL_DISCOVERY_ARCHITECTURE.md) đã ghi "matrix cần mở rộng". Hình dạng phần mở rộng đó là việc của P10.7, không phải P10.2.

---

## 17. Hình dạng implementation đề xuất cho P10.8

⛔ Chưa viết gì.

```ts
// ĐỀ XUẤT — chưa tồn tại.
interface ShipInfoListPage {
  readonly letter: string;      // A-Z, 0-9
  readonly page: number;        // 0-based
  readonly totalVessels: number;// từ header HTML
  readonly totalPages: number;  // từ header HTML
  readonly vessels: readonly DiscoveredVessel[];
}
```

| Thành phần | Việc |
|---|---|
| `ShipInfoListClient` | dựng URL, `getText` — tái dùng `ShipInfoHttpTransport` đã có |
| `ShipInfoListParser` | bóc `pages:` + `IMO-(\d+)_MMSI-(\d+)` + tên; **có fixture + canary test** |
| `ShipInfoListDiscoverySource` | implement `DiscoverySource` với `inputKinds: [LIST_PAGE]` |

⛔ **Không** mở rộng `VesselDataProvider` ([§29 spec](../GLOBAL_DISCOVERY_ARCHITECTURE.md), §6 P10.1): hợp đồng của nó là một-định-danh-một-tàu. `DiscoverySource` là abstraction riêng.

⛔ **Không** dựng `VesselObservation` từ trang này ([§21 P10.1](../GLOBAL_DISCOVERY_ARCHITECTURE.md)): không có `lat`/`lng`, không có `sourceReceivedAt`. Ép nó thành observation sẽ đầu độc resolver bằng mốc thời gian mượn từ đồng hồ bot.

---

## Phụ lục · Cách tái lập

```bash
# robots
curl -s -A "SooskyCrawlBot/1.0" https://shipinfo.net/robots.txt

# tổng của một chữ cái (metadata nằm ngay trong HTML)
curl -s -A "SooskyCrawlBot/1.0" "https://shipinfo.net/vessels_list.php?letter=A&page=0" \
  | grep -o "Total vessels starting with a[^<]*<b>[A-Z0-9]</b>[^<]*"

# định danh trên một trang
curl -s -A "SooskyCrawlBot/1.0" "https://shipinfo.net/vessels_list.php?letter=A&page=0" \
  | grep -oE "IMO-[0-9]+_MMSI-[0-9]+" | head
```

Mọi con số trong tài liệu này đến từ 45 request thật ngày audit, không có số nào là ước đoán ngoài phần chi phí bootstrap (được khai rõ là ước tính).
