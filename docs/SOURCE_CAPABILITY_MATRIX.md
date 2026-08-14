# SOURCE_CAPABILITY_MATRIX — Phase A2 / P2

> Biến "nguồn nào cấp được field nào" từ kiến thức trong đầu thành **code kiểm tra được**.
> Tiền đề: [CURRENT_ARCHITECTURE.md](./CURRENT_ARCHITECTURE.md) · [CURRENT_DATA_FLOW.md](./CURRENT_DATA_FLOW.md) · [CANONICAL_VESSEL_MODEL.md](./CANONICAL_VESSEL_MODEL.md)
> P2 **chỉ mô hình hoá capability**. Không crawler mới, không network request, không resolver, không đụng DB/FE/Marine.

Code:
- [src/domain/value-objects/VesselField.ts](../src/domain/value-objects/VesselField.ts)
- [src/application/capabilities/SourceCapability.ts](../src/application/capabilities/SourceCapability.ts)
- [src/application/capabilities/sourceCapabilityMatrix.ts](../src/application/capabilities/sourceCapabilityMatrix.ts)
- [src/application/capabilities/capabilityQueries.ts](../src/application/capabilities/capabilityQueries.ts)

---

## 1. Source Matrix là gì

Một bảng tra **đóng băng** (`Object.freeze`), khai báo cho từng nguồn:

| Thành phần | Trả lời câu hỏi |
|---|---|
| `operations` | Nguồn **làm được thao tác gì** — tìm theo tên/MMSI/IMO, lấy vị trí, lấy lý lịch, lấy chuyến đi, quét vùng |
| `fields` | Với **từng field canonical**, nguồn ở mức CONFIRMED / CANDIDATE / UNSUPPORTED |
| `costType` | `EXISTING_STREAM` · `FREE` · `PAID` |
| `enabled` | Nguồn đã được phép dùng trong bot ở phase hiện tại chưa |
| `defaultPriority` | Số thứ tự mặc định (nhỏ = ưu tiên cao) |
| `notes` | Bằng chứng / cảnh báo vận hành |

Field dùng **từ vựng canonical** (`VesselField`), không phải tên thô của nguồn. Không có `ship_lat`, `lrpd`, `lengthM` trong matrix — chỉ `lat`, `positionReceivedAt`, `length`.

## 2. Tại sao project cần nó

Audit A0 chỉ ra 3 câu hỏi luồng dữ liệu hiện tại **không trả lời được** ([CURRENT_DATA_FLOW.md §8](./CURRENT_DATA_FLOW.md)): field nào từ nguồn nào, ai thắng khi bất đồng, làm sao biết nguồn xuống cấp. A1 giải quyết phần "biểu diễn" (canonical model + `SourceMetadata`). A2 giải quyết phần **"biết trước"**:

- Cần `grossTonnage` thì hỏi nguồn nào? → tra bảng, không đoán.
- Nguồn trả tiền bị gọi nhầm trước nguồn free? → `defaultPriority` + mặc định `includePaid = false` chặn ngay.
- "Chúng ta có lấy được `destination` từ VesselFinder không?" → có bằng chứng: **chưa**, mapper không bóc → `CANDIDATE`, không phải `CONFIRMED`.

Quan trọng nhất: nó **chống lạc quan**. Không ai vô tình đánh dấu một field là "có" khi code chưa bao giờ bóc được field đó — test chặn.

## 3. CONFIRMED / CANDIDATE / UNSUPPORTED

| Trạng thái | Nghĩa | Bằng chứng cần có |
|---|---|---|
| **CONFIRMED** ✅ | Nguồn cấp được field này | Code trong repo đã bóc được field, **hoặc** đặc tả/tài liệu nguồn mà dự án đã xác nhận |
| **CANDIDATE** 🟡 | Nguồn *có thể* cấp, dự án **chưa audit/POC** | Suy đoán kiến trúc, hoặc dấu vết trong code nhưng chưa parse |
| **UNSUPPORTED** — | Nguồn không phù hợp, hoặc có bằng chứng không cấp | VD: AIS không có message nào mang GT/DWT |

