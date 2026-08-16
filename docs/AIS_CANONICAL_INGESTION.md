# AIS_CANONICAL_INGESTION — phase AIS-1

> Bot hiểu **chính xác** message mà Soosky-marine-api production đang broadcast, và chuẩn hoá nó về canonical đi được vào đường ống Observation → Resolver **đang có**.
>
> Phase này **CHỈ** map. Không WebSocket, không Mongo, không scheduler.

---

## 0. Tóm tắt cho người bận

| # | Điểm | |
|---|---|---|
| 1 | Nguồn canonical là **`AISSTREAM`**. Marine API chỉ là **transport** | 🟢 |
| 2 | Bot **không** mở connection tới `wss://stream.aisstream.io` — và phase này còn chưa nối cả WS nội bộ | 🟢 |
| 3 | `PositionReport` và `ShipStaticData` **độc lập hoàn toàn** | 🟢 |
| 4 | `sourceReceivedAt` ≠ `fetchedAt`, không bao giờ mượn nhau | 🟢 |
| 5 | **Không suy `heading` từ `course`** — Marine API không chuyển tiếp heading | 🟢 |
| 6 | `timestamp` production **khai là `number` nhưng chạy là `string`** | 🔴 rủi ro |
| 7 | Capability của AISSTREAM tụt từ **17 → 10** CONFIRMED, đúng theo payload thật | 🟡 |
| 8 | **Không persist** message nào trong phase này | 🟢 chủ ý |

---

## 1. Ai sở hữu cái gì

```
AISStream.io                     ← nhà cung cấp, KHÔNG phải của ta
      ↓  wss://stream.aisstream.io/v0/stream
Soosky-marine-api                ← production, KHÔNG ĐƯỢC SỬA
      ↓  WebSocket nội bộ đã có sẵn (Server._broadcastToClients)
Soosky-bot-marine                ← repo này
      ↓
MarineAisMessageMapper           ← AIS-1 làm ĐẾN ĐÂY
      ↓
VesselObservation (vessel_observations)
      ↓
Resolver
      ↓
canonical_current_vessels
```

**Marine API là ĐƯỜNG TRUYỀN, không phải nguồn dữ liệu.** Vì thế:

- `VesselSource.AISSTREAM` là source của mọi bản ghi sinh ra từ đây.
- **Không** tạo `VesselSource.MARINE_API` / `MARINE_WS`. Thêm một giá trị source cho mỗi chặng đường truyền sẽ khiến resolver phải phân xử giữa hai cái tên của cùng một nguồn.

Phase AIS-1 **chưa** mở kết nối nào cả — kể cả WS nội bộ. Mapper là hàm thuần, người gọi nó chưa tồn tại.

---

## 2. Contract production — bằng chứng từ CODE

Đọc trực tiếp:

- `src/domain/service/AisDataService.ts` — khai kiểu
- `src/adapter/ais-stream/AisWebSocketManager.ts` — `_dataTransform()` dựng payload

```ts
// AisDataService.ts
export type AisMessage =
    | { type: AisMessageType.PositionReport, data: PositionReport }
    | { type: AisMessageType.ShipStaticData, data: ShipStaticData }

export enum AisMessageType {
    PositionReport = "PositionReport",
    ShipStaticData = "ShipStaticData",
}

export type PositionReport = {
    mmsi: number
    latlng: [number, number]
    sog: number
    cog: number
    timestamp: number            // ⚠️ xem §5
    navigationalStatus: number
}

export type ShipStaticData = {
    mmsi: number
    imo:  number
    type: number
    name: string
}
```

```ts
// AisWebSocketManager._dataTransform() — nguồn của từng field
mmsi:               data.MetaData.MMSI
latlng:             [Message.PositionReport.Latitude, Message.PositionReport.Longitude]
sog:                Message.PositionReport.Sog
cog:                Message.PositionReport.Cog
timestamp:          data.MetaData.time_utc          // ⚠️ CHUỖI, không phải số
navigationalStatus: Message.PositionReport.NavigationalStatus

imo:  Message.ShipStaticData.ImoNumber
type: Message.ShipStaticData.Type
name: data.MetaData.ShipName
```

