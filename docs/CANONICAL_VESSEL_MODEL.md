# CANONICAL_VESSEL_MODEL — Phase A1

> Chuẩn bị domain model cho crawler multi-source. **Mở rộng incremental**, không rewrite.
> Tiền đề: [CURRENT_ARCHITECTURE.md](./CURRENT_ARCHITECTURE.md), [CURRENT_DATA_FLOW.md](./CURRENT_DATA_FLOW.md).
> A1 **không** đụng persistence, HTTP contract, crawler, scheduler, FE.

---

## 1. Existing model TRƯỚC A1

Hai class, cả hai vẫn đang chạy production và **không bị xoá**.

### `src/domain/entities/Vessel.ts` — lý lịch tàu
| Field | Kiểu | Ai ghi thật |
|---|---|---|
| `mmsi` | `string` (khoá, BR-01: rơi về `imo` nếu thiếu) | ScanArea, Enrich, Crawl |
| `imo` | `string \| null` | Enrich, Crawl |
| `name` | `string \| null` | ScanArea (mp2), Enrich |
| `type` | `string \| null` | Enrich (nhãn "AIS Type") |
| `callsign` | `string \| null` | Enrich |
| `country` | `string \| null` | Enrich (nhãn "AIS Flag") |
| `lengthM` / `widthM` / `draughtM` | `number \| null` | Enrich |
| `flagCode`, `yearBuilt`, `grossTonnage`, `deadweight`, `photoUrl` | `… \| null` | **không ai ghi** — mapper không bóc |

### `src/domain/entities/VesselPosition.ts` — vị trí
| Field | Kiểu | Ghi chú |
|---|---|---|
| `mmsi` / `imo` | `string \| null` | khoá rơi về `imo` |
| `lat` / `lon` | `number \| null` | BR-03 loại toạ độ ngoài phạm vi |
| `speedKn` / `courseDeg` / `headingDeg` | `number \| null` | `headingDeg` **không ai ghi** |
| `navStatusCode` / `navStatusText` | `number \| null` / `string` | code **không ai ghi**; text mặc định `"Unknown"` |
| `destination` / `eta` | `string \| null` | **không ai ghi** |
| `positionTime` | `string \| null` | chuỗi TƯƠNG ĐỐI kiểu `"0 min ago"` |
| `source` | `"vesselfinder" \| "unknown"` | **union đóng** |
| `latLonApproximate` | `boolean` | toạ độ trang chi tiết bị làm tròn |
| `receivedAt` | `string` ISO | **không phải Date** |

Ba giới hạn chặn multi-source (audit A0 §6): `source` là union đóng (D-3), timestamp là chuỗi (D-13), không có provenance per-record (D-2).

---

## 2. Canonical model SAU A1

Không có class mới, không có framework entity. Chỉ interface + value object thuần.

```
src/domain/
  value-objects/
    VesselSource.ts        # 10 nguồn, giá trị = chuỗi ĐANG lưu trong DB
    SourceMetadata.ts      # provenance: source + fetchedAt + sourceReceivedAt + confidence
    VesselField.ts         # (thêm ở A2) từ vựng 28 field canonical, dùng cho source matrix
  validators/
    identifiers.ts         # isValidMmsi, isValidImo (checksum ISO 8713), imoCheckDigit
    geo.ts                 # isValidLatitude, isValidLongitude, isValidCoordinates
    motion.ts              # isValidSpeed, isValidCourse, isValidHeading
  canonical/
    VesselIdentity.ts      # nhóm A + value object VesselFlag
    VesselPositionReport.ts# nhóm B + value object NavigationStatus
    VesselParticulars.ts   # nhóm C
    VesselVoyage.ts        # nhóm D
    legacyMapping.ts       # entity hiện tại -> canonical (thuần, CHƯA nối vào đâu)
  entities/                # GIỮ NGUYÊN, chỉ sửa VesselPosition 2 chỗ (xem §5)
```