**Luật cứng: không tự nâng CANDIDATE → CONFIRMED.** Chỉ nâng sau audit/POC thật + cập nhật tài liệu này. Test `"nguồn chưa POC không được có field CONFIRMED nào"` giữ luật này.

Ba ví dụ minh hoạ ranh giới, lấy từ VesselFinder:
- `lat` → **CONFIRMED**: `VesselFinderMapSource.decode()` đang bóc thật, có đường chạy production.
- `grossTonnage` → **CANDIDATE**: Mongo schema **có cột**, nhưng `VesselFinderHtmlMapper` không parse ([CURRENT_DATA_FLOW.md §2.3](./CURRENT_DATA_FLOW.md)). Schema có cột **không phải** bằng chứng.
- `currentPort` → **UNSUPPORTED**: không dấu vết nào trong repo, entity cũ không có khái niệm cảng.

## 4. Nguồn × Operation

| Source | cost | enabled | prio | searchByName | searchByMmsi | searchByImo | position | particulars | voyage | areaScan |
|---|---|---|---|---|---|---|---|---|---|---|
| `aisstream` | EXISTING_STREAM | — | 10 | — | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| `vesselfinder` | FREE | ✅ | 20 | — | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `shiptraffic` | FREE | — | 40 | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| `shipinfo` | FREE | — | 45 | — | ✅ | ✅ | ✅ | ✅ | — | — |
| `vesseltracker` | FREE | — | 50 | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| `shipfinder` | FREE | — | 55 | — | ✅ | — | ✅ | ✅ | ✅ | — |
| `boatnerd` | FREE | — | 60 | ✅ | ✅ | — | ✅ | ✅ | — | — |
| `marinetraffic_live` | FREE | — | 70 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `myshiptracking` | PAID | ✅ | 900 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `unknown` | FREE | — | ∞ | — | — | — | — | — | — | — |

`vesselfinder.voyage = false`: mapper hiện không bóc `destination`/`eta`.
`aisstream.searchByImo = false`: AIS đánh địa chỉ theo MMSI; IMO chỉ là payload của message 5.
`shipinfo.searchByName = false`: endpoint tìm theo tên nằm dưới `/api/` mà `robots.txt` của ShipInfo cấm.
`shipfinder.searchByImo = false`: `/ship/detail/imo/{imo}` trả 404 — nguồn chỉ tra được bằng MMSI. `searchByName` cũng false vì endpoint duy nhất bị ký chữ ký.

## 5. Field × Source

✅ CONFIRMED · 🟡 CANDIDATE · — UNSUPPORTED

### Nhóm A · Identity
| Field | AISSTREAM | VESSELFINDER | SHIPINFO | SHIPFINDER | BOATNERD | MARINETRAFFIC_LIVE | SHIPTRAFFIC | VESSELTRACKER | MYSHIPTRACKING | UNKNOWN |
|---|---|---|---|---|---|---|---|---|---|---|
| `mmsi` | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | — |
| `imo` | ✅ | ✅ | ✅ | ✅ | — | 🟡 | 🟡 | 🟡 | 🟡 | — |
| `name` | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | — |
| `callsign` | ✅ | ✅ | ✅ | ✅ | — | 🟡 | 🟡 | 🟡 | 🟡 | — |
| `vesselType` | 🟡 | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | — |
| `vesselTypeCode` | ✅ | 🟡 | — | — | — | 🟡 | — | — | 🟡 | — |
| `flag` | 🟡 | ✅ | ✅ | ✅ | — | 🟡 | 🟡 | 🟡 | 🟡 | — |

### Nhóm B · Position
| Field | AISSTREAM | VESSELFINDER | SHIPINFO | SHIPFINDER | BOATNERD | MARINETRAFFIC_LIVE | SHIPTRAFFIC | VESSELTRACKER | MYSHIPTRACKING | UNKNOWN |
|---|---|---|---|---|---|---|---|---|---|---|
| `lat` | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | — | — | 🟡 | — |
| `lng` | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | — | — | 🟡 | — |
| `speed` | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | — | — | 🟡 | — |
| `course` | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | — | — | 🟡 | — |
| `heading` | ✅ | 🟡 | — | ✅ | 🟡 | 🟡 | — | — | 🟡 | — |
| `navStatus` | ✅ | ✅ | — | ✅ | — | 🟡 | — | — | 🟡 | — |
| `positionReceivedAt` | ✅ | 🟡 | ✅ | ✅ | 🟡 | 🟡 | — | — | 🟡 | — |

