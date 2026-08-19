# Tích hợp Bot với Marine — giai đoạn INTEGRATION-1 (rà soát + hợp đồng)

> Cách để **Soosky-marine-api** dùng dữ liệu canonical của **Soosky-bot-marine** mà không phải viết lại production.
>
> ⚠️ Tài liệu này là **bước audit + hợp đồng**. Chưa sửa một dòng nào của production — theo đúng §1 ("không code trước khi lập contract matrix") và §3 ("report tradeoff trước khi implement").

---

## 0. Bốn phát hiện đổi cả kế hoạch

| # | Phát hiện | Hệ quả |
|---|---|---|
| 1 | **Production KHÔNG có endpoint map nào.** Routes chỉ có `/`, `/ports`, `/port`, `/vessel`, `/v2/vessel/status`, `/v2/vessel/details`, `/v2/vessel/nearby`, `/v2/vessels` | §10/§11 nói "giữ nguyên contract endpoint cũ" — **không có contract cũ để giữ**. Map hiện được vẽ từ **WebSocket AIS thô**. MAP-2/3 sẽ là endpoint **MỚI**, không phải thay ruột |
| 2 | **Production KHÔNG có xác thực nào.** `Server.ts` không có middleware auth, không token, không kiểm origin | §21/§57 (Marine sở hữu authorization trả tiền) **không thể** làm được hôm nay. Chặn làn trả tiền |
| 3 | **Production ĐÃ TỰ gọi MyShipTracking** (`V2GetVesselStatus` simple, `V2GetVesselDetails` extended) | §32 "một chủ sở hữu paid = Bot" nghĩa là **gỡ** đường paid của production. Đó là cutover, thuộc PROD-1 |
| 4 | **Chung hay riêng MongoDB — CHƯA BIẾT.** Cả hai đọc `process.env.MONGODB_URI`, không repo nào có docker-compose/pm2/.env | §3/§4 bắt audit deployment thật. **Không suy đoán được từ code.** Đây là câu hỏi chặn |

---

## 1. Hiện trạng hai repo

### Bot (baseline `60239e0`)

| | |
|---|---|
| Test | **1.005 pass / 0 fail** |
| Đọc map | `QueryMap` (zoom → VESSELS/CLUSTERS) · `GetMapVessels` |
| Đọc detail | `GetCanonicalVesselDetail` (thuần) · `GetOrRefreshVesselDetail` (làm mới free) |
| Làn trả tiền | `TrackVesselCurrentPosition` (MyShipTracking simple, 1 credit) |
| Kho ghi | `vessel_observations` · `canonical_current_vessels` |

### Marine API (`09f1e35`)

| | |
|---|---|
| Test | ⛔ **không có** (`npm test` → `Error: no test specified`) |
| Auth | ⛔ **không có** |
| Map endpoint | ⛔ **không có** |
| Detail | `/v2/vessel/details` → cache `v2vessels` **vĩnh viễn** (không kiểm tuổi) → nếu miss thì gọi MyShipTracking `extended` (3 credit) |
| Status | `/v2/vessel/status` → cache vĩnh viễn → MyShipTracking `simple` (1 credit) |
| AIS | relay WebSocket `/ais-stream`, **không lưu** |
| Phụ thuộc | express · mongoose · ws · dotenv |

---

## 2. Ranh giới tích hợp — khuyến nghị

### Phương án

| | **A · Shared Mongo (Marine ĐỌC canonical)** | **B · Bot mở HTTP read API** |
|---|---|---|
| Map read | Marine truy vấn `canonical_current_vessels` trực tiếp | mỗi request map đi thêm một network hop qua Bot |
| Bot có phải API server? | **không** | có — và phải chịu tải map |
| Ảnh hưởng ingestion | không | tải map cạnh tranh với vòng lặp AIS |
| Bot chết thì map? | **vẫn đọc được** ảnh canonical cuối | **map chết** |
| Cần gì | cùng cluster Mongo + trust boundary | mạng nội bộ + auth nội bộ |
| Code phải viết ở Marine | 1 repository read-only + 2 adapter | 1 HTTP client + 2 adapter |