⚠️ `default: throw new Error("Unknown AIS message type")` — production **chỉ** phát hai loại này. Message 18/19/24 (class B, static data report) hiện **không** tới được bot.

### Bot-side DTO

`src/infrastructure/ais/MarineAisTypes.ts` sao chép **hình dạng**, không import code. Hai repository biên dịch độc lập; đổi lại, lệch contract phải bắt bằng audit + test chứ compiler không bắt hộ. `MarineAisMessageMapper.test.ts` giữ đúng vai đó.

---

## 3. Điều production KHÔNG chuyển tiếp

Đây là phần quan trọng nhất của audit. AISStream gửi cho Marine API nhiều hơn hẳn những gì Marine API gửi tiếp cho bot:

| Field trong AIS message gốc | Có tới bot không |
|---|---|
| `TrueHeading` (msg 1/2/3) | ❌ |
| `CallSign` (msg 5) | ❌ |
| `Dimension` → length/beam (msg 5) | ❌ |
| `MaximumStaticDraught` (msg 5) | ❌ |
| `Destination` (msg 5) | ❌ |
| `Eta` (msg 5) | ❌ |

**Hệ quả cho capability matrix:** những field này là **CANDIDATE**, không phải CONFIRMED. "Đặc tả AIS có" không phải bằng chứng — thứ chạy trong production mới là. Xem §7.

---

## 4. Mapping

### 4.1 PositionReport → `VesselPositionReport` (nhóm B)

| Message | Canonical | Ghi chú |
|---|---|---|
| `mmsi` (number) | `mmsi` (string) | qua `isValidMmsi`: đúng 9 chữ số, chữ số đầu ≠ 0 |
| `latlng[0]` | `lat` | qua `isValidCoordinates` |
| `latlng[1]` | `lng` | |
| `sog` | `speed` (knots) | qua `isValidSpeed`; sentinel `102.3` tự rớt |
| `cog` | `course` (độ) | qua `isValidCourse`; sentinel `360.0` tự rớt |
| `navigationalStatus` | `navStatus` | `{code, text}`; `15` = undefined → **null** |
| `timestamp` | `receivedAt` **và** `metadata.sourceReceivedAt` | xem §5 |
| — | `heading` | **luôn null**, xem §6 |
| — | `imo` | luôn null — PositionReport không mang IMO |
| — | `latLngApproximate` | `false` — AIS cho toạ độ đầy đủ |
| — | `metadata.source` | `AISSTREAM` |
| — | `metadata.fetchedAt` | tham số `receivedAt` do người gọi truyền |

`navStatus` chi tiết hơn:

- `0..8` → `{ code, text }` lấy từ bảng `NAV_STATUS` đã có.
- `9..13` (reserved) → `{ code, text: null }` — giữ mã thật, **không bịa nhãn**.
- `14` (AIS-SART) → có trong bảng.
- `15` (undefined/default) → **null**. Đó là "transponder không khai", không phải một trạng thái. Trả `{code:15}` sẽ cộng oan một điểm vào "độ đầy đủ chuyển động" mà `PositionResolver` dùng để so ứng viên.

### 4.2 ShipStaticData → `VesselIdentity` (nhóm A)

| Message | Canonical | Ghi chú |
|---|---|---|
| `mmsi` | `mmsi` | như trên |
| `imo` | `imo` | `0` = sentinel → **null**; sai checksum ISO 8713 → **null** |
| `name` | `name` | bỏ ký tự đệm `'@'`; rỗng → **null** |
| `type` | `vesselTypeCode` | `1..99`; `0` = "không có" → **null** |
| — | `vesselType` | **null** — AIS cho MÃ, không cho nhãn chữ |
| — | `callsign`, `flag` | **null** — không được chuyển tiếp / phải suy diễn từ MID |
| — | `metadata.sourceReceivedAt` | **null** — message 5 không mang mốc thời gian nào |

