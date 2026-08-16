# AIS_COALESCING_BUFFER — phase AIS-3

> Hãm vòi rồng AIS **trước** khi nó đụng MongoDB: nhiều cập nhật của cùng một tàu trong một cửa sổ chỉ còn lại trạng thái **mới nhất**.
>
> Phase này **chưa** ghi gì cả. Không Mongo, không observation, không resolver.
>
> Tiếp nối [AIS_CANONICAL_INGESTION.md](./AIS_CANONICAL_INGESTION.md) (AIS-1 · mapping) và [AIS_MARINE_WS_BRIDGE.md](./AIS_MARINE_WS_BRIDGE.md) (AIS-2 · transport).

---

## 0. Đường đi

```
MarineAisWebSocketClient
      ↓  normalizedData  (đồng bộ, O(1))
AisCoalescingBuffer            ← trạng thái MỚI NHẤT / MMSI, có TRẦN
      ↓  drainBatch(limit)
AisCoalescedBatch              ← mẻ có kích thước biết trước
      ↓
(AIS-4: detailsResultToObservations → bulkWrite)
```

---

## 1. Vì sao phải gộp

AIS toàn cầu phát vài nghìn frame/giây. Một con tàu đang chạy phát vị trí mỗi 2–10 giây.

```
12:00:01  MMSI A  →  P1
12:00:03  MMSI A  →  P2
12:00:06  MMSI A  →  P3
─────────────────────────  flush 12:00:10
                 A  →  P3
```

Nếu mỗi frame là một lệnh ghi:

- Mongo chết vì khối lượng, không phải vì kích thước.
- 2/3 bản ghi kia **không ai đọc** — thứ map cần là vị trí mới nhất.

Hai luật cứng của phase này:

- ⛔ **Không** `messages.push(...)` vô hạn.
- ⛔ **Không** 1 frame = 1 lệnh ghi.

---

## 2. Position và Static phải TÁCH

⛔ Sai:

```ts
Map<mmsi, ProviderDetailsResult>   // vị trí mới đè mất identity
```

`PositionReport` phát mỗi 2–10 giây, `ShipStaticData` mỗi ~6 phút. Nhét chung một ô rồi để cái sau đè cái trước sẽ **xoá sạch tên tàu chỉ vì nó vừa nhúc nhích**.

Nên mỗi ô giữ hai nhóm độc lập. Chuỗi `Position → Position → Static → Position` phải flush ra **cả hai**:

```
latest position  = P4
latest identity  = S1
```

⚠️ Buffer **không phải resolver**: nó không ghép identity với position thành một con tàu, không so nguồn này với nguồn kia. Nó chỉ giữ "AIS vừa nói gì" theo **nhóm**. Hợp nhất là việc của resolver đã có từ P8.

---

## 3. Luật thay thế vị trí

Không phải "frame tới sau thì thắng". So bằng **mốc của nguồn**:

```ts
positionInstantMs = metadata.sourceReceivedAt ?? receivedAt
```

| Tình huống | Xử lý | Bộ đếm |
|---|---|---|
| mốc nguồn **mới hơn** | thay, đánh dấu chờ drain | `positionReplaced` |
| mốc nguồn **cũ hơn** | **bỏ** | `olderPositionIgnored` |
| mốc nguồn **bằng nhau** | cùng một bản tin phát lại → lấy bản tới sau nếu đang chờ drain, **không** tạo việc mới nếu ô đã sạch | `positionDuplicates` |

Ví dụ bắt buộc đúng:

```
frame tới #1 : sourceReceivedAt = 12:10   ← GIỮ
frame tới #2 : sourceReceivedAt = 12:09   ← bỏ, dù nó tới SAU
```

⚠️ **Không dùng `fetchedAt`.** Đường truyền có thể xóc; AIS-1 tách hai mốc chính vì lý do này.

Mốc nguồn được **giữ lại cả sau khi drain** (`lastPositionMs`), nên một frame cũ tới muộn **sau** flush vẫn bị chặn.

### Vì sao không có vân tay cho vị trí

`time_utc` của AISStream có độ phân giải nano-giây → hai bản tin khác nhau trùng mốc gần như không xảy ra. Dựng một chuỗi vân tay cho **mỗi frame** trên hot path để bắt một trường hợp gần như không tồn tại là đổi sai chiều. So mốc là đủ.

---

## 4. Luật khử trùng identity

`ShipStaticData` phát lặp **cùng một nội dung** mỗi ~6 phút cho mọi tàu. Đẩy hết xuống DB là tự tạo lũ bản ghi trùng.

Vân tay, chuỗi ngắn:

```
imo | name | vesselTypeCode        → "9074729|AGIA DOXA|70"
```

- MMSI **không** nằm trong vân tay — nó chính là khoá của ô nhớ.
- ⛔ **Không băm mật mã.** Đây là hot path của stream toàn cầu; SHA-256 mỗi frame là đốt CPU cho một bài toán không tồn tại. Ta chỉ cần biết "có khác cái vừa rồi không", không cần chống va chạm có chủ đích.

Vân tay **ở lại** sau khi drain, còn object identity thì được thả. Nhờ vậy không cần map thứ hai để khử trùng — chi phí là một chuỗi ~20 byte trong chính ô đã có.

---

## 5. Ô nhớ

```ts
interface BufferEntry {
  position: VesselPositionReport | null;   // đang chờ drain
  identity: VesselIdentity | null;         // đang chờ drain
  lastPositionMs: number | null;           // mốc nguồn mới nhất TỪNG thấy
  identityFingerprint: string | null;      // identity mới nhất TỪNG thấy
}
```

Sau drain: hai object đầu về `null`, hai trường sau **ở lại**. Đó là toàn bộ lý do ô còn tồn tại khi không có gì chờ — giữ đủ để chặn vị trí cũ đến muộn và identity lặp, mà không ôm nguyên object.

Đây là phương án **dirty flag** (§23 của yêu cầu). Phương án "xoá ô sau drain" đơn giản hơn nhưng làm **mất** khả năng khử trùng identity và mất luôn hàng rào chống vị trí cũ.

Hai cấu trúc, cả hai đều có trần:

| | |
|---|---|
| `Map<mmsi, BufferEntry>` | trạng thái, trần = `AIS_MAX_BUFFERED_VESSELS` |
| `Set<mmsi>` | khoá đang chờ drain — **tập con** của map, nên cùng trần |

---

## 6. Chính sách đuổi

LRU-ish, dựa vào **thứ tự chèn của `Map`** — không cài package LRU nào:

```ts
entries.delete(mmsi);   // touch: nhấc ra
entries.set(mmsi, e);   //        thả xuống CUỐI
```

Khoá đầu bảng luôn là tàu lâu nhất chưa đụng tới → nạn nhân.

Vượt trần → đuổi tàu lâu nhất chưa cập nhật. Ô bị đuổi **còn dữ liệu chờ** = mất dữ liệu thật → đếm riêng `evictedDirty`, không giấu.

### ⚠️ `keys().next()` KHÔNG phải O(1) — đo được 94 lần chậm hơn

Cách viết hiển nhiên:

```ts
const oldest = entries.keys().next().value;   // ❌ bậc hai
```

Mỗi lời gọi dựng một iterator **mới từ đầu bảng**, mà đầu bảng của V8 `OrderedHashMap` đầy ô đã xoá (mỗi lần touch là một `delete`). Iterator phải bỏ qua từng ô chết một → chi phí tăng theo số lần đã đuổi.

Đo trực tiếp, 400.000 lần chèn với trần 50.000:

| Cách | Thời gian |
|---|---|
| `keys().next()` mỗi lần đuổi | **10.682 ms** |
| iterator **dùng lại** | **114 ms** |
| touch (delete+set) không đuổi — đối chứng | 144 ms |

Cột giữa và cột dưới gần bằng nhau → toàn bộ chi phí phụ trội nằm ở việc dựng lại iterator, không phải ở churn của `Map`.

Cách làm: giữ **một con trỏ** `IterableIterator<string>`, đẩy nó đi một bước mỗi lần đuổi, dựng lại chỉ khi hết bảng. Iterator của `Map` là **sống** — phần tử thêm sau vẫn được duyệt tới, phần tử đã xoá không bao giờ trả ra — nên giữ nguyên con trỏ là an toàn.

Một hàng rào nữa: con trỏ trả về đúng tàu **vừa nạp** thì dựng lại từ đầu — đuổi nó là vứt đi đúng dữ liệu mới nhất.

Hệ quả trên mô phỏng thật: **13.567 ms → 457 ms** cho 400k sự kiện dưới áp lực đuổi.

Có test khoá tính đúng đắn (200 vòng đuổi liên tiếp, và touch xen kẽ đuổi 100 vòng). **Không** có assertion về tốc độ — máy khác nhau (§42).

---

## 7. Rút theo mẻ

```ts
buffer.drainBatch(limit?)   // ≤ limit tàu, hoặc null nếu không có gì chờ
buffer.drainAll(maxBatches) // nhiều mẻ, có trần số mẻ
```