### Khuyến nghị: **A cho ĐỌC + lệnh nội bộ hẹp cho GHI-mới**

```
ĐỌC    : Marine API  ──đọc trực tiếp──►  canonical_current_vessels
LỆNH   : Marine API  ──HTTP nội bộ───►  Bot  (làm mới detail / theo dõi trả tiền)
```

Lý do quyết định là **§30**: map phải đọc được khi tiến trình Bot đang restart. Phương án B làm map phụ thuộc vòng đời của tiến trình ingestion — đó là đổi một điểm chết thành hai.

⚠️ **Điều kiện tiên quyết:** hai tiến trình phải trỏ vào **cùng** một cluster Mongo và cùng trong một trust boundary. Nếu không thì A **không khả thi** và phải quay lại B. Xem §7.

---

## 3. Sở hữu collection

| Collection | Bot | Marine API |
|---|---|---|
| `vessel_observations` | **GHI** (chủ sở hữu duy nhất) | ⛔ không đọc, không biết nó tồn tại |
| `canonical_current_vessels` | **GHI** (chủ sở hữu duy nhất) | **CHỈ ĐỌC** |
| `latestpositions` · `vesselpositions` | legacy của Bot | — |
| `v2vessels` | — | Marine sở hữu (cache MyShipTracking) |
| `users` · `subscriptions` · tracking state | ⛔ Bot **không** có model nào | **Marine sở hữu** |

**Luật một người ghi:** Marine API tuyệt đối không `update`/`upsert`/`resolve`/`merge` vào `canonical_current_vessels`. Phân xử nhiều nguồn là của Bot, và hai người ghi vào cùng một ảnh hợp nhất là cách chắc chắn nhất để mất xuất xứ.

### 🔴 Xung đột `vessels` phải giải TRƯỚC

Cả hai repo đều khai `model("Vessel", …)` → cùng collection **`vessels`**, **hai schema khác nhau**:

| | Bot | Marine API |
|---|---|---|
| Schema | `mmsi` unique · `imo` · `lengthM` · `widthM` … | `area` default `"N/A"` · `flag` · `route` … |

Nếu chung cluster thì hai tiến trình **đang** ghi đè nhau ngay bây giờ, độc lập với INTEGRATION-1. Phải đổi tên một bên trước khi bàn tiếp.

---

## 4. Bảng đối chiếu hợp đồng — phần BẢN ĐỒ

⚠️ **Không có endpoint map production nào để đối chiếu.** Bảng dưới đối chiếu với `VesselSimple` (DTO detail/status hiện có) vì đó là hình dạng vessel duy nhất mobile đang biết.

| `VesselSimple` | Kiểu prod | Bot `MapVesselItem` | Trạng thái | Ghi chú |
|---|---|---|---|---|
| `vesselName` | `string` | `vesselName: string \| null` | **LEGACY_DEFAULT_REQUIRED** | `null` → `"N/A"` |
| `mmsi` | **`number`** | `mmsi: string` | **DERIVABLE** | `Number(mmsi)` |
| `imo` | **`number`** | `imo: string \| null` | **LEGACY_DEFAULT_REQUIRED** | `null` → `0` |
| `vType` | `number` | `vesselTypeCode: number \| null` | **LEGACY_DEFAULT_REQUIRED** | `null` → `0`. ⚠️ chỉ AIS cấp mã này |
| `lat` | `number` | `lat: number` | **DIRECT** | |
| `lon` | `number` | `lon: number` | **DIRECT** | Bot canonical dùng `lng`; projector đã đổi sang `lon` |
| `course` | `number` | `course: number \| null` | **LEGACY_DEFAULT_REQUIRED** | `null` → `0` ⚠️ xem dưới |
| `speed` | `number` | `speed: number \| null` | **LEGACY_DEFAULT_REQUIRED** | `null` → `0` ⚠️ xem dưới |
| `navStatus` | `string` | `navStatusCode` + `navStatusText` | **DERIVABLE** | `navStatusText ?? "N/A"` |
| `received` | `string` | `observedAt: Date` | **DERIVABLE** | ⚠️ xem §6 định dạng ngày |

