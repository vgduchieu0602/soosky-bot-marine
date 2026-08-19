# Mô hình tàu chuẩn — Giai đoạn A1

> Chuẩn bị model domain cho crawler nhiều nguồn. Đây là **mở rộng từng bước**, không phải viết lại.
> Đọc trước: [CURRENT_ARCHITECTURE.md](./CURRENT_ARCHITECTURE.md), [CURRENT_DATA_FLOW.md](./CURRENT_DATA_FLOW.md).
> A1 **không** đụng tới lưu trữ, hợp đồng HTTP, crawler, scheduler hay frontend.

---

## 1. Model đang có TRƯỚC A1

Hai class, cả hai vẫn đang chạy production và **không bị xoá**.

### `src/domain/entities/Vessel.ts` — lý lịch tàu

| Trường | Kiểu | Ai thực sự ghi vào |
|---|---|---|
| `mmsi` | `string` (khoá; theo luật BR-01 sẽ lấy `imo` thay thế nếu thiếu) | ScanArea, Enrich, Crawl |
| `imo` | `string \| null` | Enrich, Crawl |
| `name` | `string \| null` | ScanArea (mp2), Enrich |
| `type` | `string \| null` | Enrich (lấy từ nhãn "AIS Type") |
| `callsign` | `string \| null` | Enrich |
| `country` | `string \| null` | Enrich (lấy từ nhãn "AIS Flag") |
| `lengthM` / `widthM` / `draughtM` | `number \| null` | Enrich |
| `flagCode`, `yearBuilt`, `grossTonnage`, `deadweight`, `photoUrl` | `… \| null` | **không ai ghi** — mapper không bóc tách những trường này |

### `src/domain/entities/VesselPosition.ts` — vị trí

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `mmsi` / `imo` | `string \| null` | khoá; thiếu mmsi thì lấy imo |
| `lat` / `lon` | `number \| null` | luật BR-03 loại bỏ toạ độ ngoài phạm vi |
| `speedKn` / `courseDeg` / `headingDeg` | `number \| null` | `headingDeg` **không ai ghi** |
| `navStatusCode` / `navStatusText` | `number \| null` / `string` | code **không ai ghi**; text mặc định `"Unknown"` |
| `destination` / `eta` | `string \| null` | **không ai ghi** |
| `positionTime` | `string \| null` | chuỗi **tương đối** kiểu `"0 min ago"` |
| `source` | `"vesselfinder" \| "unknown"` | **union đóng**, chỉ hai giá trị |
| `latLonApproximate` | `boolean` | toạ độ lấy từ trang chi tiết bị làm tròn |
| `receivedAt` | `string` ISO | **là chuỗi, không phải Date** |

Ba giới hạn này chặn đường đi tới đa nguồn (theo rà soát A0 mục 6): `source` là union đóng (nợ D-3), mốc thời gian là chuỗi (nợ D-13), và không có thông tin nguồn gốc cho từng bản ghi (nợ D-2).

---

## 2. Model chuẩn SAU A1

Không thêm class mới, không dùng entity của framework nào. Chỉ có interface và value object thuần.

```
src/domain/
  value-objects/
    VesselSource.ts        # 10 nguồn; giá trị chính là chuỗi ĐANG nằm trong DB
    SourceMetadata.ts      # nguồn gốc: source + fetchedAt + sourceReceivedAt + confidence
    VesselField.ts         # (thêm ở A2) từ vựng 28 trường chuẩn, dùng cho bảng năng lực nguồn
  validators/
    identifiers.ts         # isValidMmsi, isValidImo (checksum ISO 8713), imoCheckDigit
    geo.ts                 # isValidLatitude, isValidLongitude, isValidCoordinates
    motion.ts              # isValidSpeed, isValidCourse, isValidHeading
  canonical/
    VesselIdentity.ts        # nhóm A + value object VesselFlag
    VesselPositionReport.ts  # nhóm B + value object NavigationStatus
    VesselParticulars.ts     # nhóm C
    VesselVoyage.ts          # nhóm D
    legacyMapping.ts         # entity hiện tại -> chuẩn (thuần tuý, CHƯA nối vào đâu)
  entities/                  # GIỮ NGUYÊN, chỉ sửa VesselPosition ở 2 chỗ (xem mục 5)
```

### Nguyên tắc thiết kế