⚠️ **Không được mất phần dư.** 20.000 tàu với mẻ 500 phải ra **40 mẻ**, không phải 1 mẻ rồi xoá sạch 19.500 tàu còn lại. `drainBatch` chỉ xoá đúng những gì đã đưa ra; phần dư ở lại hàng chờ, và `batch.remaining` nói còn bao nhiêu.

`drainAll(maxBatches)` có trần vì rút không giới hạn sẽ **khoá vòng lặp sự kiện** khi buffer đang phình (50.000 tàu / mẻ 500 = 100 mẻ liên tiếp). Phần dư để lại cho chu kỳ sau — buffer vẫn chỉ giữ trạng thái mới nhất nên chờ không làm dữ liệu cũ đi, chỉ làm nó được gộp thêm.

`AisCoalescedEntry` kế thừa `ProviderDetailsResult` → AIS-4 đưa thẳng vào `detailsResultToObservations()`, không cần lớp chuyển đổi nào.

---

## 8. Backpressure

Đây là điểm quan trọng nhất của cả phase.

Consumer chậm **không** làm hàng đợi phình, vì **không có hàng đợi mẻ**:

```
❌ Batch1 → Batch2 → Batch3 → …        (queue vô hạn)
✅ Map<mmsi, trạng thái mới nhất>      (cập nhật mới ĐÈ cái cũ)
```

1.000 lần cập nhật của cùng một tàu mà chưa ai drain → vẫn **một** ô, **một** đơn vị việc. Consumer càng chậm thì tỉ lệ gộp càng cao. Đây là tính chất, không phải tác dụng phụ.

Trần cứng vẫn là `AIS_MAX_BUFFERED_VESSELS`: vượt → đuổi, và `evictedDirty` cho biết đang mất gì.

---

## 9. Bộ nhớ đo được

`npm run marine-ais:buffer-sim`. Số dưới đây đo trên máy dev, Node 22, kèm `--expose-gc` để loại rác chưa thu:

```
node --expose-gc -r ts-node/register src/interfaces/cli/marineAisBufferSim.ts \
     --vessels=80000 --events=400000 --max-vessels=50000
```

| Trạng thái | 50.000 tàu | ≈/tàu |
|---|---|---|
| Sau khi drain (chỉ mốc + vân tay) | **3,4 MiB** | ~72 B |
| Đỉnh, cả 50.000 ô còn ôm object vị trí chưa rút | **19,7 MiB** | ~413 B |

Thông lượng cùng lần chạy: **~940.000 sự kiện/giây**, 350.000 lần đuổi, đỉnh đúng 50.000 tàu.

⚠️ Con số thông lượng **chỉ để tham khảo**, phụ thuộc máy. Không đưa vào assertion ở bất kỳ test nào.

Kết luận cho AIS-4: 50.000 tàu tốn **~20 MiB** ở trạng thái xấu nhất. Trần có thể nâng nếu cần, nhưng hãy theo dõi `evictedDirty` trước khi nâng.

---

## 10. Vì sao bỏ điểm trung gian — CÓ CHỦ Ý

10 giây có 5 vị trí → chỉ vị trí cuối đi tiếp. **Bốn điểm kia mất hẳn.**

Đây là **lựa chọn**, không phải giới hạn kỹ thuật. Buffer phục vụ:

> **trạng thái map hiện tại** (`canonical_current_vessels`)

Nó **không** phục vụ:

> lịch sử hành trình / voyage track

Không ô nhớ nào có `positions[]`. Cần lịch sử thì đó là một use case riêng với kho riêng và chính sách lưu trữ riêng — **không** phải mở rộng buffer này. Nhét lịch sử vào đây là quay lại đúng bài toán vô hạn mà buffer sinh ra để giải.

Tương tự, **chưa** có ưu tiên riêng cho tàu trả tiền theo dõi. AIS-3 chỉ là ingestion map toàn cầu miễn phí; paid tracking là phase khác.

---

## 11. Cấu hình

```bash
AIS_COALESCE_WINDOW_MS=10000
AIS_MAX_BUFFERED_VESSELS=50000
AIS_FLUSH_BATCH_SIZE=500
```

| Biến | Mặc định | Lý do |
|---|---|---|
| `AIS_COALESCE_WINDOW_MS` | 10.000 | Vị trí phát mỗi 2–10 giây → cửa sổ 10 giây gộp được 1–5 frame/tàu mà map vẫn tươi hơn nhiều so với bậc `LIVE` (≤30 phút) của resolver |
| `AIS_MAX_BUFFERED_VESSELS` | 50.000 | ~20 MiB ở trạng thái xấu nhất (đo được). Đủ cho phần lớn tàu đang phát ở một thời điểm, mà vẫn là con số dễ chấp nhận trên một container nhỏ |
| `AIS_FLUSH_BATCH_SIZE` | 500 | Kích thước `bulkWrite` quen thuộc: đủ lớn để amortize round-trip, đủ nhỏ để không giữ vòng lặp sự kiện lâu |