⚠️ **`course`/`speed` → `0` là mất thông tin thật.** AIS dùng sentinel `360.0`/`102.3` cho "không có", và Bot map chúng thành `null` đúng nghĩa. Đổi thành `0` nói với mobile rằng "tàu đứng yên, hướng chính bắc" — sai. Đây là món nợ của contract cũ, cần hỏi FE có phân biệt được `0` với "không biết" không.

### Cụm tàu — DÙNG DTO RIÊNG

| Bot `MapClusterItem` | |
|---|---|
| `id` `"gridZoom:x:y"` · `lat` · `lon` · `count` · `movingCount` | |

⛔ **Không** nhồi cluster vào `VesselSimple`. ⛔ **Không** `mmsi = clusterId`. Cluster không phải tàu. Cần DTO `MapClusterResponse` riêng, và mobile phải hiểu `mode` trước khi bật chế độ cụm.

---

## 5. Bảng đối chiếu hợp đồng — phần CHI TIẾT

| `VesselExtended` | Bot canonical | Trạng thái |
|---|---|---|
| `basicInfo.*` | xem §4 | như trên |
| `containsExtendedInfo` | suy: có ≥1 nhóm tĩnh | **DERIVABLE** |
| `vesselType` | `identity.vesselType.value` | **DIRECT** |
| `flag` | `identity.flagName.value` | **DIRECT** |
| `grossTonnage` | `particulars.grossTonnage` | **DIRECT** ⚠️ **0/3 nguồn free** cấp được — thực tế luôn `null` |
| `deadWeight` | `particulars.deadweight` | **DIRECT** (ShipInfo) |
| `built` | `particulars.builtYear` | **DIRECT** (ShipInfo) |
| `estimatedTimeArrival` | `voyage.eta` | **DIRECT** ⚠️ chỉ MyShipTracking cho ETA có năm |
| `currentPort` · `lastPort` · `nextPort` | `voyage.*` (tên chuỗi) | **DIRECT** ⚠️ chỉ ShipFinder |
| `lastPortDepartureUtc` | `voyage.lastPortDepartureAt` | **DIRECT** |
| `currentPortArrivalUtc` | — | **MISSING** (`ResolvedVoyage` chưa phân xử) |
| `nextPortEtaUtc` | — | **MISSING** (như trên) |
| `currentPortId` · `currentPortUnlocode` · `currentPortCountry` | — | **MISSING** |
| `lastPortId` · `lastPortUnlocode` · `lastPortCountry` | — | **MISSING** |
| `nextPortId` · `nextPortUnloco` · `nextPortCountry` | — | **MISSING** |
| `currentPortArrivalLocal` · `lastPortDepartureLocal` · `nextPortEtaLocal` | — | **MISSING** (giờ địa phương cần múi giờ cảng) |

**Tổng: 12 DIRECT · 2 DERIVABLE · 5 LEGACY_DEFAULT_REQUIRED · 14 MISSING.**

⛔ **Không** thêm field cảng rỗng vào canonical để đạt parity. Không nguồn free nào cấp; chỉ MyShipTracking `extended` (3 credit) có.

### Quyết định cho từng trường còn THIẾU (mục 42)

| Nhóm | Quyết định đề xuất |
|---|---|
| 9 field `*PortId` / `*Unlocode` / `*Country` | **giữ nguồn legacy tạm thời** — production đã có chúng trong `v2vessels`; adapter đọc canonical cho phần khác, giữ 9 field này từ cache cũ. Không xoá, không bịa |
| `currentPortArrivalUtc` · `nextPortEtaUtc` | **hoãn** — cần mở `ResolvedVoyage` trước (P8.4 §R.3) |
| 3 field `*Local` | **`"N/A"`** — múi giờ cảng là một bài toán riêng, không đáng mở ở đây |

