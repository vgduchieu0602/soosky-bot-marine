# AIS_LOAD_AND_RETENTION — phase AIS-5

> Đo tải ingestion AIS và **chặn** tăng trưởng kho observation, trước khi làm Map/GeoJSON.
>
> Phase này **không** làm map, **không** đổi kiến trúc, **không** đụng production.
>
> Tiếp nối [AIS_COALESCING_BUFFER.md](./AIS_COALESCING_BUFFER.md) (AIS-3) và bước ghi mẻ của AIS-4.

---

## 0. Kết luận trước, chi tiết sau

| # | Phát hiện | |
|---|---|---|
| 1 | **Cửa sổ gộp — chứ không phải retention — mới là cần điều khiển chính.** 10 giây sinh tới ~8.640 vị trí/tàu/ngày | 🔴 |
| 2 | Dedupe theo vân tay **KHÔNG BAO GIỜ** chặn được vị trí AIS: vân tay có `sourceReceivedAt`, mà mốc đó luôn khác nhau | 🔴 |
| 3 | Resolver tốn **đúng 4 lượt đọc/tàu** (đo được), cộng 1–2 `findOne` cho canonical | 🟡 |
| 4 | Mẻ toàn bản trùng nay **không** kích hoạt resolve nữa | 🟢 |
| 5 | AIS position có TTL 48 giờ; các nhóm khác gắn với cửa sổ resolver | 🟢 |
| 6 | Frame AIS thô **không** bị lưu ở đâu cả | 🟢 |
| 7 | `canonical_current_vessels` **không** có TTL, đúng như yêu cầu | 🟢 |

**Khuyến nghị vận hành:** nâng `AIS_COALESCE_WINDOW_MS` từ `10000` lên **60.000–300.000** trước khi bật ingestion toàn cầu. Chi tiết §8.

---

## 1. Dedupe ≠ Retention

Hai khái niệm bị lẫn rất dễ, và ở đây chúng nằm ở hai file khác nhau có chủ ý:

| | DEDUPE (`ObservationPolicy`) | RETENTION (`ObservationRetentionPolicy`) |
|---|---|---|
| Câu hỏi | "có **ghi thêm** bản giống hệt không?" | "bản đã ghi được **giữ** bao lâu?" |
| Tác động | chặn INSERT | xoá bản đã có |
| Cơ chế | vân tay + cửa sổ thời gian | `expiresAt` + Mongo TTL index |
| Nếu sai | kho phình vì bản trùng | mất dữ liệu resolver đang cần |

⛔ **Tuyệt đối không** dùng cửa sổ dedupe làm TTL ngầm. Cửa sổ dedupe của POSITION là 5 phút; đọc nhầm nó thành "vị trí chỉ sống 5 phút" là sai hoàn toàn.

### 🔴 Dedupe vô tác dụng với vị trí AIS

`observationFingerprint` gồm `sourceReceivedAt`. Mỗi frame AIS mang một mốc `time_utc` khác nhau (độ phân giải nano-giây) ⇒ **mọi vị trí AIS đều có vân tay khác nhau** ⇒ cửa sổ dedupe 5 phút không bao giờ khớp.

Hệ quả: `observationsSaved == observationsCreated` cho AIS. Số lệnh ghi **bằng đúng** số entry ra khỏi buffer gộp. Đó là lý do §8 nói cửa sổ gộp mới là cần vặn.

Ngược lại, IDENTITY của AIS có `sourceReceivedAt = null` và payload ổn định ⇒ vân tay ổn định ⇒ dedupe **có** tác dụng, cộng thêm buffer đã chặn sẵn bằng vân tay riêng.

---

## 2. Bảng retention

