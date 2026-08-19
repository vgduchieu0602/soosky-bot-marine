# Làm giàu chi tiết có chủ đích — giai đoạn DETAIL-2

> Bấm vào một con tàu → đọc canonical trước; thiếu thì **chỉ** lấy đúng nhóm đang thiếu, từ **nguồn free** đã có.
>
> Không endpoint HTTP, không MyShipTracking, không crawl hàng loạt, không đụng production.
>
> Tiếp nối [DETAIL_CANONICAL_READ_MODEL.md](./DETAIL_CANONICAL_READ_MODEL.md) (DETAIL-1 · đọc thuần).

---

## 0. Tóm tắt

| # | | |
|---|---|---|
| 1 | **Đọc trước, luôn luôn.** Canonical đủ và tươi → **0** lần gọi nguồn ngoài | 🟢 |
| 2 | `refreshGroups` của DETAIL-1 lái việc chọn nguồn — không hardcode thứ tự | 🟢 |
| 3 | Dùng lại **nguyên** `FreeSourceSelector` (P9): cổng chi phí loại PAID + AISSTREAM | 🟢 |
| 4 | Ngân sách thời gian là của **CẢ LƯỢT**, không phải mỗi nguồn | 🟢 |
| 5 | **Single-flight**: 10 người bấm cùng lúc → 1 lượt crawl | 🟢 |
| 6 | **Cooldown**: bấm lại ngay → không hỏi nguồn lần nữa | 🟢 |
| 7 | Thành công một phần **là thành công** | 🟢 |
| 8 | Mọi nguồn free hỏng → trả thứ đang có, **tuyệt đối không** gọi nguồn trả tiền | 🟢 |

---

## 1. Luồng

```
{ mmsi? , imo? , forceRefresh? }
        ↓
GetCanonicalVesselDetail            ← ĐỌC TRƯỚC, và định danh rác bị chặn ở đây
        ↓
đủ + tươi + !force ?  ── CÓ ──►  trả ngay, attempts = []
        │ KHÔNG
        ↓
DetailRefreshGate.filterAllowed     ← cooldown theo (tàu, nhóm)
        ↓
DetailRefreshGate.runSingleFlight   ← gộp request đồng thời
        ↓
   vòng lặp ≤ maxSources, trong ngân sách:
        FreeSourceSelector.select()        ← chọn nguồn theo capability
        CollectVesselObservations.execute()← qua crawl runtime P4
        ResolveAndStoreCurrentVessel       ← phân xử lại
        GetCanonicalVesselDetail           ← đọc lại, còn thiếu gì?
        đủ rồi → DỪNG SỚM
        ↓
trả detail + attempts + nhóm còn thiếu
```

⛔ `GetCanonicalVesselDetail` **không bị sửa một dòng nào** — nó phải mãi là đọc thuần. DETAIL-2 là lớp trên.

---

## 2. Đọc trước

Canonical `FOUND` + `needsRefresh = false` + `forceRefresh = false` → **trả ngay, không chạm nguồn ngoài**.

Đây là đường đi thường gặp nhất: người dùng bấm vào một chấm trên map mà vị trí vừa từ AIS về vài giây trước. Có test khoá số lần gọi provider = 0.

`NOT_FOUND` **không** phải lỗi cuối: được phép đi lấy bằng định danh, rồi đọc lại. Vẫn không có thì trả `NOT_FOUND`.

---

## 3. Chọn nguồn theo năng lực

Cầu nối giữa DETAIL-1 và P9 là **mười dòng**, không phải một tầng abstraction mới:

```
refreshGroups (DetailGroup[])
   → MissingRequirement[] { group, reason: MISSING_GROUP }
   → SufficiencyResult { satisfied: false, need: FULL, missing }
   → FreeSourceSelector.select()
   → SourceAttemptPlan { source, operation, identifier, targetFields }
```

Nhờ vậy DETAIL-2 **thừa hưởng toàn bộ** năm cổng lọc của P9 mà không viết lại cái nào:

| cổng | tác dụng ở đây |
|---|---|
| chi phí | loại `PAID` (MyShipTracking) **và** `EXISTING_STREAM` (AISSTREAM) |
| capability | chỉ nguồn `CONFIRMED` cho nhóm đang thiếu |
| định danh | ShipFinder chỉ tra được MMSI → yêu cầu chỉ có IMO thì bỏ qua |
| đã thử rồi | `AttemptScope.CURRENT_REQUEST` → không chọn lại nguồn vừa hỏng |
| sức khoẻ | `COOLDOWN`/`DISABLED` bị loại |

⛔ Không bảng ưu tiên thứ hai, không `if (group === PARTICULARS) return SHIPINFO`.