**Không phát nhóm rỗng:** `imo`, `name`, `type` đều là sentinel → mapper trả `EMPTY_IDENTITY`. Một identity chỉ có MMSI không nói thêm được gì so với chính bản ghi vị trí, mà lại làm phình `vessel_observations` với throughput AIS toàn cầu.

---

## 5. Ngữ nghĩa thời gian

> Bot nhận lúc **12:10**, AIS ghi **12:09:42** → `sourceReceivedAt = 12:09:42`, `fetchedAt = 12:10`.

Hai mốc **không bao giờ** mượn nhau. `PositionResolver` xếp bậc độ tươi **chỉ** bằng `sourceReceivedAt`; gán nó bằng `fetchedAt` là bịa độ tươi, và đó chính là thứ khiến ShipInfo (trễ ~14 giờ) sẽ thắng oan mọi nguồn khác.

### 🔴 Rủi ro contract: `timestamp` khai sai kiểu

`AisDataService.ts` khai `timestamp: number`, nhưng `_dataTransform` gán `data.MetaData.time_utc` — và AISStream.io phát field đó dạng **chuỗi giờ Go**:

```
2026-08-16 12:09:42.123456789 +0000 UTC
```

DTO của bot vì thế khai `string | number`, phản ánh **cả** hợp đồng khai báo lẫn giá trị chạy thật.

`parseAisSourceInstant()` chấp nhận:

| Dạng | |
|---|---|
| `2026-08-16 12:09:42.123456789 +0000 UTC` | Go — dạng đang chạy thật |
| `2026-08-16T12:09:42Z` | ISO 8601 |
| `2026-08-16T19:09:42+07:00` · `+0700` | ISO 8601 có offset, được quy về UTC |
| `2026-08-16 12:09:42` | trần → coi là UTC |
| **số** | ❌ **từ chối** |

**Vì sao từ chối số:** không có cách nào biết đơn vị là giây hay mili-giây, đoán sai lệch 1000 lần. Production hiện **không bao giờ** phát số (nó chuyển tiếp chuỗi), nên từ chối không mất dữ liệu nào. Nếu ngày nào đó production phát số thật, phải quyết đơn vị **tường minh** rồi mới mở.

**Vì sao dạng trần được coi là UTC ở đây, trong khi ShipInfo/ShipFinder thì không:** hai nguồn kia đọc mốc từ HTML **không hề khai múi giờ** — `SHIPFINDER_SOURCE_UTC_OFFSET_MINUTES` phải do người vận hành ký tên vào. Ở đây bằng chứng nằm trong code production: field tên `time_utc`, và Go luôn in kèm `+0000 UTC`. Suy luận có neo vào bằng chứng, không phải đoán mò.

### Mốc rơi vào tương lai

Quá `receivedAt + 5 phút` → **từ chối**. Không có lưới này, một mốc hỏng ở tương lai sẽ `LIVE` vĩnh viễn và thắng mọi nguồn khác trong resolver. Cùng ngưỡng với ShipFinder mapper.

### Mốc hỏng → làm gì (quyết định §10 của yêu cầu)

**Từ chối luôn báo cáo vị trí**, không giữ observation với `sourceReceivedAt = null`.

Lý do: canonical `VesselPositionReport.receivedAt` là `Date` **bắt buộc**, và `validateObservation` đánh `INVALID` khi nó không phải Date hợp lệ — bản ghi đó tới resolver cũng bị loại ở cổng đầu tiên. Đây đúng là quy ước ShipInfo/ShipFinder mapper đang dùng. Với AIS thì càng rẻ: tàu phát lại vị trí mỗi 2–10 giây.

⚠️ Khác với `ShipStaticData`: identity **không** có mốc nguồn theo bản chất, nên `sourceReceivedAt = null` ở đó là đúng, không phải lỗi.

---

## 6. Không suy diễn heading

```
cog = 123  →  course = 123 ·  heading = null
```