### Nhóm C · Particulars
| Field | AISSTREAM | VESSELFINDER | SHIPINFO | SHIPFINDER | BOATNERD | MARINETRAFFIC_LIVE | SHIPTRAFFIC | VESSELTRACKER | MYSHIPTRACKING | UNKNOWN |
|---|---|---|---|---|---|---|---|---|---|---|
| `grossTonnage` | — | 🟡 | — | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | — |
| `deadweight` | — | 🟡 | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | — |
| `builtYear` | — | 🟡 | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | — |
| `length` | ✅ | ✅ | — | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | — |
| `beam` | ✅ | ✅ | — | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | — |
| `draught` | ✅ | ✅ | — | ✅ | — | 🟡 | 🟡 | 🟡 | 🟡 | — |

### Nhóm D · Voyage
| Field | AISSTREAM | VESSELFINDER | SHIPINFO | SHIPFINDER | BOATNERD | MARINETRAFFIC_LIVE | SHIPTRAFFIC | VESSELTRACKER | MYSHIPTRACKING | UNKNOWN |
|---|---|---|---|---|---|---|---|---|---|---|
| `destination` | ✅ | 🟡 | — | ✅ | — | 🟡 | 🟡 | 🟡 | 🟡 | — |
| `eta` | ✅ | 🟡 | — | 🟡 | — | 🟡 | 🟡 | 🟡 | 🟡 | — |
| `currentPort` | — | — | — | 🟡 | — | 🟡 | — | 🟡 | 🟡 | — |
| `currentPortArrivalAt` | — | — | — | — | — | 🟡 | — | — | 🟡 | — |
| `nextPort` | — | — | — | 🟡 | — | 🟡 | — | 🟡 | 🟡 | — |
| `nextPortEta` | — | — | — | — | — | 🟡 | — | — | 🟡 | — |
| `lastPort` | — | — | — | 🟡 | — | 🟡 | — | 🟡 | 🟡 | — |
| `lastPortDepartureAt` | — | — | — | — | — | 🟡 | — | — | 🟡 | — |

### Tổng hợp
| Source | CONFIRMED | CANDIDATE | UNSUPPORTED |
|---|---|---|---|
| `aisstream` | 17 | 2 | 9 |
| `vesselfinder` | **14** | 8 | 6 |
| `shipinfo` | **13** | 0 | 15 |
| `shipfinder` | **17** | 7 | 4 |
| `boatnerd` | 0 | 14 | 14 |
| `marinetraffic_live` | 0 | 28 | 0 |
| `shiptraffic` | 0 | 14 | 14 |
| `vesseltracker` | 0 | 17 | 11 |
| `myshiptracking` | 0 | 28 | 0 |
| `unknown` | 0 | 0 | **28** |

**Chỉ 4 nguồn có field CONFIRMED.** Đó là bức tranh thật của dự án hôm nay, không phải bức tranh mong muốn.
ShipInfo được nâng ở **P6.4**, ShipFinder ở **P7.4** — cả hai sau khi POC live ghi được observation thật. Xem [SHIPINFO_POC.md](./sources/SHIPINFO_POC.md) · [SHIPFINDER_POC.md](./sources/SHIPFINDER_POC.md).

**SHIPFINDER** *(cập nhật P7.4)* — nguồn thứ **ba** có implementation thật, và là nguồn crawl có **nhiều field CONFIRMED nhất (17)**.

Ba thứ chỉ ShipFinder cho được trong nhóm nguồn crawl: **`heading`**, **`navStatus`**, **`draught`** — ShipInfo là UNSUPPORTED cả ba (0/1073 điểm). Cộng thêm vị trí **tươi theo phút** (POC đo 6.1 phút) so với ShipInfo bị khoá trễ ~14 giờ.

⚠️ **`positionReceivedAt` CONFIRMED nhưng có điều kiện.** Nguồn **không khai báo múi giờ** ở bất kỳ đâu; P7.1 chỉ *suy luận* UTC+8. Không đặt `SHIPFINDER_SOURCE_UTC_OFFSET_MINUTES` thì provider **không phát nhóm position** — thà thiếu vị trí còn hơn gắn mốc lệch hàng giờ.