| Nguồn | Nhóm | Giữ | Vì sao |
|---|---|---|---|
| **AISSTREAM** | POSITION | **48 giờ** | Ngoại lệ duy nhất. AIS sinh ~8.640 vị trí/tàu/ngày; hệ thống đã coi vị trí quá **24h** là hết hạn (`POSITION_STALE_AFTER_MS`) nên 48h vẫn gấp đôi biên. Giữ 7 ngày là nhân khối lượng ×3,5 cho dữ liệu không ai đọc |
| mọi nguồn khác | POSITION | 7 ngày | = đúng `PositionResolverPolicy.candidateWindowMs`. Nguồn crawl volume nhỏ nên không cần cắt |
| mọi nguồn | IDENTITY | 90 ngày | = đúng `IdentityResolverPolicy.candidateWindowMs` |
| mọi nguồn | PARTICULARS | 90 ngày | = đúng `ParticularsResolverPolicy.candidateWindowMs` |
| mọi nguồn | VOYAGE | 30 ngày | > cửa sổ resolver 7 ngày. Volume không đáng kể, chừa chỗ cho phase voyage sau. **Đây chưa phải sản phẩm lịch sử hành trình** |
| mọi nguồn | bất kỳ, **INVALID** | **7 ngày** | Chỉ để soi parser trôi. `RawPayloadPolicy.ON_ERROR` khiến đúng nhóm này mang payload thô ⇒ nặng nhất ⇒ ngắn nhất |

`PARTIAL` **không** bị rút ngắn: lõi vẫn dùng được và resolver vẫn nhận nó (`includeInvalid` chỉ chặn `INVALID`).

### ⚠️ Ràng buộc cứng khi chỉnh số

> retention ≥ cửa sổ nạp ứng viên của resolver tương ứng.

Ngắn hơn thì TTL xoá mất chính ứng viên resolver đang hỏi, và lượt resolve kế tiếp sẽ **ghi đè canonical bằng nhóm rỗng**. Có test khoá điều kiện này (`ObservationRetentionPolicy.test.ts`).

**AIS POSITION 48h là ngoại lệ CÓ Ý THỨC** của chính ràng buộc đó (48h < 7 ngày). Rủi ro cụ thể và giới hạn của nó ở §9.

---

## 3. TTL — cách hiện thực

Retention là **một khoảng thời gian** do application quyết; `expiresAt` là **một mốc** do persistence tính:

