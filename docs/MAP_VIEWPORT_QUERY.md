# MAP_VIEWPORT_QUERY — phase MAP-2

> Application trả lời được: **"trong viewport này hiện có tàu nào vẽ được?"**
>
> Không endpoint HTTP, không clustering, không đụng production.
>
> Tiếp nối [MAP_CANONICAL_READINESS.md](./MAP_CANONICAL_READINESS.md) (MAP-1 · geo storage).

---

## 0. Tóm tắt

| # | | |
|---|---|---|
| 1 | Bắt buộc `$geometry` Polygon — `$box` rơi vào COLLSCAN (MAP-1 đã đo) | 🔴 |
| 2 | **Polygon lớn hơn nửa cầu cho kết quả SAI, không lỗi.** Đo: viewport toàn cầu trả **3/10.000** tàu | 🔴 mới phát hiện |
| 3 | Viewport cắt kinh tuyến ±180 → hai hộp, không phải lỗi | 🟢 |
| 4 | Độ tươi **tính lại**, không tin `freshness` đã lưu | 🟢 |
| 5 | Kết quả luôn có trần và **nói thật** khi bị cắt | 🟢 |
| 6 | Payload đo được **≈241 B/tàu** | 🟢 |
| 7 | Mọi viewport có giới hạn đều dùng `location_2dsphere` | ✅ cổng index PASS |

---

## 1. Đường đi

```
bbox
  ↓  resolveViewport()            application · kiểm tra + tách + cắt nhỏ
BoundingBox[]
  ↓  IMapVesselRepository         hợp đồng, KHÔNG biết Mongo
MongoMapVesselRepository          $geoWithin + $geometry Polygon, có chiếu field
  ↓  ResolvedCurrentVessel[]
evaluateMapReadiness()            lọc ĐỘ TƯƠI tại thời điểm hỏi
  ↓
MapVesselItem[] + truncated
```

Hợp đồng `IMapVesselRepository` tách khỏi `ICurrentVesselRepository` có chủ ý: kho kia trả lời "tàu X thế nào", kho này trả lời "vùng này có ai". Nhét truy vấn không gian vào interface cũ sẽ biến một cổng hai đường tra thành cổng mọi thứ.

---

## 2. Hợp đồng bbox

```ts
{ minLat, minLon, maxLat, maxLon }     // dùng lại BoundingBox đã có
```

| Kiểm tra | Lỗi |
|---|---|
| bốn giá trị là số hữu hạn | `NOT_FINITE` |
| lat ∈ [-90, 90] | `LAT_OUT_OF_RANGE` |
| lon ∈ [-180, 180] | `LON_OUT_OF_RANGE` |
| `minLat <= maxLat` | `LAT_INVERTED` |

⚠️ `minLat > maxLat` **báo lỗi**, không tự đảo hộ. Vĩ độ không vòng quanh, nên đảo ngược là người gọi truyền nhầm — sửa hộ là giấu bug. Kinh độ thì khác hẳn, xem §3.

Use case **ném** `InvalidViewportError` và **không gọi kho** — không gửi Polygon rác xuống Mongo.

---

## 3. Đường đổi ngày quốc tế

```
minLon = 170, maxLon = -170     ← HỢP LỆ, không phải lỗi
```

Tách thành hai hộp:

```
[170 .. 180]  và  [-180 .. -170]
```

Ai đó "sửa" bằng cách đảo hai giá trị sẽ biến một dải rộng 20° quanh Fiji thành dải rộng 340° phủ gần hết địa cầu — và không lỗi nào được ném ra, chỉ có map trả về hàng chục nghìn tàu sai.

Hai hộp → `$or` hai nhánh `$geoWithin`. Một tàu sát biên có thể trúng cả hai; **khử trùng theo MMSI ở use case** (chỗ hợp đồng được phát biểu), không ở kho — để luật không nằm hai nơi rồi lệch nhau.

---

## 4. 🔴 Polygon không được lớn hơn nửa cầu

Phát hiện khi chạy POC thật, **không** phải phòng xa:

| Viewport | Kết quả trước khi sửa |
|---|---|
| `-180..180`, 10.000 tàu rải toàn cầu | **3 tàu** |

`$geoWithin: { $geometry: Polygon }` dùng quy tắc bàn tay phải để biết đâu là "bên trong". Với đa giác lớn hơn nửa mặt cầu, hướng vòng trở nên nhập nhằng và Mongo chọn **vùng nhỏ hơn** — tức là gần như không có gì. **Không lỗi nào được ném ra.**

Cách chữa: cắt mọi hộp rộng hơn **90° kinh độ** thành nhiều mảnh; hợp của các mảnh đúng bằng hộp gốc.

```
toàn cầu (360°)  ->  4 hộp × 90°
```

Cách khác là khai `crs: strictwinding` trong truy vấn, nhưng thế là nhét kiến thức Mongo vào tận tầng application. Cắt hộp thì tầng nào cũng hiểu, và còn giúp index chạy hẹp hơn.

Sau khi sửa: viewport toàn cầu trả về đủ `limit` tàu, vẫn IXSCAN. Có test khoá cả bề rộng lẫn "hợp các mảnh = hộp gốc".

---

## 5. Truy vấn Mongo

```js
{ location: { $geoWithin: { $geometry: { type: "Polygon", coordinates: [[ … ]] } } } }
```

- Vòng **đóng kín**, toạ độ **[lon, lat]**.
- ⛔ **Không** `$box` / `$center` / `$centerSphere` — toán tử legacy, chỉ index `2d` phục vụ được. MAP-1 đo: `$box` quét 2.000/2.000 document để trả 97 kết quả. Có test cấm chuỗi `$box` xuất hiện trong filter.
- Nhiều hộp → `$or`.
- `observedSince` → `position.observedAt: { $gte }`, **chỉ là lọc sơ bộ** để giảm ứng viên; quyết định cuối vẫn là `evaluateMapReadiness`.

### Chiếu field — bắt buộc

```js
{ mmsi, imo, "identity.name", "identity.vesselTypeCode", "identity.imo", position, resolvedAt }
```

Canonical đầy đủ mang `particulars`, `voyage`, và — nặng nhất — mảng `rejected` của **từng** field (danh sách nguồn thua kèm lý do). Với mười nghìn tàu một viewport, nạp chúng là kéo hàng chục MB từ Mongo rồi vứt đi. Có test đọc thẳng hằng số chiếu và chặn `particulars`/`voyage`/`rejected`/`contentHash`.

`position` lấy **nguyên khối** — nó là payload của đúng một observation, tách lẻ là phá bất biến của resolver.

---

## 6. Lọc độ tươi

Truy vấn không gian **không đủ**: tàu trong viewport vẫn có thể đã cũ.

```ts
ageMs = now - position.observedAt        // tính lại mỗi lần hỏi
```

⚠️ **Không** tin `position.freshness` đã lưu. Canonical chỉ ghi lại khi có dữ liệu mới, nên tàu ngừng phát giữ nguyên bậc `LIVE` trong document mãi mãi (MAP-1 §3). Có test dựng đúng cái bẫy đó: document nói `LIVE`, `observedAt` 3 ngày trước → **không** xuất hiện.

Luật readiness **dùng lại** `evaluateMapReadiness` của MAP-1, không viết lại. `now` là đồng hồ **tiêm vào use case**, không phải tham số của người gọi ngoài — nếu không, một client lệch giờ sẽ tự quyết định tàu nào là "tươi".

Tàu chỉ có vị trí, không tên/IMO/loại → **vẫn trả về**, các field thiếu là `null`. ⛔ Không `imo = "0"`, không `name = "N/A"`, không `speed = 0`.

---

## 7. Trần và `truncated`

```ts
MAP_QUERY_LIMITS = {
  defaultLimit: 1_000,
  maxLimit: 5_000,
  overfetchMultiplier: 2,
  maxCandidates: 20_000,
}
```