- **Mỗi bản ghi chuẩn nghĩa là "nguồn X nói gì về tàu Y"**, chưa phải kết quả đã hợp nhất. Vì vậy `metadata: SourceMetadata` là **bắt buộc** ở cả 4 nhóm — không có nguồn gốc thì không thể phân xử khi các nguồn mâu thuẫn.
- `mmsi: string` bắt buộc ở cả 4 nhóm (khớp luật BR-01 hiện tại). Mọi trường dữ liệu khác đều **tuỳ chọn** — không nguồn nào cấp đủ hết.
- Không import mongoose/express/crawler. Không chứa trường thuộc schema riêng của một nguồn cụ thể.
- Không CQRS, không event sourcing, không DI framework, không entity generic.

### `VesselSource` — thay cho union đóng

Giá trị chính là **chuỗi chữ thường đang nằm trong MongoDB**, nên `"vesselfinder"` và `"unknown"` giữ nguyên từng byte, do đó **không cần migrate dữ liệu**.

Danh sách: `AISSTREAM · VESSELFINDER · SHIPINFO · SHIPFINDER · BOATNERD · MARINETRAFFIC_LIVE · SHIPTRAFFIC · VESSELTRACKER · MYSHIPTRACKING · UNKNOWN`

`parseVesselSource(raw)` nhận cả dạng hằng viết hoa lẫn dạng lưu trong DB. Gặp giá trị lạ thì trả `UNKNOWN` và **không ném lỗi** — dữ liệu cũ không được phép làm sập tiến trình đọc.

### `SourceMetadata` — tách hai mốc thời gian

| Trường | Bắt buộc | Ý nghĩa |
|---|---|---|
| `source` | có | nguồn đã cấp bản ghi này |
| `fetchedAt` | có, kiểu `Date` | lúc **bot** lấy được — đồng hồ của ta |
| `sourceReceivedAt` | tuỳ chọn, `Date \| null` | lúc **nguồn** khai báo đã nhận tín hiệu — đồng hồ của nguồn |
| `confidence` | tuỳ chọn, `number \| null` | 0..1, do chính sách sau này gán |

Việc tách hai mốc chính là lý do value object này tồn tại: muốn so độ tươi giữa các nguồn thì phải dùng `sourceReceivedAt`, không phải `fetchedAt`. Entity hiện tại chỉ có **một** mốc (`receivedAt` = lúc ghi DB) nên không phân biệt được hai chuyện đó.

`createSourceMetadata()` ném lỗi ngay khi gặp Invalid Date hoặc `confidence` nằm ngoài khoảng [0,1].

---

## 3. Ánh xạ: entity hiện tại → model chuẩn

Bảng dưới đây được **khoá bằng test** trong `src/domain/canonical/legacyMapping.test.ts`. Sửa mapping mà quên sửa bảng này thì test sẽ đỏ.

### Nhóm A · Danh tính ← `Vessel`

| Chuẩn | Cũ | Ghi chú |
|---|---|---|
| `mmsi` | `Vessel.mmsi` | 1-1 |
| `imo` | `Vessel.imo` | 1-1 |
| `name` | `Vessel.name` | 1-1 |
| `callsign` | `Vessel.callsign` | 1-1 |
| `vesselType` | `Vessel.type` | chỉ đổi tên |
| `vesselTypeCode` | — | **luôn null**: mapper VesselFinder bỏ qua `#djson.ship_type` |
| `flag.name` | `Vessel.country` | `country` thực chất là nhãn "AIS Flag" |
| `flag.code` | `Vessel.flagCode` | bản cũ chưa bao giờ ghi nên luôn null |
| `metadata` | — | mới thêm |

Nếu cả `flagCode` và `country` đều null thì `flag = null` — không tạo object rỗng.

### Nhóm B · Vị trí ← `VesselPosition`

| Chuẩn | Cũ | Ghi chú |
|---|---|---|
| `mmsi` | `mmsi` | **bắt buộc**; bản cũ cho phép null nên mapping sẽ trả `null` |
| `imo` | `imo` | 1-1 |
| `lat` | `lat` | **bắt buộc** |
| `lng` | `lon` | **đổi tên** `lon` thành `lng` theo đặc tả chuẩn |
| `speed` | `speedKn` | bỏ hậu tố đơn vị, giá trị vẫn là knot |
| `course` | `courseDeg` | như trên |
| `heading` | `headingDeg` | như trên |
| `navStatus.code` | `navStatusCode` | gom vào value object |
| `navStatus.text` | `navStatusText` | nếu text là `"Unknown"` và code null thì `navStatus = null` |
| `latLngApproximate` | `latLonApproximate` | đổi tên cho khớp với `lng` |
| `receivedAt` | `receivedAt` | **chuỗi ISO đổi thành `Date`** |
| `metadata` | `source` (một phần) | `source` chuyển vào trong metadata |
| — | `positionTime` | **KHÔNG ánh xạ**: `"0 min ago"` là chuỗi tương đối, parse ra sẽ sai |