### Nguyên tắc thiết kế
- **Mỗi bản ghi canonical = "nguồn X nói gì về tàu Y"**, chưa phải kết quả đã hợp nhất. Vì vậy `metadata: SourceMetadata` là **bắt buộc** ở cả 4 nhóm — không có provenance thì không arbitrate được.
- `mmsi: string` bắt buộc ở cả 4 nhóm (khớp BR-01 hiện tại). Mọi field dữ liệu khác **optional** — không nguồn nào cấp đủ.
- Không import mongoose/express/crawler. Không chứa field của schema nguồn cụ thể.
- Không CQRS, không event sourcing, không DI framework, không generic entity.

### `VesselSource` — thay union đóng
Value = **chuỗi chữ thường đang nằm trong MongoDB**, nên `"vesselfinder"` và `"unknown"` giữ nguyên bit-for-bit → **không cần migration**.

`AISSTREAM · VESSELFINDER · SHIPINFO · SHIPFINDER · BOATNERD · MARINETRAFFIC_LIVE · SHIPTRAFFIC · VESSELTRACKER · MYSHIPTRACKING · UNKNOWN`

`parseVesselSource(raw)` nhận cả dạng hằng viết hoa lẫn dạng DB, giá trị lạ → `UNKNOWN`, **không ném lỗi** (dữ liệu cũ không được phép làm sập tiến trình đọc).

### `SourceMetadata` — tách 2 mốc thời gian
| Field | Bắt buộc | Ý nghĩa |
|---|---|---|
| `source` | ✅ | nguồn cấp bản ghi |
| `fetchedAt` | ✅ `Date` | lúc **bot** lấy được — đồng hồ của ta |
| `sourceReceivedAt` | optional `Date \| null` | lúc **nguồn** khai báo nhận tín hiệu — đồng hồ của nguồn |
| `confidence` | optional `number \| null` | 0..1, do policy sau này gán |

Tách 2 mốc là lý do tồn tại của value object này: so độ tươi giữa các nguồn phải dùng `sourceReceivedAt`, không phải `fetchedAt`. Entity hiện tại chỉ có **một** mốc (`receivedAt` = lúc ghi DB) nên không phân biệt được.

`createSourceMetadata()` ném lỗi ngay khi gặp Invalid Date hoặc `confidence` ngoài [0,1].

---

## 3. Mapping: entity hiện tại → canonical

Bảng dưới được **khoá bằng test** trong `src/domain/canonical/legacyMapping.test.ts`. Sửa mapping mà quên sửa bảng này → test đỏ.

### Nhóm A · Identity ← `Vessel`
| Canonical | Legacy | Ghi chú |
|---|---|---|
| `mmsi` | `Vessel.mmsi` | 1-1 |
| `imo` | `Vessel.imo` | 1-1 |
| `name` | `Vessel.name` | 1-1 |
| `callsign` | `Vessel.callsign` | 1-1 |
| `vesselType` | `Vessel.type` | đổi tên |
| `vesselTypeCode` | — | **luôn null**: mapper VesselFinder bỏ qua `#djson.ship_type` |
| `flag.name` | `Vessel.country` | `country` thực chất là nhãn "AIS Flag" |
| `flag.code` | `Vessel.flagCode` | legacy chưa bao giờ ghi → null |
| `metadata` | — | mới |

`flagCode` và `country` đều null → `flag = null` (không tạo object rỗng).

### Nhóm B · Position ← `VesselPosition`
| Canonical | Legacy | Ghi chú |
|---|---|---|
| `mmsi` | `mmsi` | **bắt buộc**; legacy cho null → mapping trả `null` |
| `imo` | `imo` | 1-1 |
| `lat` | `lat` | **bắt buộc** |
| `lng` | `lon` | ⚠️ **đổi tên** `lon` → `lng` theo canonical spec |
| `speed` | `speedKn` | bỏ hậu tố đơn vị, giá trị giữ nguyên knots |
| `course` | `courseDeg` | như trên |
| `heading` | `headingDeg` | như trên |
| `navStatus.code` | `navStatusCode` | gom vào value object |
| `navStatus.text` | `navStatusText` | `"Unknown"` + code null → `navStatus = null` |
| `latLngApproximate` | `latLonApproximate` | đổi tên theo `lng` |
| `receivedAt` | `receivedAt` | ⚠️ **chuỗi ISO → `Date`** |
| `metadata` | `source` (một phần) | `source` chuyển vào metadata |
| — | `positionTime` | ❌ **KHÔNG map**: `"0 min ago"` là chuỗi tương đối, parse ra sẽ sai |

