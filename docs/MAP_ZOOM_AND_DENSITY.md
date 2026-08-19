# Mức zoom và mật độ tàu trên bản đồ — giai đoạn MAP-3

> Zoom thấp trả **mật độ theo cụm**, zoom cao trả **từng con tàu**.
>
> Không endpoint HTTP, không Redis, không H3, không collection dựng sẵn, không đụng production.
>
> Tiếp nối [MAP_VIEWPORT_QUERY.md](./MAP_VIEWPORT_QUERY.md) (MAP-2 · truy vấn viewport).

---

## 0. Tóm tắt

| # | | |
|---|---|---|
| 1 | Danh sách bị cắt ở zoom thấp **thiên lệch theo MMSI**, không phải "một mẫu ngẫu nhiên" | 🔴 lý do tồn tại của phase |
| 2 | Hai chế độ, không hơn: `CLUSTERS` (zoom < 6) và `VESSELS` (zoom ≥ 6) | 🟢 |
| 3 | Lưới Web Mercator, khoá `${gridZoom}:${x}:${y}` — tất định | 🟢 |
| 4 | Khoá lưới **toàn cục** ⇒ viewport cắt ±180 tự gộp, không cần bước merge | 🟢 |
| 5 | `gridZoomOffset` chỉnh từ **+3 → +2** sau khi đo: +3 vẫn bị cắt cụt ở zoom 2 | 🟡 đo mới sửa |
| 6 | Toàn cầu zoom 2: **160 cụm đại diện 8.000 tàu**, `truncated=false` | ✅ |
| 7 | Cụm **91 B** vs tàu **229 B** → world view nhỏ hơn **~129 lần** | ✅ |
| 8 | Pipeline dùng `location_2dsphere`, không COLLSCAN | ✅ cổng index PASS |

---

## 1. Vì sao danh sách bị cắt là chưa đủ

MAP-2 xử lý viewport rộng bằng cách cắt ở `limit` rồi bật `truncated=true`. Điều đó **an toàn** nhưng **sai về mặt biểu diễn**:

```
kết quả được sắp theo MMSI rồi mới cắt
  -> luôn là những MMSI NHỎ NHẤT
  -> MMSI bắt đầu bằng MID quốc gia
  -> map toàn cầu hiện ra một mảng tàu dồn về vài quốc gia,
     phần còn lại của địa cầu TRỐNG TRƠN
```

Đó không phải "một mẫu ngẫu nhiên của 8.000 tàu" — nó là một lát cắt có hệ thống. Người dùng nhìn vào sẽ kết luận sai về nơi tàu tập trung.

Cụm trả lời đúng câu hỏi thật ở zoom thấp: **chỗ nào đông**, không phải **tàu nào**.

---

## 2. Hai chế độ

```
{ bbox, zoom, limit? }
        ↓  planMapQuery(zoom)
┌── zoom < 6  ->  CLUSTERS   gộp theo ô lưới
└── zoom ≥ 6  ->  VESSELS    dùng lại NGUYÊN GetMapVessels của MAP-2
```

Kết quả là union có `mode`, **không** trộn cụm và tàu trong cùng một mảng.

⛔ Không `MapStrategyFactory`, không `ClusterEngine`, không đăng ký chiến lược động. Một hàm thuần, một ngưỡng, một bảng cấu hình.

`GetMapVessels` **không bị xoá và không bị viết lại**. `QueryMap` là lớp điều phối ở trên; mọi luật trần/lọc độ tươi/khử trùng/sắp xếp của MAP-2 giữ nguyên một bản duy nhất.

### Ngưỡng

| | mặc định | vì sao |
|---|---|---|
| `vesselModeMinZoom` | **6** | ở zoom 6 một màn hình phủ cỡ một quốc gia/biển khu vực, số tàu còn nằm dưới trần 1.000 của MAP-2 |
| `gridZoomOffset` | **+2** | đo được — xem §5 |

---

## 3. Lưới