CANDIDATE của ShipFinder đều là "nguồn CÓ nhưng đường ta dùng chưa lấy được":
- `eta`: trang cho `"07-29 07:01"` — **thiếu năm**, canonical `eta` là `Date` nên mapper cố ý không map.
- `grossTonnage` / `deadweight` / `builtYear`: nằm sau `/ship/GetIHSData` — **API ký chữ ký**, không đụng.
- `currentPort` / `nextPort` / `lastPort`: mục Port Call đòi đăng nhập, Ship Event là tính năng trả tiền.

⚠️ **`defaultPriority` giữ nguyên 55, thấp hơn ShipInfo (45), dù vị trí tươi hơn nhiều.** Đổi thứ tự ưu tiên chính là mã hoá "ShipFinder thắng ShipInfo" — đó là việc của **resolver**, và resolver **chưa tồn tại**.

### Ghi chú bằng chứng

**VESSELFINDER** — nguồn DUY NHẤT có adapter thật. Capability là **hợp của 2 đường**:
- mp2 binary (`VesselFinderMapSource`): `mmsi`, `name`, `lat`, `lng` — toạ độ **chính xác**
- HTML details (`VesselFinderHtmlMapper`): lý lịch + `speed`/`course`, nhưng `lat`/`lng` **bị làm tròn** (~111km, `latLngApproximate = true`)

CANDIDATE của VesselFinder có 2 loại lý do khác nhau:
| Field | Lý do chưa CONFIRMED |
|---|---|
| `vesselTypeCode` | `#djson.ship_type` **được khai báo** trong interface `DJson` nhưng mapper không đọc |
| `positionReceivedAt` | `#djson.lrpd` là chuỗi **tương đối** (`"0 min ago"`) — canonical cố ý không map |
| `grossTonnage`, `deadweight`, `builtYear`, `destination`, `eta` | Mongo schema có cột, mapper **không bóc** |
| `heading` | Chưa audit payload đầy đủ của `#djson` — không có bằng chứng có, cũng không có bằng chứng không |

`navStatus` CONFIRMED **chỉ phần text** (bảng "Navigation Status"); `navStatusCode` chưa nguồn nào ghi.

**VesselFinder — phạm vi của `enabled = true`.** Cờ này **chỉ** phản ánh một sự thật vận hành: legacy crawler (`ScanArea`, `EnrichVesselTypes`, `CrawlFleetPositions`) đang chạy production. Nó **KHÔNG** có nghĩa multi-source resolver mới được mặc định dùng nguồn này. Resolver ở phase sau phải tự quyết theo policy riêng của nó — kế thừa `enabled` mà không suy nghĩ là hiểu sai cờ. Runtime crawler hiện tại **không bị đụng tới** trong P2.

**SHIPINFO** *(cập nhật P6.4)* — nguồn thứ **hai** có implementation thật. 13 field CONFIRMED đã đi **trọn** đường `SOURCE → RAW → CANONICAL → PROVIDER → OBSERVATION` và xuất hiện trong `vessel_observations` thật.

⚠️ Điểm đặc biệt của ShipInfo: **0 field CANDIDATE**. Không phải vì audit qua loa mà ngược lại — mọi field còn lại đều có **bằng chứng vắng mặt** cụ thể:
- `length` / `beam`: nguồn **đảo không nhất quán** giữa các tàu (Agia Doxa 179/29 đúng, Qi Xian Ling 29/180 đảo). Mapper **cố ý không map**. Đây là UNSUPPORTED vì *dữ liệu sai*, không phải vì *thiếu dữ liệu*.
- `heading`, `draught`, `destination`, `eta`: khoá tồn tại nhưng null ở **0/1073** điểm đã kiểm.
- `grossTonnage`, `navStatus`: nguồn không có khoá nào.
- `vesselTypeCode`: chỉ có nhãn chữ, không có mã AIS.

`enabled = false` dù đã CONFIRMED: mới chỉ có POC gọi **tay** (`npm run shipinfo:poc`), chưa có ingestion tự động.