### Nguồn nào lấp được nhóm nào (theo bảng năng lực nguồn)

| Nhóm | Nguồn free CONFIRMED |
|---|---|
| IDENTITY | ShipInfo · ShipFinder · VesselFinder |
| PARTICULARS | ShipInfo (`builtYear`, `deadweight`) · ShipFinder (`length`, `beam`, `draught`) · VesselFinder (`length`, `beam`, `draught`) |
| VOYAGE | **chỉ ShipFinder** (`destination`) |
| POSITION | ShipFinder (tươi theo phút) · ShipInfo (⚠️ trễ ~14 giờ) · VesselFinder |

⚠️ `grossTonnage` hiện **không nguồn free nào** CONFIRMED. AISSTREAM bị loại khỏi đường này theo thiết kế — nó là stream đã có, không phải nguồn tra theo yêu cầu.

---

## 4. Giới hạn

| | mặc định | biến |
|---|---|---|
| ngân sách **cả lượt** | 10 giây | `DETAIL_REFRESH_TIMEOUT_MS` |
| số nguồn hỏi ra ngoài | 2 | `DETAIL_REFRESH_MAX_SOURCES` |
| cooldown sau khi làm mới | 5 phút | `DETAIL_REFRESH_COOLDOWN_MS` |

Ba núm, không hơn.

### Ngân sách là của CẢ LƯỢT

```
ngân sách 10s
nguồn A mất 6s  ->  nguồn B chỉ còn ~4s
```

**Không** 3 nguồn × 10s = 30s. Trước mỗi nguồn: còn dưới 1,5 giây thì **không bắt đầu** — mở một request mà biết chắc sẽ bị cắt chỉ tổ tốn một lượt hỏi của nguồn.

Chặn bằng `Promise.race` với timer theo phần ngân sách **còn lại**. ⚠️ Request phía dưới vẫn chạy nốt (chưa có đường huỷ tới tận HTTP client) — người gọi không bị giữ, nhưng nguồn vẫn nhận đủ một request. Ghi rõ ở đây vì đó là giới hạn thật.

### Nguồn chưa có provider không ăn suất

`NO_PROVIDER` / `UNSUPPORTED_OPERATION` chưa ra khỏi tiến trình, nên không tính vào trần 2 nguồn. Trần đó đếm **số lần đánh ra ngoài**, không phải số vòng lặp.

### Dừng sớm

Sau mỗi nguồn **thành công**: ghi observation → phân xử lại → **đọc lại** → nhóm nào còn thiếu. Hết thiếu thì **dừng**, không hỏi nguồn tiếp theo.

---

## 5. Kết quả hữu ích ≠ nguồn trả 200

Nguồn trả dữ liệu nhưng không có nhóm đang cần → `NO_USEFUL_DATA`, đi tiếp. Ghi được nhưng **toàn bản trùng vân tay** cũng vậy: không có gì mới để phân xử.

Chỉ khi `CollectStatus.RECORDED` **và** có observation mới thì mới tính `SUCCESS` và mới chạy resolver.

---

## 6. Lỗi từ nguồn

Một nguồn hỏng **không** làm chết cả request. Phân loại dùng lại đúng `SourceErrorCategory` của runtime P4:

| | |
|---|---|
| `SUCCESS` | có observation mới |
| `NO_USEFUL_DATA` | không có nhóm cần / toàn bản trùng / chưa có provider |
| `NOT_FOUND` | nguồn nói rõ "không có tàu này" |
| `TIMEOUT` · `BLOCKED` · `RATE_LIMITED` · `ERROR` | hỏng kỹ thuật |
| `SKIPPED_COOLDOWN` | runtime đang cho nguồn nghỉ |

⚠️ `NOT_FOUND` map sang `AcquisitionOutcome.NOT_FOUND`, **không** phải `FAILED`: nguồn trả lời rõ ràng là nguồn **đang khoẻ**. Đếm nó là hỏng sẽ đẩy oan nguồn vào cooldown.

Mọi lượt gọi đi qua **crawl runtime P4** — rate limit, nhịp nghỉ, timeout, retry, cooldown, health. ⛔ Không đường vòng nào.

---

## 7. Chống bão request

Hai cơ chế **khác nhau**, thiếu cái nào cũng để lọt một đường:

| | |
|---|---|
| **Single-flight** | 10 người bấm **cùng lúc** → 1 lượt crawl, 9 người chờ chung Promise |
| **Cooldown** | Vừa crawl xong, 5 giây sau bấm lại → **không** crawl lại |

Single-flight gộp request **đồng thời**; cooldown chặn request **lặp lại sau đó**.

Chi tiết:

