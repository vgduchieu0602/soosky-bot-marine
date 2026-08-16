# DETAIL_CANONICAL_READ_MODEL — phase DETAIL-1

> Trả lời: **"hiện tại Bot biết gì về vessel X?"** — đọc thuần trên canonical, không crawl.
>
> Không endpoint HTTP, không MyShipTracking, không đụng production.
>
> Tiếp nối [MAP_ZOOM_AND_DENSITY.md](./MAP_ZOOM_AND_DENSITY.md) (MAP-3).

---

## 0. Tóm tắt

| # | | |
|---|---|---|
| 1 | Chi tiết **TỪNG PHẦN vẫn hợp lệ** — tàu chỉ có MMSI + vị trí không phải 404 | 🟢 |
| 2 | **Không có một độ tươi cho cả con tàu** — bốn nhóm, bốn tuổi, bốn ngưỡng | 🟢 |
| 3 | Độ tươi vị trí **tính lại**, không tin `freshness` đã lưu | 🟢 |
| 4 | Không rò `rejected` / `observationId` / `reason` / `contentHash` | 🟢 |
| 5 | `needsRefresh` + `refreshGroups` chỉ là **cờ** — DETAIL-1 không kích hoạt gì | 🟢 |
| 6 | 🔴 Đã vá lỗ hổng MAP-3: cụm không có cận trên thời gian → mốc tương lai lọt vào mọi cụm | ✅ đã sửa |
| 7 | Production `VesselExtended`: **18/25 field MISSING** — toàn bộ nhóm cảng | 🟡 |

---

## 1. Đường đi

```
{ mmsi? , imo? }
      ↓  isValidMmsi / isValidImo        (validator P1, không viết lại)
ICurrentVesselRepository.findByMmsi → findByImo
      ↓
ResolvedCurrentVessel
      ↓  projectVesselDetail(now)
CanonicalVesselDetail   |   NOT_FOUND
```

⛔ Không đọc `vessel_observations`. Không gọi ShipFinder/ShipInfo/VesselFinder. Không MyShipTracking. Không scheduler.

⛔ **Không tự đi lấy khi tra không thấy.** Quyết định đó tiêu request thật lên nguồn ngoài — không được lẫn vào một use case mà người gọi tưởng là chỉ đọc. DETAIL-2 mới xử lý.

---

## 2. Hình dạng

```ts
CanonicalVesselDetail {
  identifiers  { mmsi, imo }                        // chuỗi hoặc null
  identity     { name, callsign, vesselType, vesselTypeCode, flagCode, flagName }
  position     { lat, lon, speed, course, heading,
                 navStatusCode, navStatusText,
                 observedAt, ageMs, source, status } | null
  particulars  { length, beam, draught, grossTonnage, deadweight, builtYear }
  voyage       { destination, eta, currentPort, nextPort, lastPort, lastPortDepartureAt }

  groups        Record<DetailGroup, { status, updatedAt, ageMs }>
  missingGroups DetailGroup[]
  staleGroups   DetailGroup[]
  needsRefresh  boolean
  refreshGroups DetailGroup[]
  resolvedAt    Date
}
```

⛔ **Không** gọi là `VesselExtended`. Kiểu đó là DTO tương thích của production (mọi field `required`, thiếu thì `"N/A"`/`0`). Read model này độc lập.

### Xuất xứ NHẸ

Mỗi field tĩnh là `{ value, source, observedAt, fetchedAt }` — đủ để biết **ai nói và nói lúc nào**, không kèm **ai thua**.

⛔ Bỏ hẳn: `rejected` (danh sách nguồn thua), `reason`, `observationId`, `contentHash`, bậc `freshness` đã lưu. Đó là dữ liệu chẩn đoán; muốn soi thì làm CLI riêng.

### Kiểu dữ liệu

`Date` giữ nguyên là `Date`, **không** stringify sớm. Serialize là việc của ranh giới ngoài cùng.

`lon` (không phải `lng` của canonical) — cùng quy ước với payload map.

---

## 3. Trạng thái theo NHÓM

```
AVAILABLE   có dữ liệu dùng được
MISSING     chưa nguồn nào cấp
STALE       có nhưng đã quá ngưỡng của nhóm
```

Ba mức, cố ý không hơn. ⛔ Không thang điểm 20 bậc, không chấm điểm nguồn — chọn nguồn nào thắng đã xong ở resolver, ở đây chỉ nhìn kết quả.

### Vì sao KHÔNG có một độ tươi chung

| nhóm | nhịp đổi thật | ngưỡng |
|---|---|---|
| POSITION | 2–10 giây | **24 giờ** (= `MapReadinessPolicy`, không khai số thứ hai) |
| VOYAGE | mỗi chuyến | **7 ngày** |
| IDENTITY | gần như không đổi | **90 ngày** |
| PARTICULARS | không bao giờ | **90 ngày** |