Course là hướng **đi trên mặt đất**, heading là hướng **mũi tàu**. Tàu bị dòng chảy/gió ép ngang thì hai giá trị lệch hàng chục độ. AIS message 1/2/3 **có** `TrueHeading`, nhưng Marine API không chuyển tiếp → với bot, heading **không tồn tại**.

FE muốn vẽ mũi tàu bằng course thì đó là quyết định của tầng hiển thị. Canonical không được bịa.

---

## 7. Validation — dùng lại, không viết mới

Không một dòng logic kiểm tra nào được viết mới. Mapper gọi thẳng validator P1:

| Cái gì | Hàm | Ở đâu |
|---|---|---|
| MMSI | `isValidMmsi` | `domain/validators/identifiers` |
| IMO | `isValidImo` (checksum ISO 8713) | `domain/validators/identifiers` |
| lat/lng | `isValidCoordinates` | `domain/validators/geo` |
| speed | `isValidSpeed` (0..102.2 kn) | `domain/validators/motion` |
| course | `isValidCourse` ([0,360)) | `domain/validators/motion` |
| metadata | `createSourceMetadata` | `domain/value-objects/SourceMetadata` |

Sentinel của AIS **tự rớt** qua chính các validator đó: `sog = 102.3` > trần 102.2, `cog = 360.0` ngoài `[0,360)`, `lat = 91.0` / `lng = 181.0` ngoài phạm vi. Không cần luật riêng cho sentinel.

Khi một field phụ hỏng, vị trí **vẫn giữ** — chỉ field đó thành `null`. Toạ độ mới là lõi.

---

## 8. Vì sao CHƯA persist

Global AIS là **hàng nghìn message/giây**. `insert` từng `PositionReport` sẽ giết Mongo, và phần lớn bản ghi là tàu đang neo lặp lại đúng một toạ độ.

Phase sau mới làm: coalescing theo MMSI · throttle · gộp mẻ · `bulkWrite` · bộ nhớ có trần.

Vì mapper **thuần** (không DB, không mạng, không `Date.now()`, không state), ghép mấy thứ đó vào sẽ **không phải sửa một dòng nào** trong mapper.

---

## 9. Tương thích Observation & Resolver

Mapper trả `ProviderDetailsResult` — **chính** kiểu mà 3 provider pull đang dùng. Không có `AISRepository` / `AISCanonicalService` / `AISResolver` nào được tạo.

```
mapMarineAisMessage()  →  ProviderDetailsResult
                       →  detailsResultToObservations()      (P5, có sẵn)
                       →  VesselSourceObservation
                       →  PositionResolver / IdentityResolver (P8, có sẵn)
```

AIS observation lưu **chung** `vessel_observations` với ShipFinder/ShipInfo/VesselFinder. Khác nhau đúng một field: `source`.

### Resolver — AIS **không** được hardcode thắng

Bậc độ tươi hiện tại giữ nguyên: `LIVE ≤ 30 phút < RECENT ≤ 6 giờ < STALE ≤ 24 giờ`. **Không** thêm bậc `REALTIME` ở phase này — tuổi chính xác luôn tính được từ `sourceReceivedAt`.

Ba ca có test khoá (`marineAisPipeline.test.ts`):

| Ca | Kết quả | Vì sao |
|---|---|---|
| AIS 10:05 · ShipFinder 10:00 · now 10:35 | **AIS thắng** | AIS `LIVE`, ShipFinder `RECENT` |
| AIS 10:05 · ShipFinder 10:10 · now 10:36 | **ShipFinder thắng** | đảo lại đúng ranh giới đó |
| AIS 10:05 · ShipFinder 10:10 · now 10:30 | **ShipFinder thắng** | cùng bậc `LIVE` → tiêu chí sau lên tiếng, và AIS thiếu `heading` nên đếm được 3/4 field chuyển động |

Ca thứ ba là ca đáng giá nhất: nó chứng minh AIS **không** có đặc quyền nào trong resolver.

Ở nhóm Identity thì hai bên **bổ sung** nhau theo field: AIS là nguồn duy nhất có `vesselTypeCode`, còn `callsign`/`vesselType`/`flag` đến từ nguồn crawl.