`toVesselPositionReport()` trả `null` khi thiếu mmsi, thiếu/sai toạ độ, hoặc `receivedAt` không parse được.

### Nhóm C · Particulars ← `Vessel`
| Canonical | Legacy | Ghi chú |
|---|---|---|
| `length` | `lengthM` | mét, giá trị giữ nguyên |
| `beam` | `widthM` | mét |
| `draught` | `draughtM` | mét |
| `builtYear` | `yearBuilt` | đổi tên |
| `grossTonnage` / `deadweight` | 1-1 | legacy chưa bao giờ ghi |

⚠️ `draught` (mớn nước) đổi theo chuyến, khác `length`/`beam` là hằng số. Xếp chung nhóm để khớp canonical spec, nhưng merge policy sau này phải xử lý nó theo độ tươi.

### Nhóm D · Voyage ← `VesselPosition`
| Canonical | Legacy |
|---|---|
| `destination` | `destination` (legacy chưa bao giờ ghi) |
| `eta` | `eta` chuỗi → `Date \| null` |
| `currentPort` / `currentPortArrivalAt` | ❌ không có nguồn |
| `nextPort` / `nextPortEta` | ❌ không có nguồn |
| `lastPort` / `lastPortDepartureAt` | ❌ không có nguồn |

Nhóm rỗng nhất ở A1 — khai báo trước để nguồn sau đổ vào mà không phải sửa domain.

### Chiều ngược lại
`canonical → entity` **cố ý không viết**. A1 không đổi persistence nên không ai cần ghi ngược.

---

## 4. Đơn vị (canonical)

| Đại lượng | Đơn vị | Kiểu | Ràng buộc validator |
|---|---|---|---|
| `lat` / `lng` | decimal degrees, WGS84 | `number` | `[-90,90]` / `[-180,180]`, hữu hạn |
| `speed` | **knots** (SOG) | `number` | `[0, 102.2]` — 1023 = not available |
| `course` | **degrees** (COG) | `number` | `[0, 360)` — 3600 = not available |
| `heading` | **degrees** (true heading) | `number` | số nguyên `[0, 359]` — 511 = not available |
| `length` / `beam` / `draught` | **mét** | `number` | — |
| `grossTonnage` | GT | `number` | — |
| `deadweight` | tấn | `number` | — |
| `builtYear` | năm | `number` | — |
| `receivedAt`, `fetchedAt`, `sourceReceivedAt`, `eta`, `*ArrivalAt`, `*DepartureAt`, `*Eta` | **UTC `Date`** | `Date` | không nhận Invalid Date |
| `destination`, `*Port` | chuỗi thô của nguồn | `string` | không chuẩn hoá ở domain (AIS destination do thuyền viên gõ tay) |

Ngưỡng speed/course/heading lấy theo AIS message 1/2/3 — đây là ranh giới của **dữ liệu**, không của một nguồn cụ thể, nên đặt ở domain là đúng chỗ.

---

## 5. Backward compatibility

### Đã sửa — đúng 1 file, 2 chỗ, hành vi KHÔNG đổi
`src/domain/entities/VesselPosition.ts`:

1. **`PositionSource` = alias của `VesselSource`** (mở rộng union).
   - Tên type giữ nguyên → không import nào bị phá.
   - Chỉ **nới rộng** tập giá trị hợp lệ → mọi phép gán `"vesselfinder"` / `"unknown"` đang có vẫn compile.
   - `this.source = props.source ?? "unknown"` giữ nguyên — **không** chuẩn hoá giá trị đọc từ DB, nên `/positions` và popup FE (`render.js` in `p.source`) trả về y hệt trước.
   - `MongoVesselRepository.toEntity()` giữ nguyên cast `as VesselPosition["source"]` — không đụng repository.
