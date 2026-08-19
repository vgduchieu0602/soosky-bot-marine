# Chuẩn bị dữ liệu chuẩn cho bản đồ — giai đoạn MAP-1

> Chuẩn bị `canonical_current_vessels` để **sau này** Marine API truy vấn tàu theo viewport/bbox.
>
> Giai đoạn này **không** tạo endpoint, **không** clustering, **không** đụng production.

---

## 0. Tóm tắt

| # | | |
|---|---|---|
| 1 | Độ tươi **tính lại lúc đọc**, không bao giờ tin `position.freshness` đã lưu | 🔴 quan trọng nhất |
| 2 | Chỉ cần MMSI + toạ độ + mốc nguồn là vẽ được. IMO/tên/loại **không** bắt buộc | 🟢 |
| 3 | `location` là **phép chiếu persistence**, không phải sự thật canonical | 🟢 |
| 4 | Toạ độ GeoJSON là **[lng, lat]** — đảo là tàu nhảy bán cầu, không lỗi nào ném ra | 🔴 |
| 5 | Vị trí biến mất → `$unset` location, không để toạ độ ma | 🟢 |
| 6 | `$geoWithin` + `$box` **KHÔNG dùng được** 2dsphere. Phải `$geometry` Polygon | 🔴 MAP-2 |
| 7 | Không TTL trên canonical, không index geo trên observation | 🟢 |

---

## 1. Canonical hiện có gì

`ResolvedCurrentVessel` (đọc từ `canonical_current_vessels`):

```
vesselKey   { mmsi?, imo? }              ← khoá tra, chuỗi
identity    ResolvedIdentity | null      ← từng field kèm xuất xứ
position    ResolvedPosition | null      ← NGUYÊN KHỐI
particulars ResolvedParticulars | null
voyage      ResolvedVoyage | null
resolvedAt  Date
```

`ResolvedPosition` = `{ position: VesselPositionReport, source, observationId?, observedAt: Date|null, fetchedAt, freshness, reason, rejected[] }`

Đối chiếu với thứ map cần:

| Map cần | Canonical có | Ghi chú |
|---|---|---|
| `mmsi` | `vesselKey.mmsi` | **chuỗi**, không phải số |
| `imo` | `vesselKey.imo` / `identity.imo.value` | chuỗi, `null` khi chưa biết |
| `vesselName` | `identity.name.value` | `null` khi chưa có `ShipStaticData` |
| `vType` | `identity.vesselTypeCode.value` | **chỉ AIS cấp được** |
| `lat` | `position.position.lat` | |
| `lon` | `position.position.**lng**` | ⚠️ canonical dùng `lng` |
| `course` / `speed` | `position.position.course` / `.speed` | `null` khi sentinel AIS |
| `navStatus` | `position.position.navStatus` | `{code, text}` — không phải chuỗi trần |
| `received` | `position.**observedAt**` | mốc NGUỒN, không phải `fetchedAt` |

⇒ **Canonical đã đủ dữ liệu.** MAP-1 không thêm field nghiệp vụ nào.

⚠️ Bot **không** dựng `VesselSimple`. Đổi tên `lng`→`lon`, chuỗi→số, `null`→`0`/`"N/A"` là việc của **adapter tương thích Marine API** ở phase sau. Canonical giữ độc lập.

---

## 2. Điều kiện vẽ

| Bắt buộc | Không bắt buộc |
|---|---|
| `mmsi` | `imo` |
| `lat`/`lng` hợp lệ | `name` |
| `observedAt` còn hạn | `vesselTypeCode` · `speed` · `course` · `navStatus` |

Thiếu thì để `null`. ⛔ **Không** `imo = 0`, **không** `name = "N/A"`, **không** `speed = 0`.

Ép phải có tên mới được vẽ sẽ giấu mất phần lớn tàu vừa phát `PositionReport` mà chưa tới chu kỳ `ShipStaticData` (~6 phút).

```ts
evaluateMapReadiness(vessel, now, policy) -> { ready, reason?, ageMs? }
```

| `reason` | |
|---|---|
| `NO_MMSI` | tàu chỉ biết IMO — map của Marine đánh địa chỉ bằng MMSI |
| `NO_POSITION` | chưa nhóm POSITION nào được phân xử |
| `INVALID_POSITION` | toạ độ ngoài phạm vi/NaN, **hoặc** mốc nguồn ở tương lai xa |
| `NO_POSITION_TIME` | có vị trí nhưng nguồn không khai mốc (`NO_SOURCE_TIME`) |
| `STALE_POSITION` | quá ngưỡng tuổi |

Năm mã, không hơn. Không dựng enum framework.

---

## 3. 🔴 Vì sao KHÔNG được tin `freshness` đã lưu

```ts
canonical.position.freshness === "LIVE"      // ← đã lưu
canonical.position.observedAt  = 2 ngày trước
```

Cả hai đều **đúng** tại thời điểm ghi. Vấn đề: canonical chỉ được ghi lại **khi có dữ liệu mới** (AIS-5 §6). Tàu ngừng phát tín hiệu thì không có gì kích hoạt lần resolve tiếp theo, nên bậc `LIVE` **đóng băng trong document mãi mãi**.