---

## 6. Adapter tương thích

Đặt ở **phía Marine API**, không phải trong Bot. Bot canonical giữ `null` sạch; adapter mới là nơi bẩn.

```
canonical (Mongo)  ──CanonicalVesselReadRepository──►  read model
                                                            │
                                          ┌─────────────────┴─────────────────┐
                                  toVesselSimple()                  toVesselExtended()
                                          │                                   │
                                    "N/A" / 0                           "N/A" / 0
```

Trách nhiệm adapter, đúng bốn việc: **đổi tên field · chuỗi↔số · `null`→legacy default · serialize ngày**.

⛔ Không crawl, không resolve, không business logic Mongo.

### Định dạng ngày — CẦN XÁC MINH

Production hiện **truyền thẳng chuỗi `received` của MyShipTracking**, hoặc `"N/A"`. Chuỗi đó là ISO-8601 kèm `Z` (`"2026-08-15T22:47:28Z"`).

⇒ Adapter nên phát `observedAt.toISOString()`. **Nhưng** cần xác minh mobile đang parse gì — nếu nó đang so chuỗi hoặc parse theo định dạng khác thì `.toISOString()` (có `.000`) có thể khác cái nó từng thấy. **Chưa xác minh được từ repo này.**

### Độ tươi (§33)

Adapter **phải** dùng ngưỡng động, không phải "document còn tồn tại nghĩa là tàu còn đó". Bot đã có `MapVesselReadiness` (24 giờ, tính từ `position.observedAt`). Marine phải lặp lại **đúng ngữ nghĩa đó**, và có test parity — nếu không, map sẽ hồi sinh tàu đã im lặng ba ngày.

---

## 7. 🔴 Chặn: chung hay riêng MongoDB?

Không xác minh được từ code. Cả hai đọc `process.env.MONGODB_URI`; repo không có deployment artifact nào.

| Nếu | Thì |
|---|---|
| **CHUNG cluster** | Phương án A khả thi. **Nhưng** phải đổi tên collection `vessels` của một bên TRƯỚC — hiện đang xung đột thật |
| **RIÊNG** | Phương án A **không** khả thi. Chọn B (Bot mở read API nội bộ), và chấp nhận map phụ thuộc tiến trình Bot — hoặc dựng replica/đồng bộ, đắt hơn nhiều |

⛔ Không implement phương án A trước khi có câu trả lời. Đoán sai ở đây là viết một repository đọc vào cluster không tồn tại.

---

## 8. Luồng — sau khi chốt boundary

### Bản đồ (đọc)

```
Mobile ──bbox+zoom──► Marine API ──2dsphere Polygon──► canonical_current_vessels
                            │
                      lọc độ tươi (24h) → adapter → VesselSimple[] | MapCluster[]
```

⚠️ Endpoint này **mới**. Mobile phải gửi `minLat,minLon,maxLat,maxLon,zoom`. Client cũ không gửi → **không** được trả cả collection (§12); giữ đường AIS WebSocket cũ cho tới khi có version gate.

### Chi tiết (đọc + làm mới)

```
Mobile ──mmsi──► Marine API ──đọc canonical──► đủ tươi? ──► trả ngay
                                   │ thiếu/cũ
                                   └──lệnh nội bộ──► Bot GetOrRefreshVesselDetail
                                                        (free, ngân sách 10s)
```

Lệnh nội bộ hẹp: **`POST /internal/vessels/:mmsi/refresh`** — mạng riêng, token nội bộ, timeout có trần, dùng lại `GetOrRefreshVesselDetail`. ⛔ Không `/run-provider`, không `/crawl-url`: production nói **ý định**, không nói **cách làm**.

### Trả tiền