`toVesselPositionReport()` trả `null` khi thiếu mmsi, thiếu hoặc sai toạ độ, hoặc `receivedAt` không parse được.

### Nhóm C · Thông số kỹ thuật ← `Vessel`

| Chuẩn | Cũ | Ghi chú |
|---|---|---|
| `length` | `lengthM` | mét, giữ nguyên giá trị |
| `beam` | `widthM` | mét |
| `draught` | `draughtM` | mét |
| `builtYear` | `yearBuilt` | chỉ đổi tên |
| `grossTonnage` / `deadweight` | 1-1 | bản cũ chưa bao giờ ghi |

Lưu ý: `draught` (mớn nước) **thay đổi theo từng chuyến**, khác với `length`/`beam` là hằng số của con tàu. Xếp chung nhóm cho khớp đặc tả chuẩn, nhưng chính sách hợp nhất sau này phải xử lý nó theo độ tươi.

### Nhóm D · Hành trình ← `VesselPosition`

| Chuẩn | Cũ |
|---|---|
| `destination` | `destination` (bản cũ chưa bao giờ ghi) |
| `eta` | `eta` dạng chuỗi, đổi thành `Date \| null` |
| `currentPort` / `currentPortArrivalAt` | không có nguồn nào cấp |
| `nextPort` / `nextPortEta` | không có nguồn nào cấp |
| `lastPort` / `lastPortDepartureAt` | không có nguồn nào cấp |

Đây là nhóm rỗng nhất ở A1. Khai báo trước để khi có nguồn mới thì đổ dữ liệu vào mà không phải sửa domain.

### Chiều ngược lại

Ánh xạ từ chuẩn về entity cũ **cố ý không viết**. A1 không đổi phần lưu trữ nên chưa ai cần ghi ngược.

---

## 4. Đơn vị đo (theo chuẩn)

| Đại lượng | Đơn vị | Kiểu | Ràng buộc |
|---|---|---|---|
| `lat` / `lng` | độ thập phân, WGS84 | `number` | `[-90,90]` / `[-180,180]`, phải hữu hạn |
| `speed` | **knot** (tốc độ trên mặt đất, SOG) | `number` | `[0, 102.2]` — giá trị 1023 nghĩa là không có dữ liệu |
| `course` | **độ** (hướng di chuyển, COG) | `number` | `[0, 360)` — giá trị 3600 nghĩa là không có dữ liệu |
| `heading` | **độ** (hướng mũi tàu thật) | `number` | số nguyên `[0, 359]` — giá trị 511 nghĩa là không có dữ liệu |
| `length` / `beam` / `draught` | **mét** | `number` | — |
| `grossTonnage` | GT | `number` | — |
| `deadweight` | tấn | `number` | — |
| `builtYear` | năm | `number` | — |
| `receivedAt`, `fetchedAt`, `sourceReceivedAt`, `eta`, `*ArrivalAt`, `*DepartureAt`, `*Eta` | **`Date` theo UTC** | `Date` | không nhận Invalid Date |
| `destination`, `*Port` | chuỗi thô của nguồn | `string` | không chuẩn hoá ở domain (ô destination trong AIS do thuyền viên gõ tay) |

Các ngưỡng của speed/course/heading lấy theo bản tin AIS loại 1/2/3. Đây là ranh giới của **bản thân dữ liệu**, không phải của riêng nguồn nào, nên đặt ở tầng domain là đúng chỗ.

---

## 5. Tương thích ngược

### Đã sửa — đúng 1 file, 2 chỗ, hành vi KHÔNG đổi

Trong `src/domain/entities/VesselPosition.ts`:

1. **`PositionSource` trở thành alias của `VesselSource`** (nới rộng union).
   - Tên type giữ nguyên nên không import nào bị vỡ.
   - Chỉ **nới rộng** tập giá trị hợp lệ, nên mọi phép gán `"vesselfinder"` / `"unknown"` đang có vẫn biên dịch được.
   - Dòng `this.source = props.source ?? "unknown"` giữ nguyên — **không** chuẩn hoá giá trị đọc từ DB, nên `/positions` và popup frontend (`render.js` in ra `p.source`) trả về y hệt như trước.
   - `MongoVesselRepository.toEntity()` giữ nguyên phép ép kiểu `as VesselPosition["source"]` — không đụng vào repository.
