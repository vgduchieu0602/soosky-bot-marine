# MARINE_API_INTEGRATION_AUDIT — Bước 1 (audit, KHÔNG code)

> Đối chiếu **Bot Marine** (repo này) với **Soosky-marine-api** production để xác định Bot cần đổi gì nhằm trở thành lớp ingestion/enrichment/canonical.
>
> Marine API đã được **clone và đọc code thật** (42 file TS, nhánh mặc định). Mọi khẳng định dưới đây đều trỏ tới file cụ thể.

---

## 0. Tóm tắt cho người bận

| # | Phát hiện | Mức |
|---|---|---|
| 1 | **AIS data của production KHÔNG được lưu ở đâu cả** — chỉ relay qua WebSocket rồi mất. Đó là lý do map trống. | 🔴 gốc rễ |
| 2 | **Hai project cùng khai `mongoose.model('Vessel')`** với schema khác nhau → nếu chung một MongoDB thì xung đột thật | 🔴 chặn |
| 3 | Bot **đã có sẵn** observation + resolver + canonical + freshness + acquisition. Không phải xây lại. | 🟢 tốt |
| 4 | Canonical của Bot dùng `string` cho MMSI/IMO, contract production dùng `number` | 🟡 cần adapter |
| 5 | Canonical của Bot **thiếu** nhóm cảng (portId/unlocode/country/arrival) mà `VesselExtended` cần | 🟡 thiếu |
| 6 | Cache của `V2GetVesselStatus`/`Details` **không bao giờ hết hạn** — vị trí tàu cache vĩnh viễn | 🟡 bug production |
| 7 | Bot có `IntervalScheduler` nhưng **chưa ai dùng** cho enrichment | 🟡 thiếu |

**Kết luận ngắn:** phần khó nhất (observation → resolver → canonical, chống ghi đè dữ liệu cũ) Bot **đã làm xong và có 756 test**. Việc còn lại chủ yếu là **bù field cảng**, **cầu nối AIS**, và **wiring scheduler** — không phải viết lại kiến trúc.

---

## PHẦN A — Marine API production, hiện trạng thật

### A.1 Đường đi của AIS — cụt

`src/app.ts` → `new AisWebSocketManager(...)` → truyền vào `new Server(aisUpstreamMgr, useCases)`.

`src/server/Server.ts`:

```ts
private _initAISServicePipeLine() {
    this._aisUpstreamMgr.on("dataReceived", (data: AisMessage) => this._broadcastToClients(data));
}

private _broadcastToClients(data: AisMessage): void {
    const message = JSON.stringify(data);
    this._wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
}
```

🔴 **Đó là toàn bộ.** Không `repo.save`, không `Model.create`, không bulkWrite. AIS message đi thẳng từ socket ngoài ra socket trong rồi **biến mất**.

`V2MongoVesselRepo` và `V2VesselModel` **tồn tại nhưng không nhận AIS** — chúng chỉ được `V2GetVesselStatus`/`V2GetVesselDetails` dùng để cache kết quả MyShipTracking.

### A.2 Bốn use case V2 — đều là MyShipTracking

| Use case | Nguồn | Cache |
|---|---|---|
| `V2GetVesselStatus` | MyShipTracking `simple` | `v2vessels`, **không hết hạn** |
| `V2GetVesselDetails` | MyShipTracking `extended` | `v2vessels`, **không hết hạn** |
| `V2GetVesselNearby` | MyShipTracking nearby | không cache; có hạn mức đọc từ **file JSON** |
| `V2SearchVesselsMatchName` | MyShipTracking search | không cache |

⚠️ **Không có endpoint nào trả danh sách tàu để vẽ map.** `/v2/vessel/nearby` cần một MMSI làm tâm và tiêu credit trả tiền.

⚠️ **Cache vĩnh viễn** (`V2GetVesselStatus`):

```ts
const existingVessel = await this._v2MongoVesselRepo.readByMMSI(query);
if (existingVessel) { return existingVessel.basicInfo; }   // ← không kiểm tuổi
```

Tàu đã tra một lần thì `lat/lon/speed/received` đóng băng mãi mãi. Đây là bug production độc lập với Bot, nhưng nó **sẽ tự khỏi** khi API đọc canonical của Bot thay vì tự cache.

### A.3 Model production

`V2VesselModel` → collection **`v2vessels`**, schema **chính là `VesselExtended`** — tức DTO của MyShipTracking, mọi field `required: true`.