- Xin nhiều hơn `maxLimit` → bị kẹp. `limit` rác (0, âm, NaN) → về mặc định.
- **Đọc dư 2×**: bộ lọc độ tươi chạy **sau** truy vấn không gian, nên đọc đúng 1.000 rồi loại 300 tàu cũ sẽ khiến người dùng chỉ nhận 700 dù viewport còn thừa tàu tươi chưa đọc tới.
- Kho đọc `candidateLimit + 1` bản ghi để biết "còn nữa không" — **không** `countDocuments`, đếm toàn viewport trên collection hàng trăm nghìn document đắt hơn vài bậc độ lớn.

`truncated = true` khi **một trong hai**:

1. lọc xong vẫn nhiều hơn `limit`;
2. kho chạm trần ứng viên → ngoài kia còn tàu **chưa đọc tới**, và ta không biết chúng có tươi không. Nói "đầy đủ" trong tình huống đó là nói dối.

Kết quả sắp theo MMSI **rồi mới cắt** → cùng dữ liệu, cùng viewport thì cùng câu trả lời. `$geoWithin` không hứa thứ tự nào cả, mà cả test lẫn cache phía client đều cần tất định.

⚠️ Hệ quả đã biết: viewport bị cắt sẽ luôn trả các MMSI nhỏ nhất. Đó là thiên lệch có thật, chấp nhận ở MAP-2 và là lý do MAP-3 cần clustering.

⛔ **Không phân trang** kiểu `page=1/page=2`. Map là truy vấn không gian được làm mới liên tục, không phải danh sách bài viết.

---

## 8. `MapVesselItem`

```ts
{
  mmsi, imo, vesselName, vesselTypeCode,
  lat, lon,
  course, speed,
  navStatusCode, navStatusText,
  observedAt
}
```

- `lon` (không phải `lng` của canonical): đây là payload **map**, và cả GeoJSON lẫn contract Marine API đều gọi là `lon`. Quy đổi gói gọn trong projector.
- `navStatus` `{code, text}` tách thành hai field phẳng.
- ⛔ **Không** mang `rejected`, `reason`, `observationId`, `contentHash`, `particulars`, `voyage`, `SourceMetadata`, `freshness`. Có test khoá danh sách khoá chính xác — thêm field vào payload map là quyết định phải cân nhắc, không phải tiện tay.
- ⛔ Đây **không** phải `VesselSimple`. Kiểu đó thuộc ranh giới tương thích Marine API, dựng ở phase sau.

---

## 9. Đo trên MongoDB thật

`npm run map:query-poc -- --seed=10000 --bbox=-20,60,20,120 --limit=1000`, 10.000 tàu rải toàn cầu (1/5 cố ý để cũ):

| Viewport | hộp | plan | index | nReturned | docsExamined | keysExamined | ms |
|---|---|---|---|---|---|---|---|
| nhỏ 10°×10° | 1 | `LIMIT←FETCH←IXSCAN` | ✅ `location_2dsphere` | 18 → **14** | 32 | 40 | 0 |
| vừa 40°×60° | 1 | `LIMIT←FETCH←IXSCAN` | ✅ | 525 → **418** | 1.080 | 1.092 | 4 |
| toàn cầu | **4** | `SUBPLAN←LIMIT←FETCH←IXSCAN` | ✅ | 1.000 (chạm trần) | 1.000 | 1.000 | 12 |
| cắt ±180 | 2 | `SUBPLAN←LIMIT←FETCH←IXSCAN` | ✅ | 82 → **65** | 90 | 95 | 2 |

(mũi tên = sau khi thêm bộ lọc `observedAt`)

**Cổng index PASS**: mọi viewport có giới hạn đều dùng `location_2dsphere`, không có COLLSCAN nào.

### Index hỗ trợ — CHƯA thêm

`docsExamined` vẫn xấp xỉ `keysExamined` ở viewport vừa (1.080 vs 1.092): bộ lọc `observedAt` được áp **sau** khi FETCH document, vì nó không nằm trong index. Ở quy mô hiện tại chi phí đó không đáng kể.