```
ObservationRetentionPolicy.retentionMsFor(source, type, validationStatus)   ← application, không biết Mongo
        ↓
MongoVesselObservationRepository.toDoc()  →  expiresAt = fetchedAt + retentionMs
        ↓
observationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

- `expireAfterSeconds: 0` nghĩa là **"hạn nằm ngay trong field"**, không phải "xoá sau 0 giây kể từ khi tạo".
- Tính từ **`fetchedAt`** (đồng hồ bot, luôn có) chứ không phải `sourceReceivedAt` (có thể null, và ShipInfo trễ ~14 giờ). Retention là vòng đời của **bản ghi**, không phải tuổi của dữ liệu nguồn.
- Domain **không** biết TTL. `VesselObservation` không có trường nào tên `expiresAt`.
- Chỉ **một** index TTL cho mọi luật, vì mọi luật đều quy về một mốc duy nhất.

⚠️ **TTL không tức thời.** Monitor của Mongo chạy nền khoảng 60 giây một lượt và còn phụ thuộc tải. Bản ghi hết hạn có thể còn nằm đó vài phút. Điều này **chấp nhận được** — xem §4.

### Dữ liệu đã có từ trước

**Không backfill.** Document thiếu `expiresAt` (mọi bản ghi trước AIS-5, và mọi nhóm cấu hình `null`) **không bao giờ** bị TTL monitor đụng tới — đó là ngữ nghĩa sẵn có của TTL index, không phải mẹo.

Nếu sau này muốn dọn dữ liệu cũ: chạy một script **riêng, có trần, gọi tay**, không nhét vào đường khởi động. Chưa làm ở phase này.

---

## 4. Resolver không dựa vào TTL

TTL là hàng rào **DUNG LƯỢNG**, không phải hàng rào **ĐÚNG ĐẮN**.

Không thêm bộ lọc `expiresAt` nào vào resolver, và đó là quyết định có căn cứ: `ResolveCurrentPosition` đã lọc `since = now - candidateWindowMs`, còn `PositionResolver` đã xếp bậc theo `sourceReceivedAt`. Một bản ghi quá hạn mà TTL chưa kịp xoá vẫn sẽ **thua** mọi ứng viên tươi hơn, hoặc rơi vào bậc `EXPIRED`/`NO_SOURCE_TIME` — tức là chính sách freshness đã bảo vệ canonical rồi. Thêm một lớp lọc thứ hai chỉ tạo thêm chỗ để hai lớp bất đồng.

---

## 5. Frame thô không được lưu

`IngestAisBatch` gọi thẳng `repository.saveMany(...)` với observation dựng từ `detailsResultToObservations` — **không** đi qua `ObservationRecorder`, nên `rawPayload` không bao giờ được gắn cho dữ liệu AIS.

Ngoài ra buffer AIS-3 chỉ giữ nhóm canonical, không giữ `MarineAisMessage`, không giữ chuỗi JSON, không giữ `WebSocket.RawData`.

⇒ **Không một byte frame AIS thô nào chạm MongoDB.**

---

## 6. Mẻ toàn bản trùng không còn gây resolve

**Trước AIS-5:** mọi MMSI trong mẻ đều được resolve, kể cả khi mọi observation của nó đều `SKIPPED_DUPLICATE`. Mỗi lượt resolve tốn 4 aggregate + 1–2 `findOne` ⇒ một mẻ 500 tàu không mang tin gì mới vẫn ngốn ~2.500–3.000 lượt đọc để ghi lại đúng thứ đã có.

**Sau AIS-5:** chỉ MMSI có **ít nhất một** observation `SAVED` mới được resolve.

An toàn vì phân xử là hàm thuần của (observation trong kho, `now`): không có bản ghi mới ⇒ bốn nhóm cho ra kết quả cũ ⇒ `currentVesselContentHash` trùng ⇒ kho trả `UNCHANGED` ⇒ lượt resolve đó **vốn đã không ghi gì**.

Ngữ nghĩa kết quả đổi theo:

| Trường | Trước | Sau |
|---|---|---|
| `vesselsAffected` | số MMSI trong mẻ | số MMSI **có dữ liệu mới** |
| `vesselsSkippedUnchanged` | — | **mới**: số MMSI bị bỏ qua vì không có gì mới |

⚠️ **Hệ quả đã biết:** bậc `freshness` lưu trong canonical **không tự già đi**. Tàu ngừng phát tín hiệu sẽ giữ nguyên `freshness: "LIVE"` trong document. Người đọc **phải** tính tuổi từ `position.observedAt`, đừng tin bậc đã lưu. Điều này vốn đã đúng từ trước (canonical chỉ được cập nhật khi có dữ liệu mới) — AIS-5 chỉ làm nó rõ hơn. **Phase Map phải xử lý đúng điểm này.**

---

## 7. Đo được gì

`npm run marine-ais:load-sim` — sự kiện tổng hợp, code thật, kho in-memory, không mạng, không Mongo.

Lần chạy `--vessels=2000 --events=20000 --drain-every=5000`:

| | |
|---|---|
| frame AIS | 20.000 |
| entry sau gộp | **7.850** (×0,39) |
| observation dựng | 7.850 |
| observation **ghi** | 7.850 (trùng: **0**) |
| canonical resolve | 7.850 |
| mẻ | 16 |
| **lượt đọc kho / tàu resolve** | **4,00** |
| lượt ghi kho | 16 (một `saveMany` mỗi mẻ) |
| đỉnh tàu trong buffer | 2.000 / trần 50.000 |
| đuổi khỏi buffer | 0 |
| observation POSITION | **≈ 596 B** JSON |
| observation IDENTITY | ≈ 450 B |

Đọc bảng này:

- **Gộp ăn 61 %** số frame ở tỉ lệ ~2,5 frame/tàu/cửa sổ. Tỉ lệ thật phụ thuộc nhịp phát và độ dài cửa sổ.
- **Trùng = 0** — đúng như §1 dự đoán: vị trí AIS không bao giờ trùng vân tay.
- **4,00 đọc/tàu** khớp chính xác với code: `ResolveCurrentVessel` chạy song song 4 truy vấn `findLatestPerSourceByVesselAndType`, mỗi nhóm một truy vấn. Cộng thêm 1–2 `findOne` của `MongoCurrentVesselRepository.locate()` và 1 lệnh ghi khi nội dung đổi.

⚠️ Con số **sự kiện/giây** của mô phỏng (≈3.900) **không** phản ánh production: kho in-memory quét tuyến tính, nên nó đo chính bộ giả lập chứ không đo Mongo. Muốn số thật thì dùng `npm run marine-ais:mongo-load-poc -- --confirm` trên database thử nghiệm.

---

## 8. 🔴 Ước lượng dung lượng — và vì sao cửa sổ gộp mới là cần vặn

Giả định: một tàu đang chạy phát vị trí mỗi 2–10 giây ⇒ nó có mặt trong **mọi** cửa sổ gộp. Mỗi entry ra khỏi buffer là **một** document (dedupe không chặn được — §1).

```
document/tàu/ngày = 86.400 / (cửa sổ tính bằng giây)
```

| Cửa sổ gộp | doc/tàu/ngày |
|---|---|
| **10 s** (mặc định hiện tại) | **8.640** |
| 30 s | 2.880 |
| 60 s | 1.440 |
| 300 s | 288 |

Với retention 48 giờ, kho ở trạng thái ổn định giữ **2 ngày**. Lấy ≈ **0,5 KB/document** đã gồm index và nén WiredTiger (đo được 596 B JSON; BSON tương đương, ~200 B index/doc, nén ~2,5×).

| Số tàu hoạt động | cửa sổ 10 s | cửa sổ 60 s | cửa sổ 300 s |
|---|---|---|---|
| **10.000** | 173 M doc · **86 GB** | 29 M · 14 GB | 5,8 M · **2,9 GB** |
| **50.000** | 864 M doc · **432 GB** | 144 M · 72 GB | 29 M · **14 GB** |
| **100.000** | 1,73 B doc · **864 GB** | 288 M · 144 GB | 58 M · **29 GB** |

Và tốc độ ghi tương ứng:

| Số tàu | cửa sổ 10 s | 60 s | 300 s |
|---|---|---|---|
| 10.000 | 1.000 insert/s · 4.000 đọc/s | 167 · 667 | 33 · 133 |
| 50.000 | **5.000 insert/s · 20.000 đọc/s** | 833 · 3.333 | 167 · 667 |
| 100.000 | 10.000 · 40.000 | 1.667 · 6.667 | 333 · 1.333 |

**Kết luận:** ở cửa sổ 10 giây, 50.000 tàu cần ~20.000 lượt đọc/giây chỉ để phân xử — vượt xa khả năng của một replica set thông thường, và 432 GB chỉ cho 2 ngày dữ liệu vị trí. Retention 48 giờ **không** cứu được điều đó; nó chỉ chặn phần đuôi.

> **Khuyến nghị:** đặt `AIS_COALESCE_WINDOW_MS=60000` (thận trọng) hoặc `300000` (an toàn) trước khi bật ingestion toàn cầu. Vị trí trễ tối đa 5 phút vẫn nằm gọn trong bậc `LIVE` (≤30 phút) của resolver, nên chất lượng map **không** đổi trong khi dung lượng giảm 30 lần.
>
> AIS-5 **không tự đổi mặc định** — đó là quyết định vận hành, và nó phải đi kèm số đo thật từ `mongo-load-poc`.

Các nhóm khác không đáng kể:

- **IDENTITY**: buffer chặn bằng vân tay, kho chặn tiếp bằng dedupe 24 giờ ⇒ ~1 document/tàu/lần đổi. 100.000 tàu × 90 ngày vẫn dưới vài triệu document.
- **PARTICULARS / VOYAGE**: AIS không cấp; chỉ nguồn crawl sinh ra, volume nhỏ.
- **`canonical_current_vessels`**: đúng **một** document mỗi tàu, không TTL. 100.000 tàu × ~2 KB ≈ **200 MB**. Không phải vấn đề.

---

## 9. Giới hạn còn lại

| # | | |
|---|---|---|
| 1 | **Cửa sổ gộp 10 giây chưa đủ để chạy toàn cầu** — xem §8. Đây là việc phải quyết trước phase Map | 🔴 |
| 2 | AIS POSITION 48h **ngắn hơn** cửa sổ resolver 7 ngày. Kịch bản hiếm: tàu im lặng > 48h rồi phát **một** frame static ⇒ resolve chạy, nhóm position rỗng ⇒ canonical bị ghi đè `position: null`. Hiếm vì static thưa hơn position rất nhiều, nhưng **có thật**. Cách chữa (phase sau): giữ nguyên nhóm cũ khi nhóm mới rỗng | 🟡 |
| 3 | `freshness` lưu trong canonical không tự già đi — §6 | 🟡 |
| 4 | 4 lượt đọc/tàu resolve chưa được tối ưu. Gộp thành **một** aggregate là khả thi nhưng phải mã hoá 4 cửa sổ thời gian khác nhau vào một truy vấn — chưa đáng đổi khi chưa có số đo Mongo thật | 🟡 |
| 5 | Số đo mới chỉ từ mô phỏng in-memory. `mongo-load-poc` đã sẵn sàng nhưng **chưa chạy** trên Mongo thật | 🟡 |
| 6 | TTL monitor có độ trễ ⇒ dung lượng đỉnh cao hơn lý thuyết một chút | 🟢 chấp nhận |

---

## 10. Công cụ

```bash
# Mô phỏng toàn đường ống, không mạng, không Mongo
npm run marine-ais:load-sim -- --vessels=2000 --events=20000 --drain-every=5000
node --expose-gc -r ts-node/register src/interfaces/cli/marineAisLoadSim.ts   # số bộ nhớ sạch