Gộp bốn nhóm thành một con số là vứt đi chính thông tin cần dùng: vị trí 2 phút tuổi cùng `builtYear` 30 ngày là **hoàn toàn bình thường**. Áp một ngưỡng chung thì hoặc bắt crawl lại tên tàu mỗi tuần, hoặc để `destination` cũ ba tháng.

Nhóm tĩnh tính tuổi theo `fetchedAt` **mới nhất** trong các field có mặt.

### Độ tươi vị trí — tính lại

```ts
ageMs = now - position.observedAt        // mốc NGUỒN, không phải fetchedAt
```

⚠️ **Không** tin `position.freshness` đã lưu: canonical chỉ ghi lại khi có dữ liệu mới, nên tàu ngừng phát giữ nguyên bậc `LIVE` mãi mãi. Có test dựng đúng cái bẫy đó.

Ba trường hợp thành `STALE`:

| | |
|---|---|
| `ageMs > 24h` | quá cũ |
| `observedAt = null` | **không biết tuổi ≠ tuổi bằng 0** |
| `ageMs < -5 phút` | mốc ở tương lai là mốc hỏng, không phải "siêu tươi" |

Toạ độ không hợp lệ → `position = null`, nhóm `MISSING` (cùng hàng rào `isValidCoordinates` với MAP-1).

---

## 4. Chi tiết TỪNG PHẦN là hợp lệ

Người dùng bấm vào một chấm trên map: vị trí có thể rất tươi từ AIS, nhưng `particulars` chưa ai crawl. Đó **không** phải lỗi.

```
tàu chỉ có MMSI + position
  -> status FOUND
  -> position AVAILABLE
  -> missingGroups ["IDENTITY","PARTICULARS","VOYAGE"]
  -> needsRefresh true
```

⛔ Không 404, không ném "detail incomplete".

`needsRefresh` / `refreshGroups` **chỉ là cờ** để DETAIL-2 biết phải làm gì. DETAIL-1 không kích hoạt bất cứ thứ gì.

`NOT_FOUND` chỉ khi canonical **chưa biết gì** về định danh đó.

---

## 5. Định danh

Tra MMSI trước, IMO sau — đúng thứ tự `MongoCurrentVesselRepository` đang dùng.

`MapVesselItem.mmsi` dùng thẳng được, FE **không** cần bước tra IMO trung gian.

Định danh sai định dạng → **ném trước khi chạm kho** (`isValidMmsi` / `isValidImo` của domain, kể cả chữ số kiểm tra IMO). ⛔ Không tra mờ, không tìm theo tên.

---

## 6. 🔴 Vá lỗ hổng MAP-3 (§20)

Bộ lọc độ tươi của chế độ cụm chỉ có cận dưới:

```js
"position.observedAt": { $gte: cutoff }        // ❌ thiếu cận trên
```

Hệ quả: một mốc hỏng ở tương lai **luôn** lọt vào mọi cụm, vĩnh viễn — trong khi chế độ VESSELS đã loại nó từ MAP-1 qua `futureToleranceMs`. Hai chế độ nói hai điều khác nhau về cùng một con tàu.

Đã sửa: cả `IMapVesselRepository` lẫn `IMapClusterRepository` nhận `observedBefore`, lấy từ **chính** `MapReadinessPolicy.futureToleranceMs` — không tạo chính sách mới.

```js
"position.observedAt": { $gte: cutoff, $lte: now + futureTolerance }
```

Hai test khoá: mốc tương lai không được đếm vào cụm, và hai chế độ cho **cùng một con số**.

---

## 7. Bảng đối chiếu `VesselExtended` production

Nguồn: `soosky-marine-api/src/domain/entities/V2Vessel.ts`. **Chỉ tham chiếu — không sửa production.**

| Field production | Canonical | Trạng thái |
|---|---|---|
| `basicInfo.vesselName` | `identity.name` | ✅ AVAILABLE |
| `basicInfo.mmsi` | `identifiers.mmsi` | ✅ AVAILABLE ⚠️ chuỗi vs số |
| `basicInfo.imo` | `identifiers.imo` | ✅ AVAILABLE ⚠️ chuỗi vs số |
| `basicInfo.vType` | `identity.vesselTypeCode` | ✅ AVAILABLE ⚠️ chỉ AIS cấp |
| `basicInfo.lat` / `lon` | `position.lat` / `position.lon` | ✅ AVAILABLE |
| `basicInfo.course` / `speed` | `position.course` / `.speed` | ✅ AVAILABLE |
| `basicInfo.navStatus` | `position.navStatusText` | ✅ AVAILABLE |
| `basicInfo.received` | `position.observedAt` | ✅ AVAILABLE ⚠️ mốc NGUỒN |
| `vesselType` | `identity.vesselType` | ✅ AVAILABLE |
| `flag` | `identity.flagName` | ✅ AVAILABLE |
| `grossTonnage` | `particulars.grossTonnage` | ✅ AVAILABLE |
| `deadWeight` | `particulars.deadweight` | ✅ AVAILABLE |
| `built` | `particulars.builtYear` | ✅ AVAILABLE |
| `estimatedTimeArrival` | `voyage.eta` | ✅ AVAILABLE ⚠️ chỉ MyShipTracking cho ETA có năm |
| `currentPort` | `voyage.currentPort` | ✅ AVAILABLE (tên chuỗi) |
| `lastPort` | `voyage.lastPort` | ✅ AVAILABLE |
| `nextPort` | `voyage.nextPort` | ✅ AVAILABLE |
| `lastPortDepartureUtc` | `voyage.lastPortDepartureAt` | ✅ AVAILABLE |
| `containsExtendedInfo` | — | 🟨 DERIVABLE (có ≥1 nhóm tĩnh) |
| `currentPortArrivalUtc` | — | ❌ MISSING |
| `nextPortEtaUtc` | — | ❌ MISSING |
| `currentPortId` · `currentPortUnlocode` · `currentPortCountry` | — | ❌ MISSING |
| `lastPortId` · `lastPortUnlocode` · `lastPortCountry` | — | ❌ MISSING |
| `nextPortId` · `nextPortUnloco` · `nextPortCountry` | — | ❌ MISSING |
| `currentPortArrivalLocal` · `lastPortDepartureLocal` · `nextPortEtaLocal` | — | ❌ MISSING (giờ địa phương cần múi giờ cảng) |