**Web Mercator**, đúng phép toán mà mọi map di động dùng để chia ô:

```
n = 2^gridZoom
x = floor( (lon + 180) / 360 * n )
y = floor( (1 - ln(tan(φ) + sec(φ)) / π) / 2 * n )
```

Vì sao không phải lưới lat/lon đều: lưới lat/lon cho ô **méo dần về cực** (ở vĩ độ 60°, ô 1°×1° hẹp bằng nửa ô ở xích đạo), nên cụm ở Bắc Âu trông dày giả tạo so với Singapore. Ô Mercator thì **vuông trên màn hình** — đúng thứ người dùng nhìn thấy.

Vì sao không H3/geohash: thêm một dependency để giải bài toán mà 6 dòng số học đã giải, và H3 lại không khớp lưới tile mà FE đang render.

### ⚠️ Kẹp vĩ độ — bắt buộc

```
WEB_MERCATOR_MAX_LAT = 85.05112878     // atan(sinh(π))
```

Ở đúng ±90°, `cos(lat) = 0` → chia cho 0 → `Infinity` → `NaN` → ô rác. Trong pipeline Mongo còn tệ hơn: `$divide` cho 0 **ném lỗi**, và đúng một con tàu ở cực sẽ giết cả truy vấn. Kẹp ở **cả hai** bản (JS và pipeline).

`x`/`y` cũng kẹp về `[0, n-1]`: `lon = 180` cho ra đúng `n`, tràn một ô ra ngoài bảng.

### Khoá cụm

```
id = `${gridZoom}:${x}:${y}`        ví dụ "4:0:3"
```

Tất định theo lưới, **không** `ObjectId`, **không** số ngẫu nhiên. FE cần khoá ổn định giữa hai lần tải để cập nhật marker tại chỗ thay vì xoá rồi vẽ lại.

Và vì khoá là **toàn cục**, hai mảnh viewport (trường hợp cắt ±180, hoặc hộp rộng bị chia nhỏ) **tự gộp** về cùng một cụm — không cần bước merge nào, và không thể trùng ở đường biên.

---

## 4. Hợp đồng cụm

```ts
MapClusterItem { id, lat, lon, count, movingCount }
```

- `lat`/`lon` là **toạ độ trung bình của các tàu trong ô**, không phải tâm hình học. Cụm nằm đúng trên luồng tàu thay vì lơ lửng giữa một ô phần lớn là biển trống. (`gridCellCenter` vẫn có sẵn làm dự phòng.)
- `movingCount` = số tàu SOG > 0,5 kn. Đứng yên = `count - movingCount`.
- ⛔ **Không** danh sách MMSI. Có test chặn chuỗi MMSI xuất hiện trong payload cụm.

---

## 5. 🟡 `gridZoomOffset` chỉnh sau khi đo

Mốc khởi điểm là `+3` (mỗi ô hiển thị chia 8×8). Đo trên 10.000 tàu rải đều toàn cầu:

| offset | lưới ở zoom 2 | số ô toàn cầu | kết quả |
|---|---|---|---|
| **+3** | zoom 5 | 32×32 = **1.024** | 500 cụm, `truncated=true`, đại diện **6.963/8.000** tàu ❌ |
| **+2** | zoom 4 | 16×16 = **256** | **160 cụm**, `truncated=false`, đại diện **8.000/8.000** ✅ |

`+3` vẫn bị cắt cụt — tức là vẫn mắc đúng vấn đề mà MAP-3 sinh ra để giải. Chốt **`+2`**.

⚠️ Dữ liệu tổng hợp rải **đều**; AIS thật dồn về ven bờ nên số ô có tàu ít hơn. `+2` vì thế là lựa chọn thận trọng, không phải chặt chẽ.

---

## 6. Pipeline tổng hợp của Mongo