# Đo trên Mongo THẬT — chạy tay, hai lớp chặn
npm run marine-ais:mongo-load-poc -- --confirm --vessels=2000 --events=20000
```

Hai lớp chặn của `mongo-load-poc`: bắt buộc `--confirm`, **và** từ chối mọi database không mang dấu hiệu thử nghiệm (`test`/`sim`/`load`/`sandbox`/`dev`/`local`/`staging`) trừ khi thêm `--force`. URI được che credential trước khi in.

---

## 11. File

| File | |
|---|---|
| `src/application/services/observation/ObservationRetentionPolicy.ts` | bảng retention, không biết Mongo |
| `src/infrastructure/persistence/mongo/observationModels.ts` | field `expiresAt` + TTL index |
| `src/infrastructure/persistence/mongo/MongoVesselObservationRepository.ts` | tính `expiresAt` ở ranh giới persistence |
| `src/application/use-cases/ingestion/IngestAisBatch.ts` | chỉ resolve tàu có dữ liệu mới |
| `src/interfaces/cli/marineAisLoadSim.ts` | mô phỏng tải |
| `src/interfaces/cli/marineAisMongoLoadPoc.ts` | đo trên Mongo thật, gọi tay |

---

## 12. Sẵn sàng cho phase Map chưa?

**Chưa — còn một quyết định phải chốt.**

| Điều kiện | |
|---|---|
| Kho observation có trần | ✅ TTL theo (nguồn, nhóm) |
| Frame thô không lưu | ✅ |
| Canonical không TTL | ✅ |
| Bộ nhớ buffer có trần | ✅ đo được |
| Khuếch đại ghi/đọc đã đo | ✅ |
| **Tốc độ ghi ở cửa sổ 10 s chịu được** | ❌ **phải nâng cửa sổ gộp trước** |
| Số đo trên Mongo thật | ❌ chưa chạy |

Việc phải làm trước khi mở phase Map: (a) chốt `AIS_COALESCE_WINDOW_MS`, (b) chạy `mongo-load-poc` trên database thử nghiệm để xác nhận tốc độ ghi và độ trễ resolve ở cấu hình đã chốt.

---

*Không sửa file nào của Soosky-marine-api.*