Cả ba đều `positiveNum` → sai là **hỏng lúc khởi động**, không chạy với `NaN`.

---

## 12. Điểm nối, và vì sao nó nằm im

`MarineAisIngestionCoordinator` là dây nối mỏng:

```ts
client.on(NORMALIZED_DATA, (e) => buffer.accept(e));   // đồng bộ, O(1)
setInterval(() => flushNow(), windowMs);               // emit("batch", …)
```

Toàn bộ logic gộp nằm ở buffer (thuần, **không timer**) → test buffer không phải chờ đồng hồ một mili-giây nào. Coordinator chỉ có listener và **một** `setInterval`.

`stop()` ngắt nguồn **trước**, rút nốt **sau** — đảo thứ tự sẽ để lọt frame vào buffer sau lần rút cuối rồi mất luôn.

⛔ `container.ts` **không** đụng tới. Không service nào, không test nào, không lệnh build nào tự dựng coordinator.

---

## 13. Hot path — những thứ tuyệt đối không được có

`normalizedData` → `Map.get/set` → `return`. Chỉ vậy.

Không: `JSON.stringify` object lớn · băm mật mã · truy cập DB · `await` · `console.log` mỗi sự kiện · mảng lịch sử · giữ frame thô.

Buffer **không** gọi `detailsResultToObservations()` — chưa có gì để persist thì chuyển đổi sớm chỉ là đốt CPU. AIS-4 chuyển đổi theo **mẻ**.

Node đơn luồng và `accept()`/`drainBatch()` đều đồng bộ → **không cần** mutex, không thêm thư viện khoá.

---

## 14. File

| File | |
|---|---|
| `src/application/services/ingestion/AisCoalescingBuffer.ts` | state thuần, không timer |
| `src/infrastructure/integrations/marine-ais/MarineAisIngestionCoordinator.ts` | dây nối client ↔ buffer + một timer |
| `src/application/services/ingestion/AisCoalescingBuffer.test.ts` | luật gộp, đuổi, rút mẻ |
| `src/infrastructure/integrations/marine-ais/marineAisIngestion.test.ts` | WS giả → client → buffer → mẻ |
| `src/interfaces/cli/marineAisBufferSim.ts` | mô phỏng tải tổng hợp, không mạng |
| `src/config/index.ts` · `.env.example` | ba biến ở §11 |

---

## 15. Rủi ro trước khi có Mongo

| # | | |
|---|---|---|
| 1 | `evictedDirty` > 0 nghĩa là **đang mất dữ liệu thật**. Chưa có cảnh báo nào cho nó — AIS-4 phải đưa lên log/metric | 🔴 |
| 2 | Chưa đo trên stream production thật, nên chưa biết số MMSI hoạt động đồng thời. Trần 50.000 là **phỏng đoán có cơ sở**, không phải số đo | 🟡 |
| 3 | Mẻ 500 × 2 nhóm = tối đa 1.000 observation mỗi `bulkWrite` — chưa đo độ trễ Mongo thật | 🟡 |
| 4 | Buffer nằm trong RAM: bot restart là mất phần chưa rút. AIS phát lại nên tự lành, nhưng identity thì thưa (~6 phút) | 🟡 |
| 5 | Fingerprint identity chỉ gồm `imo|name|vesselTypeCode`. Nếu sau này canonical thêm field từ AIS, phải mở rộng vân tay, nếu không thay đổi sẽ bị nuốt | 🟡 |

---

## 16. AIS-4 (chưa làm)

1. Nghe `batch` → `detailsResultToObservations` theo **mẻ** → `ObservationRecorder` → `bulkWrite`.
2. Chống ghi lặp bằng `observationFingerprint` đã có từ P5.
3. `evictedDirty` và độ trễ ghi lên log/metric; buffer đầy là tín hiệu phải nâng trần hoặc tăng tốc consumer.
4. Chỉ khi ghi đã ổn định mới nối resolver → `canonical_current_vessels`.
5. Nối bootstrap/scheduler **sau cùng**.

⛔ AIS-4 **không** làm: GeoJSON · MyShipTracking · bậc freshness `REALTIME` · lịch sử hành trình · sửa production.

---

*Không sửa file nào của Soosky-marine-api.*