```
$match    location $geoWithin $geometry Polygon   ← STAGE ĐẦU TIÊN, giữ index
          position.observedAt >= cutoff
$project  chỉ lat / lng / speed
$addFields  _gx, _gy   (Web Mercator, có kẹp vĩ độ)
$group    _id {x,y} · count · $avg lat/lon · movingCount
$sort     x, y                                    ← tất định
$limit    limit + 1                               ← biết "còn nữa" mà không countDocuments
```

- `$match` **phải** là stage đầu tiên, nếu không `$geoWithin` mất index (MAP-2 đã đo giá của COLLSCAN).
- `$project` sớm: không kéo `identity`/`particulars`/`voyage`/mảng `rejected` vào bộ nhớ aggregation.
- Lọc độ tươi nằm **trong `$match`**: cụm chỉ trả con số nên không còn cơ hội loại tàu cũ ở tầng trên. Ngưỡng lấy từ chính `MapReadinessPolicy.maxPositionAgeMs` — không có số thứ hai.
- Chỉ đọc `canonical_current_vessels`. ⛔ Không đụng `vessel_observations`: đếm observation là đếm **số lần một con tàu nói**, không phải **số con tàu**.

Kiểm chứng chéo bắt buộc: POC so khoá cụm do pipeline sinh ra với khoá do `MapGrid` (JS) tính lại từ chính toạ độ trung bình. Lệch nhau nghĩa là marker trên FE nhảy chỗ giữa hai đường đọc.

```
✅ lưới JS vs pipeline: 4:0:3 == 4:0:3
✅ lưới JS vs pipeline: 6:0:14 == 6:0:14
```

---

## 7. Số đo hiệu năng

`npm run map:cluster-poc -- --seed=10000`, MongoDB local dev, viewport toàn cầu ở mọi mức zoom (kịch bản xấu nhất — thực tế client zoom cao không xem cả thế giới):

| zoom | chế độ | lưới | kết quả | truncated | plan | index | docsExamined | keysExamined | thời gian |
|---|---|---|---|---|---|---|---|---|---|
| **2** | CLUSTERS | 4 | **160 cụm / 8.000 tàu** | **false** | `FETCH←IXSCAN` ×2 | ✅ `location_2dsphere` | 20.000 | 10.000 | **147 ms** |
| **4** | CLUSTERS | 6 | 500 cụm / 1.825 tàu | true | `FETCH←IXSCAN` ×2 | ✅ | 20.000 | 10.000 | 150 ms |
| **6** | VESSELS | — | 500 tàu | true | (đường MAP-2) | ✅ | — | — | **43 ms** |
| **8** | VESSELS | — | 500 tàu | true | (đường MAP-2) | ✅ | — | — | 29 ms |

**Cổng index PASS** — không có COLLSCAN nào.

Đọc bảng:

- `keysExamined = 10.000` ở viewport toàn cầu là **đúng**: mọi tàu đều nằm trong viewport, nên mọi khoá đều phải quét.
- `docsExamined = 20.000` = 2× số document: hộp toàn cầu bị chia thành 4 mảnh → `$or` 4 nhánh, cộng thêm một lượt FETCH nữa cho bộ lọc `position.observedAt` (không nằm trong index).
- zoom 4 bị cắt cụt vì POC ép **viewport toàn cầu** ở zoom 4 — một client thật ở zoom 4 chỉ xem một châu lục.
- 147–158 ms nằm dưới mốc chú ý 500 ms. Không có SLA nào được đặt ra ở đây.

---

## 8. Kích thước phản hồi

Đo thật:

| | B/đơn vị |
|---|---|
| cụm | **91 B** (ô 15 tàu) — dao động 75–91 B |
| tàu (MAP-2) | 229 B |

| | payload |
|---|---|
| 100 cụm | ~9 KiB |
| 500 cụm | ~44 KiB |
| 1.000 cụm | ~89 KiB |

Đối chiếu cho **cùng một viewport toàn cầu, cùng 8.000 tàu**:

```
chế độ VESSELS  :  8.000 × 229 B  =  1,79 MiB   (và vẫn bị cắt còn 1.000)
chế độ CLUSTERS :    160 ×  91 B  =  14,2 KiB   (đại diện ĐỦ 8.000 tàu)
                                     ↑ nhỏ hơn ~129 lần
```