2. **Bỏ `private static isValidLat/isValidLon`, chuyển sang gọi `validators/geo`.**
   - Logic mới thêm `Number.isFinite`, nhưng `NaN`/`Infinity` vốn đã trượt phép so sánh cũ, nên **kết quả y hệt** với mọi đầu vào. Luật BR-03 không đổi.

Có thêm `src/domain/entities/VesselPosition.test.ts` để chốt cả hai điểm trên.

### Cố ý KHÔNG sửa

| Thứ | Vì sao |
|---|---|
| `Vessel.ts` | Nối `isValidMmsi`/`isValidImo` vào constructor sẽ **ném lỗi ngay trên dữ liệu đang có trong DB** (mmsi bị thay bằng imo 7 số, mmsi bắt đầu bằng số 0...). |
| Regex `^\d{7,9}$` trong `GetVesselDetails` / `ManageWatchlist` | Siết chặt lại chính là đổi hợp đồng HTTP: request đang trả 200 sẽ thành 400. |
| Schema Mongoose, index, `latestpositions` | A1 không migrate DB. |
| `ScanArea`, `EnrichVesselTypes`, `CrawlFleetPositions` | Không đụng. |
| Response của `/positions`, `/vessel/:id` | Không đổi trường nào. |
| Frontend trong `public/` | Không đụng. |
| AISStream, nguồn mới, MyShipTracking | Chưa kết nối ở giai đoạn này. |

### Các validator CHƯA được nối vào đâu

`isValidMmsi`, `isValidImo`, `isValidSpeed`, `isValidCourse`, `isValidHeading` hiện **chưa có chỗ nào trong production gọi** — chỉ có test dùng. Đây là chủ ý: nối vào ngay sẽ làm rơi dữ liệu đang chạy. Riêng `geo.ts` thì đã được nối, vì nó chính là logic cũ vừa tách ra.

### `legacyMapping.ts` cũng chưa có ai gọi

Không use case, repository hay route nào gọi tới. Nó tồn tại để: (1) chứng minh model chuẩn biểu diễn được đủ dữ liệu hiện có, và (2) khoá bảng ánh xạ ở mục 3 bằng test.

---

## 6. Phần migrate lưu trữ CHƯA làm

Danh sách này là **nợ kỹ thuật có chủ ý**, thuộc các giai đoạn sau.

| # | Chưa làm | Ảnh hưởng | Nợ gốc |
|---|---|---|---|
| M-1 | `receivedAt` trong Mongo vẫn là chuỗi ISO, chưa đổi sang `Date` | không dùng được TTL index; so sánh vẫn theo chuỗi | D-13 |
| M-2 | `latestpositions.mmsi` vẫn unique | một tàu vẫn chỉ giữ được một vị trí, chưa phân biệt theo nguồn | D-1 |
| M-3 | Chưa có collection hay trường nào cho `SourceMetadata` | thông tin nguồn gốc mới tồn tại ở domain, chưa được lưu | D-2 |
| M-4 | `savePositionLatest` vẫn dùng `replaceOne` (ai ghi sau thì thắng) | ScanArea vẫn xoá mất `speed`/`course` mà Enrich vừa điền | D-1, mục 3 của tài liệu luồng dữ liệu |
| M-5 | Chưa tách 4 nhóm chuẩn thành 4 collection | `vessels`/`latestpositions` vẫn trộn lẫn danh tính và thông số kỹ thuật | — |
| M-6 | Chưa migrate `country` sang `flag.name`, `flagCode` sang `flag.code` | schema cũ giữ nguyên | — |
| M-7 | Chưa xử lý `positionTime` (`"0 min ago"`) thành mốc thời gian thật | model chuẩn cố ý bỏ trường này | — |
| M-8 | `MongoVesselRepository.toEntity()` vẫn ép kiểu bằng `as` thay vì gọi `parseVesselSource()` | giá trị source lạ trong DB vẫn lọt qua nguyên văn | D-3 |
| M-9 | Còn lỗi N+1 khi ghi trong `ScanArea.saveShips()` | chưa đụng, đúng theo phạm vi A1 | D-8 |

---

## 7. Kiểm chứng

```
npm run build   # tsc, không lỗi
npm test        # 98 pass / 0 fail  (mức nền trước A1: 56 pass)
```

Cập nhật sau A2: 127 pass / 0 fail. A2 **không sửa** file chuẩn nào — chỉ thêm `VesselField.ts` (từ vựng trường dữ liệu) và tầng `src/application/capabilities/`. Xem thêm [SOURCE_CAPABILITY_MATRIX.md](./SOURCE_CAPABILITY_MATRIX.md).