Bậc độ tươi là **ảnh chụp tại lúc phân xử**, không phải một sự thật vĩnh viễn.

```ts
ageMs = now - position.observedAt        // TÍNH LẠI mỗi lần hỏi
if (ageMs > maxPositionAgeMs) → NOT READY
```

Có test khoá đúng kịch bản này: document nói `LIVE`, `observedAt` 2 ngày trước ⇒ `STALE_POSITION`.

**Ngưỡng dùng lại hằng số đã có:** `DEFAULT_MAP_READINESS_POLICY.maxPositionAgeMs = PositionResolverPolicy.staleMaxAgeMs = 24 giờ` — chính là `POSITION_STALE_AFTER_MS` mà hệ thống đang dùng để ẩn vị trí hết hạn. Không khai con số thứ hai cho cùng một khái niệm.

### Mốc ở tương lai

`observedAt > now + 5 phút` ⇒ `INVALID_POSITION`, **không** phải "siêu tươi". Không có lưới này, một mốc hỏng sẽ nằm trên map vĩnh viễn. 5 phút là dung sai lệch đồng hồ, cùng con số mapper AIS-1 dùng. Không dựng framework clock-skew.

---

## 4. `location` là phép chiếu, không phải canonical

Sự thật vẫn là `position.position.lat` / `.lng` — nguyên khối, có xuất xứ. Domain **không** biết GeoJSON.

```
ResolvedCurrentVessel  ──toGeoJsonPoint()──►  { type: "Point", coordinates: [lng, lat] }
     (application)                                  (chỉ nằm trong Mongo)
```

`ICurrentVesselRepository` **không đổi** — hợp đồng truy vấn không gian là việc của MAP-2.

### ⚠️ Thứ tự toạ độ

```
GeoJSON:  [ kinh độ , vĩ độ ]     ← [lng, lat]
người ta đọc:  vĩ độ , kinh độ
```

Vũng Tàu `(lat 10, lng 106)` → `[106, 10]`. Đảo nhầm thành `[10, 106]` là giữa Somalia — và **Mongo không kêu**, vì cả hai đều là toạ độ hợp lệ. Đây là lỗi im lặng, nên có test khoá cả chiều dương lẫn chiều âm.

### Toạ độ hỏng

`toGeoJsonPoint` gọi lại `isValidCoordinates` của domain. NaN / lat 91 / lng 181 ⇒ `null`, **không** dựng Point. Dựng Point rác sẽ khiến Mongo từ chối khoá geo và làm hỏng **cả lệnh ghi** — một con tàu rác kéo đổ lệnh ghi của chính nó.

---

## 5. Ghi cùng một lệnh

```ts
location !== null
  ? { $set: { ...doc, location } }
  : { $set: doc, $unset: { location: "" } }
```

- **Một** lệnh ghi, không phải "lưu canonical rồi update location". Hai lệnh nghĩa là có một khoảnh khắc canonical và toạ độ nói hai chuyện khác nhau, và nghĩa là gấp đôi số lệnh ghi cho mỗi tàu.
- Vị trí biến mất ⇒ **`$unset`**, không phải `location: null`. Toạ độ cũ nằm lại là **tàu ma**: map vẽ nó ở chỗ nó không còn ở đó. 2dsphere cũng bỏ qua document thiếu field, nên `$unset` là đúng cả về ngữ nghĩa lẫn về index.

### Kiểm chứng trên MongoDB thật

Chạy `dist/` đã build, database `soosky_bot_map_test`:

```
§26 tạo mới  lat=10 lng=106  ->  {"type":"Point","coordinates":[106,10]}
§28 cập nhật lat=11 lng=107  ->  {"type":"Point","coordinates":[107,11]}
§27 mất vị trí               ->  location: undefined | field còn tồn tại: false
§13 indexes: _id_ | mmsi_1 | imo_1 | location_2dsphere [2dsphere]
```

---

## 6. Index

```ts
currentVesselSchema.index({ location: "2dsphere" });
```

- **Chỉ** `location`. Không compound 2dsphere + mọi field có thể lọc — đoán trước là tự làm chậm mọi lần ghi để đổi lấy một truy vấn chưa ai viết. MAP-2 sẽ **đo** rồi mới thêm.
- 2dsphere **tự thưa**: document thiếu `location` không nằm trong index ⇒ tàu chưa có vị trí không tốn gì.
- Index `mmsi`/`imo` cũ giữ nguyên.
- ⛔ **Không** index geo trên `vessel_observations`. Truy vấn map chạy trên canonical, không trên nhật ký.
- ⛔ **Không** TTL trên canonical. Hết hạn là việc của lúc **ĐỌC** (`MapVesselReadiness`), không phải của TTL daemon lúc **XOÁ**. Xoá document đi thì mất luôn câu trả lời "lần cuối thấy nó ở đâu".

### 🔴 Phát hiện cho MAP-2: `$box` KHÔNG dùng được 2dsphere

Đo trên 2.000 document thật:

| Truy vấn | Plan | docsExamined | nReturned |
|---|---|---|---|
| `$geoWithin: { $box: [[106,1],[107,3]] }` | **COLLSCAN** | **2.000** | 97 |
| `$geoWithin: { $geometry: { type: "Polygon", … } }` | **IXSCAN** `location_2dsphere` | **140** | 97 |

Cùng kết quả, khác hẳn chi phí. `$box`/`$center` là toán tử **legacy**, chỉ index `2d` phục vụ được; 2dsphere chỉ nhận `$geometry`.

⇒ **MAP-2 bắt buộc dựng bbox thành Polygon GeoJSON**, không dùng `$box`. Viết sai thì index nằm đó vô dụng và mọi truy vấn viewport quét toàn bộ collection — mà không có lỗi nào báo.

---

## 7. Dữ liệu đã có từ trước

Document ghi **từ MAP-1 trở đi** đã có `location` sẵn. Chỉ dữ liệu cũ mới cần bù.

⛔ **Không migration tự động lúc khởi động.** Chạy tay:

```bash
npm run map:backfill-location                                   # DRY-RUN (mặc định)
npm run map:backfill-location -- --confirm
npm run map:backfill-location -- --confirm --batch-size=1000 --limit=50000
```

| | |
|---|---|
| mặc định | **dry-run**, không ghi gì |
| ghi thật | phải có `--confirm` |
| chỉ quét | document **thiếu** `location` |
| cách ghi | `bulkWrite` theo mẻ, không vòng lặp update từng document |
| toạ độ hỏng | bỏ qua, đếm riêng `skippedInvalid` |
| chưa có vị trí | bỏ qua, đếm riêng `skippedMissingPosition` |
| credential | **không bao giờ** in ra |

Báo cáo: `scanned · eligible · updated · skippedInvalid · skippedMissingPosition`.

---

## 8. Dung lượng thêm

Đo trên 20.000 document tổng hợp:

| | avgObjSize |
|---|---|
| không `location` | 178 B |
| có `location` | **249 B** |

⇒ GeoJSON Point tốn **~71 B/document** (logical), cộng entry 2dsphere ~40–60 B.
Gọi tròn **~100–130 B/tàu**.

Canonical là **một** document mỗi tàu, nên:

| Số tàu | thêm |
|---|---|
| 10.000 | ~1,3 MB |
| 50.000 | ~6,5 MB |
| 100.000 | ~13 MB |

Không đáng kể so với `vessel_observations` (hàng chục GB — AIS-5 §17). Ghi thêm cũng không tốn lệnh nào vì `location` đi trong chính lệnh upsert đã có.

---

## 9. Danh sách file

| File | |
|---|---|
| `src/application/services/map/MapVesselReadiness.ts` | chính sách thuần: đủ điều kiện vẽ chưa |
| `src/application/services/map/MapVesselProjector.ts` | canonical → object phẳng cho map |
| `src/infrastructure/persistence/mongo/currentVesselModel.ts` | field `location` + 2dsphere |
| `src/infrastructure/persistence/mongo/MongoCurrentVesselRepository.ts` | `toGeoJsonPoint` + ghi/`$unset` cùng lệnh |
| `src/interfaces/cli/backfillMapLocation.ts` | bù dữ liệu cũ, gọi tay, dry-run |

---

## 10. Rủi ro còn lại

| # | | |
|---|---|---|
| 1 | Viết bbox bằng `$box` sẽ **im lặng** bỏ qua index — §6. Phải khoá bằng test explain ở MAP-2 | 🔴 |
| 2 | Tàu STALE vẫn nằm trong index và vẫn trúng truy vấn không gian. Tầng map **bắt buộc** lọc thêm theo `observedAt` — geo index chỉ lo phần không gian | 🔴 |
| 3 | Chưa đo truy vấn bbox ở quy mô 50k–100k tàu. Có thể cần index hỗ trợ (`location` + `position.observedAt`) — MAP-2 đo rồi mới thêm | 🟡 |
| 4 | Kịch bản canonical bị ghi đè `position: null` (AIS-5 §9.2) nay còn kéo theo mất `location`. Cùng một cách chữa: giữ nhóm cũ khi nhóm mới rỗng | 🟡 |
| 5 | Không xoá `location` khi tàu trở nên cũ, và đó là **chủ ý**: độ cũ thay đổi theo thời gian mà không có lần ghi nào. Lọc lúc đọc | 🟢 |

---

## 11. MAP-2 (chưa làm)

1. Hợp đồng truy vấn không gian trong `application/contracts` — bbox → danh sách canonical.
2. Dựng bbox thành **Polygon GeoJSON**, kèm test `explain` khoá `IXSCAN`.
3. Lọc `observedAt` **cùng** truy vấn geo; đo xem có cần index hỗ trợ không.
4. Trần số kết quả mỗi viewport + phân trang tất định.
5. Chỉ khi đó mới bàn tới adapter tương thích `VesselSimple`.

⛔ MAP-2 **không** làm: clustering / H3 / geohash / Redis geo / endpoint HTTP công khai / sửa production.

---

*Không sửa file nào của Soosky-marine-api.*