Đây là toàn bộ lý do MAP-3 tồn tại: không chỉ nhỏ hơn, mà còn **đầy đủ hơn**.

---

## 9. Danh sách file

| File | |
|---|---|
| `application/services/map/MapGrid.ts` | lưới Web Mercator, kẹp cực, khoá ô |
| `application/services/map/MapQueryStrategy.ts` | zoom → chế độ + mức lưới |
| `application/contracts/repositories/IMapClusterRepository.ts` | hợp đồng gộp cụm |
| `application/use-cases/map/QueryMap.ts` | điều phối hai chế độ |
| `infrastructure/persistence/mongo/MongoMapClusterRepository.ts` | pipeline aggregation |
| `interfaces/cli/mapClusterPoc.ts` | explain + đo payload + đối chiếu lưới |

---

## 10. Giới hạn còn lại

| # | | |
|---|---|---|
| 1 | Viewport rộng vẫn quét **mọi khoá geo** trong vùng. Ở 100k–1M tàu, `keysExamined` sẽ tăng tuyến tính — đây là trần thật của phương án gộp động | 🔴 |
| 2 | `docsExamined` gấp đôi vì `position.observedAt` không nằm trong index. Chưa thêm index hỗ trợ: phải đo ở dữ liệu thật trước, và index compound với 2dsphere làm chậm **mọi** lần ghi | 🟡 |
| 3 | Ranh giới ô là **cứng**: hai tàu cách nhau 100 m nhưng nằm hai bên đường chia ô sẽ thành hai cụm. Đây là bản chất của lưới cố định, không phải bug | 🟡 |
| 4 | Cụm không có mức chi tiết trung gian: nhảy thẳng từ cụm sang tàu ở zoom 6. Có thể cần bậc chuyển tiếp nếu UX thấy giật | 🟡 |
| 5 | Ràng buộc "Polygon < nửa cầu" (MAP-2) vẫn phải giữ — cụm dùng lại chính phép cắt đó | 🔴 |
| 6 | Tàu STALE vẫn nằm trong geo index và vẫn tốn `keysExamined`, dù không được đếm | 🟡 |

---

## 11. Gộp động có đủ không?

**Ở quy mô hiện tại: đủ.** 10.000 tàu, viewport toàn cầu, 147 ms, index chạy đúng, payload 14 KiB.

⛔ **Chưa** dựng `map_clusters`, **chưa** cache Redis, **chưa** vật chất hoá tile — đúng như yêu cầu: gộp động phải chứng minh là không đủ trước đã, và hiện nó đang đủ.

Điều kiện để xét lại (MAP-4):

| Tín hiệu | Ngưỡng gợi ý |
|---|---|
| `keysExamined` viewport toàn cầu | > ~200.000 |
| thời gian truy vấn cụm | > 500 ms đều đặn |
| số tàu tươi đồng thời | > 100.000 |

Khi đó thứ tự cân nhắc: (a) index hỗ trợ `{location: "2dsphere", "position.observedAt": 1}` — đo trước; (b) cache theo (bbox làm tròn, zoom) với TTL ngắn; (c) chỉ khi cả hai không đủ mới tới collection cụm dựng sẵn — vì nó thêm một đường ghi và một nguồn dữ liệu có thể lệch.

---

## 12. MAP-4 (chưa làm)

1. Đo ở 100k–1M tàu, quyết index hỗ trợ theo `keysExamined`/`docsExamined`.
2. Nếu cần: cache theo (bbox làm tròn, zoom), TTL ngắn — **không** collection dựng sẵn trước.
3. Adapter tương thích `VesselSimple` cho Marine API.
4. Chỉ sau đó mới bàn endpoint.

⛔ MAP-4 **không** làm: Redis GEO · H3 · MyShipTracking · sửa production.

---

*Không sửa file nào của Soosky-marine-api.*