Vì `required` nên không nhận `null` → `createVesselFromFetchData` phải:

```ts
vesselName: data.vessel_name || "N/A",
mmsi:       data.mmsi        || 0,
grossTonnage: data.gt        || 0,
```

⚠️ Hệ quả: không phân biệt được *"tàu không có GT"* với *"GT = 0"*, và `mmsi: 0` là MMSI không tồn tại. Đây đúng thứ [§2 của yêu cầu](#) muốn tránh ở canonical.

### A.4 🔴 Xung đột collection giữa hai project

| | Bot Marine | Marine API |
|---|---|---|
| Khai báo | `model("Vessel", vesselSchema)` | `mongoose.model<Vessel>('Vessel', vesselSchema)` |
| Collection | **`vessels`** | **`vessels`** |
| Schema | `mmsi: String, unique, index` · `imo` · `name` · `lengthM` · `widthM` … | `area: String, default "N/A"` · `flag` · `route` … |

**Hai schema hoàn toàn khác nhau, cùng một tên collection.** Nếu hai tiến trình trỏ vào cùng `MONGODB_URI`, chúng ghi đè lẫn nhau.

⚠️ Đây là **câu hỏi phải trả lời trước khi làm bất cứ phase nào**: hai project đang dùng **chung** hay **riêng** MongoDB? Tôi không có cách xác minh từ code — cả hai đều đọc `process.env.MONGODB_URI`.

- Nếu **riêng** → không có xung đột hôm nay, nhưng việc "API đọc canonical của Bot" sẽ cần một DB chung hoặc một đường đồng bộ.
- Nếu **chung** → `vessels` của Bot (legacy `ScanArea`/`CrawlFleetPositions`) đang xung đột với `vessels` của API **ngay bây giờ**.

---

## PHẦN B — Bot Marine, cái gì đã có

### B.1 Kiến trúc

Clean Architecture 4 tầng, composition root ở `src/container.ts`. **756 test pass**, `tsc` strict sạch, không dependency thừa (`dotenv`, `express`, `ioredis`, `mongoose`).

### B.2 Đã xây xong (P0–P10.2)

| Tầng | Thành phần | Trạng thái |
|---|---|---|
| Canonical model | `VesselIdentity` · `VesselPositionReport` · `VesselParticulars` · `VesselVoyage` · `SourceMetadata` | ✅ |
| Capability matrix | 10 nguồn × 28 field, CONFIRMED/CANDIDATE/UNSUPPORTED | ✅ |
| Provider | `VesselDataProvider` + `ProviderRegistry` + 3 provider thật | ✅ |
| Crawl runtime | limiter · jitter · timeout · retry · cooldown · `SourceHealthTracker` | ✅ |
| Observation | `vessel_observations` append-only + validation + fingerprint dedupe | ✅ |
| Resolver | 4 resolver theo **nhóm dữ liệu**, có provenance từng field | ✅ |
| Canonical current | `canonical_current_vessels` + upsert idempotent | ✅ |
| Acquisition | sufficiency → source selection → orchestrator có chặn | ✅ |
| Paid gate | `PaidFallbackGate` 9 cổng, mặc định từ chối | ✅ |
| Discovery | mới có **kiến trúc + audit ShipInfo**, chưa code | 🟡 |

### B.3 Ba nguồn đang chạy thật

| Nguồn | Vai trò đo được | Đặc điểm |
|---|---|---|
| **ShipFinder** | vị trí **tươi theo phút** (POC đo 1–37 phút) · `heading` · `navStatus` · `draught` · `destination` | chỉ tra bằng **MMSI** (IMO → 404) |
| **ShipInfo** | `builtYear` · `deadweight` · identity · vị trí **trễ ~14 giờ** | tra được **cả MMSI lẫn IMO** |
| **VesselFinder** | legacy production, `length`/`beam`, quét vùng qua mp2 | mp2 = API nội bộ, đã đánh dấu **LEGACY** |

### B.4 AISStream trong Bot

| | |
|---|---|
| WebSocket | ❌ **không có** — không dòng nào |
| Trong matrix | ✅ có entry, `costType: EXISTING_STREAM`, `enabled: false` |
| Trong runtime | ✅ `usesCrawlRuntime()` **loại trừ** — gọi `getExecutor(AISSTREAM)` sẽ ném lỗi |
| Trong selector | ✅ bị loại ở cổng chi phí đầu tiên, có test khoá |

✅ **Yêu cầu "Bot không mở AISStream thứ hai" đã được thoả từ P2**, và có test giữ.

### B.5 Cái gì thiếu / chưa dùng

| Thiếu | Chi tiết |
|---|---|
| Nhóm cảng trong canonical | `VesselVoyage` có `currentPort`/`nextPort`/`lastPort` dạng **tên chuỗi**, nhưng **không có** `portId`, `unlocode`, `country`, `arrivalLocal`, `departureLocal` |
| `ResolvedVoyage` bỏ 2 field | `currentPortArrivalAt` và `nextPortEta` cố ý chưa phân xử (P8.4 §R.3) |
| Scheduler chưa nối | `IntervalScheduler` có, test có, **không use case nào dùng** |
| Cầu AIS | chưa có đường đọc AIS observation từ nguồn chung |
| GeoJSON | `canonical_current_vessels` chưa có `location` + `2dsphere` |
| Kiểu định danh | canonical dùng `string`, contract dùng `number` |

### B.6 Có over-engineered không?

Rà lại: **không đáng kể**. Ba thứ đáng nhắc:

| Thành phần | Đánh giá |
|---|---|
| `RejectedCandidate[]` lưu trong canonical | 🟡 mỗi field mang danh sách nguồn thua. Hiện 3 nguồn nên nhỏ; nếu lên 7 nguồn thì document phình. **Theo dõi, chưa cắt.** |
| `PaidFallbackGate` 9 cổng | 🟢 giữ — nó chặn tiền thật, mỗi cổng chặn một đường rò khác nhau |
| Bốn resolver riêng | 🟢 giữ — mỗi nhóm có luật khác nhau thật (POSITION nguyên khối, VOYAGE ưu tiên độ mới, PARTICULARS ưu tiên chất lượng) |

Ngược lại có **debt thật** cần biết: `ScanArea.saveShips()` ghi N+1 (400 tàu = 800+ round-trip) và `worldTiles` sinh 60.480 ô ≈ 92 giờ/vòng. Cả hai đã đánh dấu LEGACY, **không dùng cho việc mới**.

---

## PHẦN C — Ba câu hỏi về AISStream

### C.1 Vì sao production không vẽ được map?

**Không phải lỗi nguồn. Là thiếu tầng lưu trữ.**

Hiện tại:

```
AISStream ──► AisWebSocketManager ──► emit("dataReceived") ──► broadcast ws://…/ais-stream ──► ✗ mất
```

Bốn hệ quả trực tiếp:

| # | Vấn đề | Triệu chứng người dùng thấy |
|---|---|---|
| 1 | **Không có snapshot** | Mở map → **trống**. Chỉ hiện tàu nào tình cờ phát AIS *sau khi* client kết nối |
| 2 | **Không persist** | Refresh trang → mất sạch, đếm lại từ đầu |
| 3 | **Không có endpoint danh sách** | Không có `GET /vessels?bbox=…`. `/v2/vessel/nearby` cần MMSI làm tâm **và tiêu credit trả tiền** |
| 4 | **Format là event thô** | Client nhận từng `AisMessage` một, phải tự gộp `PositionReport` + `ShipStaticData` theo MMSI mới ra được `VesselSimple` |

⚠️ Điểm 4 đáng chú ý: AISStream gửi vị trí và thông tin tĩnh ở **hai loại message khác nhau**. Tàu vừa phát `PositionReport` mà chưa phát `ShipStaticData` thì **chưa có tên, chưa có IMO, chưa có vType** — trên map sẽ là một chấm không nhãn. `ShipStaticData` phát thưa hơn nhiều (chu kỳ 6 phút, so với vị trí 2–10 giây).

**Sửa đúng chỗ:** cần một tầng ghi AIS xuống DB rồi API đọc snapshot từ đó. Đó chính là `vessel_observations` + `canonical_current_vessels` mà Bot **đã có sẵn**.

### C.2 AISStream có đủ vẽ map toàn cầu không?

**Về nguồn: đủ, và tốt hơn HTML rất nhiều.** Về vận hành: có ba điều kiện.

| Tiêu chí | AISStream | Crawl HTML |
|---|---|---|
| Phủ | bounding box toàn cầu, đã subscribe `[[-90,-180],[90,180]]` | theo trang cảng/danh sách từng nguồn |
| Độ tươi | **giây** | ShipFinder phút · ShipInfo ~14 giờ |
| Chi phí mỗi tàu | ~0 (một kết nối cho tất cả) | **1 request/tàu** |
| Số tàu | hàng chục nghìn đang phát | ShipInfo: 1,25 triệu định danh nhưng **0 vị trí** |
| Rủi ro chặn | không | 403/429, phải nghỉ 3–8 s |
| `heading`, `draught`, `destination` | ⚠️ không có trong `PositionReport` class A cơ bản mà manager đang bóc | ShipFinder **có** |

Ba điều kiện để AISStream đủ:

1. **Phải lưu.** Stream không có API snapshot — không lưu thì mãi mãi không có map.
2. **Phải chịu được lưu lượng.** Toàn cầu là hàng nghìn message/giây. Ghi từng cái một sẽ giết Mongo — cần **gộp mẻ + throttle** (ví dụ gom 1–5 giây rồi `bulkWrite`, và bỏ bớt vị trí trùng khi tàu đang neo).
3. **Phải kiểm gói cước.** Giới hạn thật của tài khoản AISStream hiện tại (số message/tháng, có satellite hay chỉ terrestrial) **tôi không xác minh được từ code** — cần xem dashboard.

⚠️ Và một giới hạn bản chất: AISStream là **terrestrial + satellite tuỳ gói**. Vùng giữa đại dương có thể thưa. Đây là giới hạn của toàn bộ hệ AIS, HTML cũng không cứu được (các trang HTML cũng lấy từ cùng hạ tầng AIS đó).

**Khuyến nghị:** AISStream là **xương sống của map**, HTML là **enrichment**. Không đảo vai. Dùng HTML để vẽ map toàn cầu là bất khả thi về số học: 1 request/tàu × vài chục nghìn tàu × mỗi vài phút.

### C.3 HTML và AISStream có xung đột / trùng dữ liệu không?

Tách làm hai loại rủi ro — chúng rất khác nhau.

#### 🟢 Trùng ở tầng BẢN GHI: **đã giải xong**

Đây đúng là bài toán P8 của Bot. Cùng một MMSI có thể có nhiều observation từ nhiều nguồn; resolver phân xử **theo nhóm**, dùng `sourceReceivedAt` (mốc của **nguồn**), không dùng `fetchedAt` (đồng hồ của bot).

Ví dụ thật đã đo (MMSI 636018086 AGIA DOXA):

```
ShipFinder  position  sourceReceivedAt 16:39:41Z  → tuổi 0,02 h → LIVE    ← THẮNG
ShipInfo    position  sourceReceivedAt 20:11:07Z hôm trước → 14,49 h → STALE
```

ShipInfo crawl **sau** nhưng dữ liệu **cũ hơn** → thua. Đây chính xác là kịch bản "crawler chạy 17:10 nhưng dữ liệu từ 16:40 không được đè lên 17:05" trong yêu cầu — **đã có và có test khoá**.

Thêm nữa, resolver trộn theo **field**, nên hai nguồn bổ sung cho nhau thay vì tranh nhau:

```
length 179 · beam 29 · draught 5.9   ← ShipFinder
builtYear 2010 · deadweight 33261    ← ShipInfo
```

Khi AIS vào cuộc, nó sẽ thắng nhóm POSITION gần như luôn (tuổi tính bằng giây) và không đụng tới `builtYear` — vì AIS không có field đó.

#### 🔴 Trùng ở tầng COLLECTION: **chưa giải, và đây mới là rủi ro thật**

| Kho | Ai ghi | Nội dung |
|---|---|---|
| `vessels` | **cả hai project**, schema khác nhau | 🔴 xung đột nếu chung DB |
| `latestpositions` | Bot legacy | vị trí, last-write-wins, **không có xuất xứ** |
| `v2vessels` | Marine API | cache MyShipTracking, không hết hạn |
| `vessel_observations` | Bot | append-only, có xuất xứ |
| `canonical_current_vessels` | Bot | đã phân xử, có xuất xứ từng field |

Ba nơi cùng lưu "vị trí hiện tại của tàu" với ba ngữ nghĩa khác nhau. Đó là duplicate **thật** — không phải do AIS vs HTML, mà do **chưa chốt kho nào là nguồn sự thật**.

**Phải chốt:** `canonical_current_vessels` là nguồn sự thật duy nhất; `latestpositions` và `v2vessels` trở thành legacy đọc-thôi rồi ngưng.

---

## PHẦN D — Bảng quyết định

| Area | Hiện tại | Mục tiêu | Action |
|---|---|---|---|
| **Observation** | `vessel_observations`, append-only, fingerprint dedupe, có `sourceReceivedAt`/`fetchedAt` | như hiện tại + nhận thêm AIS | 🟢 **KEEP** |
| **Resolver** | 4 resolver theo nhóm, provenance từng field, chống ghi đè cũ | như hiện tại + biết nguồn AIS | 🟢 **KEEP** — thêm AIS vào bảng ưu tiên vị trí |
| **Canonical vessel** | `canonical_current_vessels`, MMSI/IMO `string`, `null` cho thiếu | + nhóm cảng đầy đủ + GeoJSON | 🟡 **MODIFY** — bù field, không đổi cấu trúc |
| **Freshness** | `PositionFreshness` LIVE≤30' / RECENT≤6h / STALE≤24h, tập trung trong `PositionResolverPolicy` | thêm bậc cho AIS (giây–phút) | 🟡 **MODIFY** — thêm ngưỡng, giữ chỗ |
| **ShipFinder** | provider thật, POC live, vị trí tươi + heading | **enrichment**, không phải nguồn map | 🟢 **KEEP** |
| **ShipInfo** | provider thật, POC live, builtYear/DWT | **enrichment tĩnh**, nhịp thưa | 🟢 **KEEP** |
| **VesselFinder mp2** | `ScanArea` + `worldTiles`, N+1, 92 h/vòng | đóng băng | 🔴 **FREEZE** — không xoá, không dùng cho việc mới |
| **AISStream (Bot)** | không có code, matrix `enabled:false`, runtime loại trừ | đọc AIS observation từ kho chung | 🟢 **KEEP disabled** — thêm đường **đọc**, không thêm socket |
| **AISStream (API)** | relay WS, **không lưu** | ghi observation | 🔴 **GAP** — cần quyết ai ghi (xem §E.1) |
| **Scheduler** | `IntervalScheduler` có, chưa ai dùng | 2 làn: tĩnh chậm / động nhanh | 🟡 **WIRE** |
| **MyShipTracking** | gate có, client chưa | paid tracking cho tàu ưu tiên | 🟡 **DEFER** |
| **Acquisition** | local-first, ≤2 nguồn free, gate paid | như hiện tại | 🟢 **KEEP** |
| **Collection `vessels`** | **hai schema, một tên** | tách hoặc đổi tên | 🔴 **RESOLVE trước mọi phase** |

---

## PHẦN E — Khoảng trống phải chốt trước khi code

### E.1 🔴 Ai ghi AIS xuống DB?

Hai phương án, **cần bạn quyết**:

| | **PA1 · API ghi** | **PA2 · Bot ghi qua kênh nội bộ** |
|---|---|---|
| Cách | Thêm vào `Server._initAISServicePipeLine()` một bước ghi `vessel_observations` | API forward AIS sang Bot qua `ws://localhost/ais-stream` (đã có sẵn), Bot ghi |
| Sửa production | **Có** — nhưng chỉ **thêm**, không đổi contract | **Không** |
| Bot mở socket ra ngoài? | không | **không** — chỉ nối vào WS **nội bộ** của API, không phải `stream.aisstream.io` |
| Ranh giới | API biết về schema observation của Bot | Bot phụ thuộc API đang chạy |
| Rủi ro | lẫn trách nhiệm | mất message khi Bot restart |

⚠️ **Khuyến nghị: PA2.** Nó giữ đúng luật "Bot không mở AISStream thứ hai" theo nghĩa nghiêm nhất (không có kết nối thứ hai tới nhà cung cấp — chỉ một client nội bộ của WS mà API vốn đã phát), và giữ toàn bộ hiểu biết về observation/resolver nằm trong Bot. Mất message khi restart chấp nhận được vì AIS phát lại liên tục.

⛔ Không chọn được nếu hai project chạy trên hai máy khác nhau mà không có mạng nội bộ — khi đó phải PA1.

### E.2 🔴 Chung hay riêng MongoDB?

Quyết định này chi phối mọi thứ. Nếu chung: phải xử lý xung đột `vessels` trước khi làm bất cứ gì.

### E.3 🟡 Field cảng — nguồn nào cấp?

`VesselExtended` cần 15 field cảng (`currentPortId`, `currentPortUnlocode`, `currentPortCountry`, `currentPortArrivalUtc/Local`, và tương tự cho last/next).

Thực tế đã audit:

| Nguồn | Cấp được |
|---|---|
| AISStream | ❌ không |
| ShipFinder | 🟡 tên cảng, sau đăng nhập / tính năng trả tiền |
| ShipInfo | ❌ không |
| MyShipTracking | ✅ **đủ cả 15** (`extended`, 3 credit) |

⚠️ Nghĩa là: **canonical để `null`, và đó là câu trả lời đúng**. Chỉ tàu nào được tra qua MyShipTracking mới có nhóm cảng. Marine API map `null → "N/A"`/`0` ở adapter của nó, giữ contract không đổi.

---

## PHẦN F — Kế hoạch triển khai

Mỗi phase độc lập, test được, commit được, không phá contract.

| Phase | Việc | Rủi ro production |
|---|---|---|
| **F0** | **Chốt E.1 + E.2** — không code | không |
| **F1** | Bù nhóm cảng vào `VesselVoyage` + `ResolvedVoyage` (portId/unlocode/country/arrival/departure), tất cả nullable | không — chỉ thêm field optional |
| **F2** | `CanonicalVesselView` — hàm thuần map canonical → `VesselSimple`/`VesselExtended`, kèm test đối chiếu **đúng** contract production | không — hàm mới, chưa ai gọi |
| **F3** | Nguồn AIS: `VesselSource.AISSTREAM` bật trong matrix + mapper AIS → observation. **Không** socket ra ngoài | không |
| **F4** | Cầu nối AIS theo PA đã chốt ở F0 + gộp mẻ + throttle + `bulkWrite` | ⚠️ tải Mongo — phải đo |
| **F5** | Freshness cho AIS: thêm bậc `REALTIME` (≤2 phút) vào `PositionResolverPolicy`, đưa AIS lên đầu `positionPreference` | không — policy có sẵn chỗ |
| **F6** | GeoJSON `location` + `2dsphere` trên `canonical_current_vessels`, cập nhật cùng lệnh với `position` | không — field mới |
| **F7** | Nối `IntervalScheduler`: làn **tĩnh** (particulars, 30–90 ngày) và làn **động** (vị trí theo trạng thái tàu), có batch + concurrency + skip-fresh | ⚠️ bắt đầu crawl thật — bật dần |
| **F8** | Đọc-sẵn cho Marine API: index + hàm truy vấn theo bbox/MMSI. **Bot vẫn không phải API server** | không |

⛔ **Không làm trong kế hoạch này:** sửa mobile · đổi response V2 · tạo V3 · payment · Kafka/Redis/queue · microservice · rename folder hàng loạt.

### Thứ tự đề xuất

**F0 → F2 → F1 → F3 → F5 → F4 → F6 → F7 → F8**

Lý do đảo F2 lên trước F1: viết hàm map **trước** sẽ lộ ra chính xác field nào còn thiếu, thay vì đoán. Test của F2 sẽ đỏ ở đúng chỗ F1 cần bù.

---

## Phụ lục · Đối chiếu canonical ↔ contract

### `VesselSimple` (MAP)

| Contract | Canonical Bot | Ghi chú |
|---|---|---|
| `vesselName: string` | `identity.name.value` | ⚠️ `null` khi chưa biết → adapter đổi `"N/A"` |
| `mmsi: number` | `vesselKey.mmsi` (**string**) | ⚠️ cần `Number()` |
| `imo: number` | `identity.imo.value` (**string**, nullable) | ⚠️ `null` → `0` |
| `vType: number` | `identity.vesselTypeCode.value` | ⚠️ **chỉ AIS cấp được** — hiện free chưa nguồn nào CONFIRMED |
| `lat` / `lon` | `position.position.lat` / `.lng` | ⚠️ tên `lng` vs `lon` |
| `course` | `position.position.course` | ✅ |
| `speed` | `position.position.speed` | ✅ |
| `navStatus: string` | `position.position.navStatus.text` | ✅ |
| `received: string` | `position.observedAt` | ✅ **mốc nguồn**, không phải lúc crawl |

### `VesselExtended` (DETAIL)

| Nhóm | Canonical | Trạng thái |
|---|---|---|
| `vesselType`, `flag` | `identity.vesselType`, `identity.flagName` | ✅ có |
| `grossTonnage`, `deadWeight`, `built` | `particulars.*` | ✅ có |
| `estimatedTimeArrival` | `voyage.eta` | ✅ có (⚠️ chỉ MyShipTracking cấp ETA có năm) |
| 15 field cảng | **thiếu** | 🔴 F1 |
| `containsExtendedInfo` | suy ra: có ≥1 field extended | ✅ tính được |

---

*Audit thực hiện trên Marine API nhánh mặc định, clone ngày làm audit. Không sửa file nào của Marine API.*