2. **Bỏ `private static isValidLat/isValidLon`, gọi `validators/geo`.**
   - Logic mới thêm `Number.isFinite`, nhưng `NaN`/`Infinity` vốn đã fail phép so sánh cũ → **kết quả y hệt** cho mọi input. BR-03 không đổi.

Có thêm `src/domain/entities/VesselPosition.test.ts` chốt cả hai điểm trên.

### Cố ý KHÔNG sửa
| Thứ | Vì sao |
|---|---|
| `Vessel.ts` | Nối `isValidMmsi`/`isValidImo` vào constructor sẽ **ném lỗi trên dữ liệu đang có trong DB** (mmsi rơi về imo 7 số, mmsi bắt đầu bằng 0…). |
| `GetVesselDetails` / `ManageWatchlist` regex `^\d{7,9}$` | Siết lại = đổi HTTP contract (request đang 200 sẽ thành 400). |
| Mongoose schema, index, `latestpositions` | A1 không migrate DB. |
| `ScanArea`, `EnrichVesselTypes`, `CrawlFleetPositions` | Không đụng. |
| `/positions`, `/vessel/:id` response | Không đổi field nào. |
| FE `public/` | Không đụng. |
| AISStream, nguồn mới, MyShipTracking | Không kết nối ở phase này. |

### Validator CHƯA được nối vào đâu
`isValidMmsi`, `isValidImo`, `isValidSpeed`, `isValidCourse`, `isValidHeading` hiện **không có caller production** — chỉ có test. Đây là chủ ý: nối vào ngay sẽ làm rơi dữ liệu đang chạy. Duy nhất `geo.ts` được nối (vì nó chính là logic cũ vừa tách ra).

### `legacyMapping.ts` chưa có caller production
Không use case / repository / route nào gọi. Nó tồn tại để (1) chứng minh canonical model biểu diễn đủ dữ liệu hiện có, (2) khoá bảng mapping §3 bằng test.

---

## 6. Persistence migration CHƯA thực hiện

Danh sách này là **nợ có chủ ý**, thuộc phase sau.

| # | Chưa làm | Ảnh hưởng | Debt gốc |
|---|---|---|---|
| M-1 | `receivedAt` vẫn là **String ISO** trong Mongo, chưa đổi sang `Date` | không dùng được TTL index; so sánh vẫn theo chuỗi | D-13 |
| M-2 | `latestpositions.mmsi` vẫn **unique** | 1 tàu vẫn chỉ giữ 1 vị trí, chưa phân biệt được nguồn | D-1 |
| M-3 | Chưa có collection/field cho `SourceMetadata` | provenance mới chỉ tồn tại ở domain, chưa persist | D-2 |
| M-4 | `savePositionLatest` vẫn `replaceOne` (last-write-wins) | ScanArea vẫn xoá `speed`/`course` mà Enrich vừa điền | D-1, §3 data-flow |
| M-5 | Chưa tách 4 nhóm canonical thành 4 collection | `vessels`/`latestpositions` vẫn trộn Identity + Particulars | — |
| M-6 | Chưa migrate `country` → `flag.name`, `flagCode` → `flag.code` | schema cũ giữ nguyên | — |
| M-7 | Chưa xử lý `positionTime` (`"0 min ago"`) thành mốc thời gian thật | canonical cố ý bỏ field này | — |
| M-8 | `MongoVesselRepository.toEntity()` vẫn cast `as` thay vì `parseVesselSource()` | giá trị source lạ trong DB vẫn lọt qua nguyên văn | D-3 |
| M-9 | N+1 write trong `ScanArea.saveShips()` | chưa đụng theo yêu cầu A1 | D-8 |

---

## 7. Kiểm chứng

```
npm run build   # tsc, không lỗi
npm test        # 98 pass / 0 fail  (baseline trước A1: 56 pass)
```

Cập nhật sau A2: 127 pass / 0 fail. A2 **không sửa** file canonical nào — chỉ thêm
`VesselField.ts` (từ vựng field) và tầng `src/application/capabilities/`.
Xem [SOURCE_CAPABILITY_MATRIX.md](./SOURCE_CAPABILITY_MATRIX.md).