```
Mobile ──► Marine API ──auth + kiểm gói/quyền──► lệnh paid tường minh
                                                      ↓
                                    Bot TrackVesselCurrentPosition
                                    → MyShipTracking → Observation → Resolver → canonical
                                                      ↓
                          Marine trả canonical + { status, actualCreditCharged }
```

Bot **không** quyết ai được trả tiền. Marine **không** giữ khoá MyShipTracking sau cutover. `MYSHIPTRACKING_API_KEY` chỉ ở server, không bao giờ tới mobile, không bao giờ nằm trong response.

⚠️ **Chặn:** Marine API **chưa có auth nào**. Không có auth thì `/internal/*` và làn trả tiền đều không an toàn để mở.

---

## 9. Hành vi khi lỗi

| Tình huống | Hành vi bắt buộc |
|---|---|
| Bot process **chết** | Map + detail **vẫn đọc được** ảnh canonical cuối (đây là lý do chọn A) |
| Lệnh làm mới không tới được Bot | Trả **detail từng phần đang có**, ⛔ không 500 chỉ vì enrichment hỏng |
| Lệnh trả tiền không tới được Bot | Trả `TRACKING_TEMPORARILY_UNAVAILABLE`. ⛔ **Không** tự gọi MyShipTracking trong Marine — một chủ sở hữu paid |
| Canonical rỗng cho MMSI đó | `NOT_FOUND` + (tuỳ chọn) lệnh làm mới. Không bịa vessel |

---

## 10. Cờ tính năng và cách triển khai dần

```bash
USE_CANONICAL_MAP_READ=false      # mặc định TẮT
USE_CANONICAL_DETAIL_READ=false   # mặc định TẮT
BOT_INTERNAL_URL=
BOT_INTERNAL_TOKEN=
```

Mặc định tắt ⇒ bật là một quyết định, và tắt lại là rollback trong một biến môi trường. Không framework cờ.

### Thay thế dần theo kiểu strangler, ba bước (mục 43)

| Bước | Bật | Vẫn legacy |
|---|---|---|
| 1 | vị trí map từ canonical | toàn bộ detail |
| 2 | identity + particulars trong detail | voyage + 9 field cảng |
| 3 | voyage | 9 field cảng (hoặc bỏ hẳn nếu FE không dùng) |

⛔ Không big-bang. ⛔ Không migration ghi đè dữ liệu legacy (§49).

---

## 11. Chặn trước khi code

| # | Chặn | Ai trả lời |
|---|---|---|
| 1 | **Bot và Marine API có dùng chung cluster Mongo không?** | vận hành |
| 2 | Xung đột collection `vessels` — đổi tên bên nào? | quyết định kiến trúc |
| 3 | Marine API **chưa có auth** — `/internal/*` và làn trả tiền chờ nó | product/security |
| 4 | Marine API **không có test runner** → §62 "tests pass in both repos" hiện không đạt được | quyết định: thêm test hạ tầng cho Marine? |
| 5 | Mobile parse `received` theo định dạng nào? | đọc code mobile |
| 6 | FE có phân biệt `course/speed = 0` với "không biết"? | đọc code mobile |
| 7 | Mobile có sẵn sàng nhận `mode: CLUSTERS` không? | product |

---

## 12. PROD-1 (chưa làm)

1. Trả lời chặn #1–#2, đổi tên collection xung đột.
2. Thêm auth + test runner cho Marine API.
3. Endpoint map mới `bbox+zoom`, cờ tắt mặc định, chạy song song đường AIS WebSocket cũ.
4. Shadow compare trên staging: số tàu legacy vs canonical, lệch vị trí, độ phủ field.
5. Bật cờ map cho nội bộ → theo dõi → bật rộng.
6. Sau cùng: gỡ đường MyShipTracking khỏi Marine, để Bot là chủ sở hữu duy nhất.

⛔ INTEGRATION-1 **không** cutover.

---

*Chưa sửa file nào của Soosky-marine-api trong phase này.*