⚠️ Vị trí bản free **trễ ~14 giờ có chủ ý** (`fresh_locked: true`). ShipInfo là nguồn identity/flag tốt, **không** phải nguồn vị trí thời gian thực.

**AISSTREAM** — CONFIRMED ở đây dựa trên **đặc tả AIS** (message 1/2/3 dynamic, message 5 static & voyage) cộng với việc Marine đang vận hành AISStream thật — **KHÔNG phải POC trong bot**. `grossTonnage`/`deadweight`/`builtYear` là **UNSUPPORTED** (bằng chứng: không AIS message nào mang chúng), không phải "chưa audit". `vesselType` và `flag` là CANDIDATE vì phải suy diễn (mã → nhãn chữ; MID → quốc gia).

**MYSHIPTRACKING** — toàn bộ **CANDIDATE**. Repo không chứa API client, không chứa tài liệu hay response mẫu để làm bằng chứng. Danh sách field CONFIRMED phải đến từ API task ngoài repo; nâng trạng thái khi có danh sách đó. Xem §11.

## 6. Cost type

| Loại | Nghĩa | Nguồn |
|---|---|---|
| `EXISTING_STREAM` | Hạ tầng dự án đã trả tiền / đã vận hành | `aisstream` |
| `FREE` | Crawl công khai; chi phí = **rủi ro bị chặn**, không phải tiền | 8 nguồn |
| `PAID` | Tính tiền theo request | `myshiptracking` |

`FREE` không có nghĩa "dùng thoải mái" — chi phí của nó là 403/429 và cooldown (xem `SCAN_BLOCK_COOLDOWN_MS`).

## 7. enabled / disabled

`enabled` là **quyết định vận hành**, tách hẳn khỏi capability kỹ thuật.

| Source | enabled | Lý do |
|---|---|---|
| `vesselfinder` | ✅ | **Chỉ** vì legacy crawler đang chạy production — **không** đồng nghĩa resolver multi-source mới được mặc định dùng |
| `myshiptracking` | ✅ | Được phép dùng — nhưng `defaultPriority = 900` nên luôn cuối |
| `aisstream` | — | Marine đã sở hữu connection; Phase A **không mở connection thứ hai** từ bot. Đây là quyết định vận hành, **không phải giới hạn kỹ thuật** |
| `shipinfo` | — | **Có** provider thật + POC live đã chạy, nhưng mới gọi **tay** qua CLI. Chưa có ingestion tự động → chưa bật |
| `marinetraffic_live` | — | Không có crawler, **không được bật** ở phase này |
| `shipfinder` | — | **Có** provider thật + POC live, nhưng mới gọi **tay** qua CLI. Ngoài ra position còn phụ thuộc giả định múi giờ phải khai tường minh |
| 3 nguồn còn lại | — | Chưa có implementation, chưa audit provider |

⚠️ `enabled = true` chỉ nói "được phép dùng ở phase hiện tại", **không** nói "được gọi trước" (thứ tự là việc của `defaultPriority`), và **không** nói "resolver mới được kế thừa quyền đó". Với `vesselfinder`, cờ này thuần tuý mô tả legacy crawler đang chạy.

## 8. Quy tắc: Crawl-first, Paid-last

Mã hoá bằng 2 cơ chế, không phải bằng if/else trong source class:

1. **`defaultPriority`** — `EXISTING_STREAM` (10) < `FREE` (20–70) < `PAID` (900) < `UNKNOWN` (∞). Mọi truy vấn đều sort theo số này.
2. **Mặc định an toàn của query** — `includePaid = false`, `includeDisabled = false`, `includeCandidate = false`. Muốn nguồn trả tiền thì **người gọi phải nói rõ ý định**.

```ts
getSourcesForField(VesselField.LAT)
// -> ["vesselfinder"]   (mặc định: enabled + CONFIRMED + không tốn tiền)

getSourcesForField(VesselField.LAT, { includePaid: true, includeCandidate: true })
// -> ["vesselfinder", ..., "myshiptracking"]   (nguồn trả tiền LUÔN cuối)
```

Test khoá cả hai: `"mặc định KHÔNG trả nguồn trả tiền"` và `"includePaid=true ... và luôn đứng CUỐI"`.