**Tổng: 18 AVAILABLE · 1 DERIVABLE · 15 MISSING** — và **toàn bộ phần MISSING là nhóm cảng**.

⛔ **Không** thêm `portId`/`UNLOCODE`/`portCountry` vào canonical chỉ để đạt parity. Không nguồn nào hiện cấp chúng ([MARINE_API_INTEGRATION_AUDIT.md §E.3](./MARINE_API_INTEGRATION_AUDIT.md): chỉ MyShipTracking `extended`, 3 credit/lần). Thêm field rỗng vào canonical là bịa một lời hứa.

`currentPortArrivalAt` / `nextPortEta` cũng chưa có trong `ResolvedVoyage` — P8.4 §R.3 cố ý chưa phân xử.

⚠️ Quy đổi `null → "N/A"`/`0`, chuỗi → số, `lon` → `lon`: đó là việc của **adapter tương thích** ở phase sau. Canonical nói "không biết" thì phải là `null`.

---

## 8. Kích thước

Đo thật, một tàu **đủ cả bốn nhóm**: **2.163 B**.

Phần lớn là `source` + hai mốc ISO nhân 13 field (~90 B/field) — cái giá của việc biết ai nói và nói lúc nào. Chấp nhận được vì detail là **một** tàu mỗi lần hỏi, không phải mười nghìn chấm như map (241 B/tàu ở MAP-2).

Có lưới chống phình (< 3 KiB) nhưng hàng rào thật là test cấu trúc: nhét cả mảng `rejected` vào sẽ bị bắt ngay.

---

## 9. File

| File | |
|---|---|
| `application/services/vessel/VesselDetailProjector.ts` | read model + trạng thái nhóm |
| `application/use-cases/vessel/GetCanonicalVesselDetail.ts` | tra + kiểm định danh |
| `application/contracts/repositories/IMapVesselRepository.ts` | thêm `observedBefore` |
| `application/contracts/repositories/IMapClusterRepository.ts` | thêm `observedBefore` |
| `infrastructure/persistence/mongo/MongoMapVesselRepository.ts` | cửa sổ thời gian hai đầu |
| `application/use-cases/map/{GetMapVessels,QueryMap}.ts` | truyền cận trên |

---

## 10. Giới hạn

| # | | |
|---|---|---|
| 1 | 15 field cảng của production vẫn MISSING; chỉ MyShipTracking (trả tiền) cấp được | 🟡 |
| 2 | `currentPortArrivalAt` / `nextPortEta` chưa có trong `ResolvedVoyage` | 🟡 |
| 3 | Ngưỡng tuổi nhóm tĩnh (90/90/7 ngày) là **phỏng đoán có cơ sở**, chưa đo từ dữ liệu thật | 🟡 |
| 4 | `NOT_FOUND` chưa phân biệt "chưa từng thấy" với "đã bị dọn" — canonical không TTL nên hiện chưa phải vấn đề | 🟢 |
| 5 | Nhóm tĩnh tính tuổi theo `fetchedAt`; nguồn crawl có thể trả dữ liệu cũ mà `fetchedAt` vẫn mới | 🟡 |

---

## 11. DETAIL-2 (chưa làm)

1. `refreshGroups` → chọn nguồn qua `FreeSourceSelector` đã có (P9), tôn trọng crawl runtime P4.
2. Chính sách acquire-on-miss: `NOT_FOUND` có được phép kích hoạt crawl không, và ai trả phí thời gian chờ.
3. Chống bão request: cùng một MMSI bị bấm 100 lần không được thành 100 lượt crawl.
4. Chỉ sau đó mới bàn `PaidFallbackGate` cho MyShipTracking (nhóm cảng).

⛔ DETAIL-2 **không** làm: endpoint HTTP · sửa production · adapter `VesselExtended`.

---

*Không sửa file nào của Soosky-marine-api.*