---

## 10. Capability matrix — thay đổi

| | Trước | Sau |
|---|---|---|
| CONFIRMED | 17 | **10** |
| CANDIDATE | 2 | **9** |
| UNSUPPORTED | 9 | 9 |
| `operations.particulars` | `true` | **`false`** |
| `operations.voyage` | `true` | **`false`** |

**CONFIRMED (10)** — đúng những gì `_dataTransform` phát:
`mmsi` · `lat` · `lng` · `speed` · `course` · `navStatus` · `positionReceivedAt` · `imo` · `name` · `vesselTypeCode`

**CANDIDATE (9)** — nguồn có, đường truyền chưa lấy được, hoặc phải suy diễn:
`heading` · `callsign` · `length` · `beam` · `draught` · `destination` · `eta` · `vesselType` · `flag`

**UNSUPPORTED (9)** — AIS không mang: `grossTonnage` · `deadweight` · `builtYear` · toàn bộ 6 field cảng.

### AISSTREAM vẫn KHÔNG phải nguồn crawl

CONFIRMED **không** có nghĩa bot được phép đi lấy. Giữ nguyên:

| | |
|---|---|
| `costType` | `EXISTING_STREAM` |
| `enabled` | `false` |
| `FreeSourceSelector` | loại ở **cổng chi phí đầu tiên** — có test khoá |
| `ProviderRegistry` | **không** có `AisStreamProvider` giả |
| `usesCrawlRuntime(AISSTREAM)` | `false` — `getExecutor` ném lỗi |

AIS là **PUSH source**. Không ép nó vào `VesselDataProvider.fetch(identifier)` chỉ để tái dùng registry — semantics của interface đó là kéo, không phải đẩy.

---

## 11. File

| File | Vai trò |
|---|---|
| `src/infrastructure/ais/MarineAisTypes.ts` | DTO ranh giới tích hợp + type guard hình dạng |
| `src/infrastructure/ais/MarineAisMessageMapper.ts` | mapper **thuần** |
| `src/infrastructure/ais/MarineAisMessageMapper.test.ts` | §17–§26 của yêu cầu |
| `src/infrastructure/ais/marineAisPipeline.test.ts` | §27–§28: observation + resolver |
| `src/application/capabilities/sourceCapabilityMatrix.ts` | capability AISSTREAM theo bằng chứng mới |

---

## 12. Rủi ro còn lại

| # | Rủi ro | Ảnh hưởng |
|---|---|---|
| 1 | `timestamp` khai `number` nhưng chạy `string`. Nếu ai đó "sửa cho đúng kiểu" ở production bằng cách `Number(time_utc)` thì bot sẽ **rớt toàn bộ vị trí** | 🔴 cao |
| 2 | Chưa xác minh được `time_utc` trên frame THẬT của production (audit đọc code, chưa bắt gói) | 🟡 |
| 3 | Marine API `_dataTransform` **ném lỗi** với message type lạ — `_handleWsMessage` bắt và bỏ qua. Bot vì thế vĩnh viễn không thấy message 18/19/24 (class B, static data report) | 🟡 |
| 4 | Bot chưa nối WS nội bộ → chưa có số đo throughput thật để thiết kế coalescing | 🟡 |
| 5 | Xung đột collection `vessels` giữa hai project vẫn chưa giải (MARINE_API_INTEGRATION_AUDIT §E.2) | 🔴 chặn phase sau |

---

## 13. Phase này KHÔNG làm

WebSocket ngoài · WebSocket nội bộ · Mongo ingestion · per-frame insert · scheduler · Redis · Kafka · GeoJSON · MyShipTracking · bậc freshness `REALTIME` · field cảng · sửa production.

> **AIS-2 đã nối WS nội bộ** (vẫn không có persistence): xem [AIS_MARINE_WS_BRIDGE.md](./AIS_MARINE_WS_BRIDGE.md).

---

*Bằng chứng lấy từ clone Soosky-marine-api nhánh mặc định. Không sửa file nào của production.*