Business fallback **không** được hardcode vào source class nào — matrix chỉ nói *đủ điều kiện*, việc *chọn* thuộc resolver ở phase sau.

## 9. Capability ≠ provider implementation

Đây là điểm dễ hiểu nhầm nhất.

| Matrix nói | Matrix KHÔNG nói |
|---|---|
| Nguồn *về lý thuyết* cấp được field gì | Có adapter cho nguồn đó chưa |
| Thao tác nào hợp lệ với nguồn | Gọi nguồn thế nào, endpoint gì, parse ra sao |
| Nguồn tốn tiền hay không | Khi nào thì thực sự gọi |
| Nguồn đã được phép dùng chưa | Retry / rate limit / backoff |

Cụ thể: 8/10 nguồn trong matrix **không có một dòng code adapter nào**. `marinetraffic_live` có 28 field CANDIDATE nhưng gọi nó ngay bây giờ sẽ crash — không có client. Matrix là **bản đồ**, không phải **con đường**.

Không file nào trong `src/application/capabilities/` import `HttpClient`, mongoose, express, hay bất kỳ datasource nào. Toàn bộ là hàm thuần + hằng đóng băng.

## 10. Promote CANDIDATE → CONFIRMED

Quy trình bắt buộc khi audit/POC một nguồn xong:

1. **POC thật** — viết adapter hoặc script thử, bóc được field trên dữ liệu thật (không phải đọc tài liệu rồi tin).
2. **Ghi bằng chứng** — thêm dòng vào `notes` của nguồn đó: bóc từ đâu, bằng cách nào.
3. **Đổi trạng thái** trong [sourceCapabilityMatrix.ts](../src/application/capabilities/sourceCapabilityMatrix.ts).
4. **Cập nhật tài liệu này** — bảng §5 và phần Ghi chú bằng chứng.
5. **Chạy test** — nếu nguồn đó nằm trong danh sách "chưa POC" của `sourceCapabilityMatrix.test.ts` thì phải gỡ ra, và việc gỡ đó là **cố ý**, không phải sửa cho test xanh.

Ví dụ gần nhất, chi phí thấp nhất: mở rộng `VesselFinderHtmlMapper` bóc thêm `grossTonnage`/`deadweight`/`builtYear`/`destination`/`eta` → 5 field CANDIDATE thành CONFIRMED mà **không thêm nguồn mới nào**. (Không làm trong P2.)

## 11. Chưa làm — cố ý

| Hạng mục | Trạng thái |
|---|---|
| Adapter cho ShipInfo / ShipFinder / BoatNerd / ShipTraffic / VesselTracker / MarineTraffic | ❌ không có, không gọi mạng để xác minh |
| API client MyShipTracking | ❌ không implement; field CONFIRMED chờ danh sách từ API task ngoài repo |
| AISStream connection trong bot | ❌ không mở |
| Fallback resolver | ❌ chưa viết — matrix chỉ lọc, không chọn |
| Retry / rate limit / backoff theo nguồn | ❌ chưa (debt D-4, D-5 của A0) |
| Refactor crawler VesselFinder | ❌ không đụng |
| Mongo schema / index / `latestpositions` | ❌ không đụng |
| Đọc matrix từ MongoDB, admin UI | ❌ không cần ở Phase A — matrix là hằng trong code |
| FE, Marine, deployment | ❌ không đụng |

---

## Phụ lục · API truy vấn

```ts
getSourceCapability(source)                        // entry đóng băng
getFieldSupportStatus(source, field)               // trạng thái thô, không lọc
providerSupportsField(source, field, opts?)        // mặc định CHỈ CONFIRMED
getConfirmedFields(source) / getCandidateFields(source)
getSourcesForField(field, opts?)                   // đã sort theo priority
getSourcesForFields(fields, opts?)                 // GIAO: cấp được HẾT các field
getMissingFields(required, available)              // required \ available, không trùng
```

`opts`: `{ includeDisabled?, includeCandidate?, includePaid? }` — **mặc định cả ba là `false`**.

`getSourcesForFields([])` trả **rỗng**: "không yêu cầu field nào" không có nghĩa "mọi nguồn đều hợp".