⛔ **Không** thêm index suy đoán. Khi nào `docsExamined` vượt xa `nReturned` ở dữ liệu thật thì mới cân nhắc compound `{ location: "2dsphere", "position.observedAt": 1 }` — và phải đo lại, vì index compound với 2dsphere làm chậm mọi lần ghi.

---

## 10. Kích thước phản hồi

Đo thật từ POC: **≈241 B/tàu** (JSON, tàu chưa có tên). Tàu có tên/IMO/loại thêm ~20–40 B ⇒ tính tròn **~280 B/tàu**.

| Số tàu | payload |
|---|---|
| 500 | ~118 KiB (≈137 KiB nếu đủ identity) |
| 1.000 | ~235 KiB (≈273 KiB) |
| 5.000 | ~1,15 MiB (≈1,34 MiB) |

Mục tiêu là điện thoại RAM thấp, nên đây là lý do §8 cấm nhét metadata phân xử vào payload: chỉ cần thêm mảng `rejected` là mỗi tàu phình lên vài KB, và 1.000 tàu thành vài MB.

Mẫu thật:

```json
{"mmsi":"200000089","imo":null,"vesselName":null,"vesselTypeCode":null,
 "lat":-20.7,"lon":91.9,"course":90,"speed":10,
 "navStatusCode":0,"navStatusText":"Under way using engine",
 "observedAt":"2026-08-16T14:32:19.876Z"}
```

---

## 11. File

| File | |
|---|---|
| `application/contracts/repositories/IMapVesselRepository.ts` | hợp đồng truy vấn vùng |
| `application/services/map/MapBoundingBox.ts` | kiểm tra + tách ±180 + cắt hộp rộng |
| `application/services/map/MapVesselProjector.ts` | `MapVesselItem` mỏng |
| `application/use-cases/map/GetMapVessels.ts` | trần · truncated · khử trùng · sắp xếp |
| `infrastructure/persistence/mongo/MongoMapVesselRepository.ts` | Polygon + chiếu field |
| `interfaces/cli/mapQueryPoc.ts` | explain + đo payload, chạy tay |

---

## 12. Rủi ro còn lại

| # | | |
|---|---|---|
| 1 | Viewport toàn cầu vẫn bị cắt cụt, và kết quả thiên về MMSI nhỏ. Cần clustering (MAP-3), không phải trần cao hơn | 🔴 |
| 2 | Chưa đo ở 100k–1M tàu. Ngưỡng `maxCandidates=20.000` chưa được thử ở dữ liệu thật | 🟡 |
| 3 | Bộ lọc `observedAt` áp sau FETCH — có thể cần index hỗ trợ, phải đo trước | 🟡 |
| 4 | Ràng buộc "Polygon < nửa cầu" là kiến thức PHẢI GIỮ. Ai sửa `MAX_LON_SPAN_DEG` lên 180+ sẽ làm hỏng viewport toàn cầu mà không test nào ngoài `MapBoundingBox` bắt được | 🔴 |
| 5 | Tàu STALE vẫn nằm trong index và vẫn tốn `docsExamined`. Bộ lọc sơ bộ giảm bớt nhưng không loại khỏi index | 🟡 |
| 6 | Kịch bản canonical bị ghi `position: null` (AIS-5 §9.2) làm tàu biến mất khỏi map cho tới lần phát tín hiệu sau | 🟡 |

---

## 13. MAP-3 (chưa làm)

1. Chính sách theo mức zoom: zoom nhỏ → cluster, zoom lớn → tàu riêng lẻ.
2. Gộp theo lưới (grid/geohash/H3 — **đo rồi mới chọn**), trả mật độ thay vì cắt cụt.
3. Đo ở 100k–1M tàu, quyết định index hỗ trợ dựa trên `docsExamined`.
4. Chỉ sau đó mới bàn adapter tương thích `VesselSimple` và endpoint.

⛔ MAP-3 **không** làm: Redis GEO · MyShipTracking · sửa production.

---

*Không sửa file nào của Soosky-marine-api.*