- Khoá single-flight theo **tàu**; khoá cooldown theo **(tàu, nhóm)** — vừa lấy identity không chặn việc đi lấy voyage.
- `finally` nhả khoá: một lần lỗi **không** được khoá vĩnh viễn con tàu đó. Có test.
- Thất bại có cooldown **ngắn hơn** (1 phút) thành công (5 phút): hỏng có thể là tạm thời, còn dữ liệu vừa lấy chắc chắn chưa đổi trong vài phút.
- Bộ nhớ **có trần** (20.000 khoá, đuổi khoá cũ nhất). Đây là bộ nhớ theo lượt bấm của người dùng — một đợt truy cập bất thường không được biến nó thành rò rỉ.
- Hai tàu khác nhau chạy **độc lập**, không xếp hàng toàn cục.

⛔ Không Redis. Nhiều tiến trình thì mỗi tiến trình có gate riêng — chấp nhận được vì runtime P4 mới là hàng rào cuối.

### `forceRefresh`

Vượt được cooldown của **ứng dụng**. ⛔ **Không** vượt được sức khoẻ/cooldown của runtime P4, và **không** vượt được ngân sách thời gian. Hàng rào chống bị chặn không có công tắc tắt.

---

## 8. Thành công một phần

```
cần   : IDENTITY, PARTICULARS, VOYAGE
ShipInfo lấp: IDENTITY + PARTICULARS
còn   : VOYAGE
```

→ trả detail **đã cải thiện**, `remainingMissingGroups = ["VOYAGE"]`. ⛔ Không ném lỗi, không coi cả request là hỏng.

Mọi nguồn free hỏng → trả thứ đang có kèm `attempts`. ⛔ **Tuyệt đối không** gọi MyShipTracking — có test đăng ký hẳn một provider MyShipTracking giả và khẳng định nó **không bị gọi lần nào**. Fallback trả tiền là phase riêng, phải đi qua `PaidFallbackGate`.

---

## 9. Kết quả trả về

```ts
{
  detail, status, refreshed,
  requestedGroups, refreshedGroups,
  remainingMissingGroups, remainingStaleGroups,
  attempts: [{ source, status, durationMs }]
}
```

⛔ Không HTML thô, không thông báo lỗi của nguồn, không stack trace.

Log **một dòng** mỗi lượt: định danh · nhóm cần · nguồn đã thử + trạng thái · nhóm lấy được · thời gian. ⛔ Không log body trang.

---

## 10. Danh sách file

| File | |
|---|---|
| `application/services/vessel/DetailRefreshGate.ts` | single-flight + cooldown, có trần |
| `application/use-cases/vessel/GetOrRefreshVesselDetail.ts` | điều phối |
| `src/config/index.ts` · `.env.example` | ba núm |

⛔ Use case **không import** mongoose / Mongo repository / model — có test soi các dòng `import`.

---

## 11. Giới hạn còn lại

| # | | |
|---|---|---|
| 1 | Hết ngân sách chỉ **cắt phía người gọi**; request đã mở vẫn chạy nốt tới nguồn. Cần AbortSignal xuyên xuống HTTP client mới cắt thật | 🟡 |
| 2 | Gate là **trong tiến trình**. Nhiều instance → mỗi cái một gate; hàng rào cuối vẫn là runtime P4 | 🟡 |
| 3 | `grossTonnage` không nguồn free nào CONFIRMED → luôn nằm trong `refreshGroups` của PARTICULARS và không bao giờ lấp được. Cần hoặc nâng capability sau POC, hoặc chấp nhận là nhóm "một phần" | 🟡 |
| 4 | VOYAGE chỉ ShipFinder cấp → ShipFinder chết là voyage đứng hình | 🟡 |
| 5 | Cooldown 5 phút là **phỏng đoán có cơ sở**, chưa đo từ hành vi người dùng thật | 🟡 |
| 6 | Chưa có bộ đếm gộp ở mức use case (gate có `getStats()`, use case thì chưa) | 🟢 |

---

## 12. DETAIL-3 (chưa làm)

1. `PaidFallbackGate` + MyShipTracking cho nhóm cảng — 9 cổng đã dựng sẵn từ P9, chưa ai đi qua.
2. Bộ đếm/quan sát ở mức use case: tỉ lệ trả ngay vs phải làm mới, tỉ lệ gộp single-flight.
3. Đo hành vi thật rồi chỉnh cooldown/ngân sách.
4. Chỉ sau đó mới bàn adapter `VesselExtended` và endpoint.

⛔ DETAIL-3 **không** làm: endpoint HTTP · sửa production · crawl hàng loạt.

---

*Không sửa file nào của Soosky-marine-api.*
