# Miễn phí trước, trả phí sau

Đây là hợp đồng phía Bot cho chuỗi `LOCAL → CRAWL MIỄN PHÍ → API TRẢ PHÍ`.

Bên sở hữu: Soosky-bot-marine. Bên sử dụng: Soosky-marine-api.

Trạng thái: phần điều phối đã lập trình và đã nối dây cho **LOCAL + MIỄN PHÍ**. Nhánh trả phí **cố ý chưa nối vào nơi lắp ráp** — xem mục 9. Cả hai công tắc đang tắt: `PAID_FALLBACK_ENABLED=false`, `INTERNAL_ACQUIRE_TOKEN=` (rỗng).

---

## 1. Vì sao việc dự phòng không được viết bằng `catch`

Đây là kiểu code mà tài liệu này thay thế:

```ts
// ⛔ tuyệt đối không
try { await crawl(mmsi) } catch { await myShipTracking(mmsi) }
```

Nó sai vì những lý do chẳng liên quan gì tới thẩm mỹ code:

| Vấn đề | Hậu quả |
|---|---|
| `catch` không phân biệt được "tàu không tồn tại" với "nguồn trả 503" | một lỗi 404 cũng tiêu mất một credit |
| Parser vỡ thì ném exception | một lần đổi HTML biến **mọi** request thành request trả phí |
| Luật nằm trong controller | không ai trả lời được câu "khi nào thì hệ thống tiêu tiền?" nếu chưa đọc code route |
| Không có cooldown, không kiểm tra năng lực nguồn | bấm 20 lần vào một con tàu = 20 credit |

Vì thế quyết định được gom vào đúng một file ở tầng application, [GetVesselWithFallback.ts](../src/application/use-cases/vessel/GetVesselWithFallback.ts) — chỗ có thể đọc và test được. Ranh giới HTTP chỉ làm việc dịch qua lại.

---

## 2. Ba nhánh

Ba thành phần, giai đoạn này không sửa cái nào:

| Nhánh | Use case | Chi phí | Tuyệt đối không làm |
|---|---|---|---|
| LOCAL | [GetCanonicalVesselDetail](../src/application/use-cases/vessel/GetCanonicalVesselDetail.ts) | 0 | đi ra khỏi tiến trình |
| MIỄN PHÍ | [GetOrRefreshVesselDetail](../src/application/use-cases/vessel/GetOrRefreshVesselDetail.ts) | 0 | đụng vào MyShipTracking — luật vĩnh viễn |
| TRẢ PHÍ | [TrackVesselCurrentPosition](../src/application/use-cases/tracking/TrackVesselCurrentPosition.ts) | 1 credit mỗi lần thành công | tự động thay thế nhánh miễn phí khi chưa qua cổng kiểm tra |

`GetVesselWithFallback` **chỉ điều phối**. Nó không chứa crawler, không chứa HTTP client, không giữ danh sách nguồn. Có hai test cấu trúc chốt việc các nhánh không dính vào nhau: nhánh miễn phí không được import gì thuộc phần trả phí, và nhánh trả phí không được import nhánh miễn phí.

---

## 3. Luồng chạy

```
{ mmsi? | imo?, need, allowPaidFallback? }
   │
   ├─ khoá chống gọi trùng vòng ngoài = `${mmsi}/${imo}|${need}`   ← bấm 10 lần = 1 lượt xử lý
   │
   ▼
ĐỌC LOCAL (dữ liệu chuẩn, độ tươi được tính lại ngay lúc đọc)
   │  đủ nhu cầu chưa? ──► LOCAL_HIT           0 request ra ngoài
   ▼ chưa
NHÁNH MIỄN PHÍ (có bộ chọn nguồn riêng, trần 2 nguồn, ngân sách riêng, cooldown riêng)
   │  đủ nhu cầu chưa? ──► FREE_UPDATED        0 request trả phí
   ▼ chưa
cổng trả phí: được phép? → nguồn có năng lực? → hết cooldown? → còn thời gian?
   │  bất kỳ cổng nào đóng ──► PARTIAL / NOT_FOUND, kèm `paidSkipReason`
   ▼ mở hết
NHÁNH TRẢ PHÍ (1 credit, có 9 cổng kiểm tra riêng + chống gọi trùng riêng)
   │
   ▼
đọc lại dữ liệu chuẩn  ← dữ liệu trả phí phải đi qua Observation + Resolver trước
   │
   ▼
PAID_UPDATED | PARTIAL | NOT_FOUND
```

**Không có vòng lặp miễn phí → trả phí → miễn phí.** Sau khi nhánh trả phí thất bại, luồng trả về đúng những gì đang có. Cho các nhánh thử lại vòng quanh là cách chắc chắn nhất để vừa treo request vừa phình hoá đơn.

### Trường `need`

Chỉ hai giá trị, vì câu hỏi "thế này đã đủ chưa?" có hai câu trả lời khác nhau:

| `need` | Được coi là đủ khi |
|---|---|
| `POSITION` | nhóm POSITION ở trạng thái `AVAILABLE` (độ tươi tính lại lúc đọc) |
| `DETAIL` | không nhóm nào ở trạng thái `MISSING` hay `STALE` (`needsRefresh === false`) |

Một con tàu có vị trí mới nhưng chưa có thông số kỹ thuật thì là `LOCAL_HIT` với `POSITION`, nhưng chưa đủ với `DETAIL`. Gộp hai thứ này lại thì hoặc là đi crawl chỉ để vẽ một cái chấm trên bản đồ, hoặc là trả về trang chi tiết mới có một nửa.

---

## 4. Bốn cổng chặn của nhánh trả phí

Kiểm tra theo thứ tự rẻ trước, đắt sau — không bao giờ hỏi "còn bao nhiêu thời gian?" trước khi hỏi "có được phép không?".

| Thứ tự | Cổng | `paidSkipReason` | Luật |
|---|---|---|---|
| 1 | cờ của bên gọi | `NOT_ALLOWED` | `allowPaidFallback !== true`. Để `undefined` cũng là từ chối. |
| 2 | năng lực của nguồn | `NO_PAID_CAPABILITY` | các nhóm còn thiếu giao với `{POSITION, IDENTITY}` bằng rỗng |
| 3 | cooldown theo từng tàu | `COOLDOWN` | `DetailRefreshGate` với khoá `paid:<mmsi>/<imo>` |
| 4 | ngân sách thời gian tổng | `BUDGET_EXHAUSTED` | thời gian còn lại nhỏ hơn `minPaidSliceMs` (2 giây) |

Ngoài ra còn `NEED_SATISFIED` khi local hoặc miễn phí đã trả lời được rồi, và `LANE_UNAVAILABLE` khi bản triển khai này chưa nối nhánh trả phí nào — chính là tình trạng hiện tại.

`LANE_UNAVAILABLE` được tách riêng khỏi `NOT_ALLOWED` có chủ đích: một cái nghĩa là "có đường nhưng cấu hình nói không", cái kia nghĩa là "không có đường". Gộp lại thì một adapter bị quên nối trông y hệt một quyết định vận hành.

### Cổng 2 nói rõ hơn — rào cản chi phí quan trọng nhất

MyShipTracking với `response=simple` trả về đúng mười trường: `vessel_name`, `mmsi`, `imo`, `vtype`, `lat`, `lng`, `course`, `speed`, `nav_status`, `received`.

Chừng đó phủ được **POSITION** và phần cơ bản của **IDENTITY**. Nó không có `length`/`beam`/`draught`/`gt`/`dwt`/`built` (nhóm PARTICULARS), cũng không có `destination`/`eta` hay các trường cảng (nhóm VOYAGE). Những thứ đó chỉ có ở mức `extended` (3 credit), và TRACK-1 cố ý không gọi mức đó.

Vậy nên: **thiếu PARTICULARS mà mọi nguồn miễn phí đều hỏng thì trả về dữ liệu một phần.** Gọi một endpoint vị trí rồi báo "đã làm mới thông số kỹ thuật" vừa là tiêu credit vô ích, vừa là nói dối về dữ liệu. Điều này được chốt bằng `PAID_CAPABLE_GROUPS = [POSITION, IDENTITY]` và bằng một test sẽ đỏ nếu ai đó thêm nhóm vào danh sách này.

### Cổng 4 — một ngân sách cho cả luồng

`FREE_FALLBACK_TOTAL_TIMEOUT_MS` (15 giây) tính cho cả local + miễn phí + trả phí cộng lại, không phải cho từng chặng.

Nếu đặt timeout theo từng chặng (10 giây miễn phí + 10 giây trả phí + ...) thì một cú bấm của người dùng biến thành 30 giây chờ. Nhánh miễn phí vốn đã có trần 10 giây của riêng nó; phần còn lại vừa đủ chỗ cho đúng một request trả phí.

Khởi động một request trả phí mà biết chắc sẽ bị cắt giữa chừng là kết cục tệ nhất có thể: mất tiền mà không ai nhận được kết quả.

---

## 5. Hợp đồng kết quả trả về

```ts
{
  status: LOCAL_HIT | FREE_UPDATED | PAID_UPDATED | PARTIAL | NOT_FOUND | UNAVAILABLE,
  sourceUsed: LOCAL | FREE | PAID | NONE,
  need, detail,
  externalAttempted: boolean,   // có gì đi ra khỏi tiến trình không?
  dataUpdated: boolean,         // có thực sự thu thêm được dữ liệu không?
  fallbackUsed: boolean,        // có chạm tới nhánh trả phí không?
  freeAttempts: [{ source, status, durationMs }],
  paidAttempt?: { status, creditCharged? },
  paidSkipReason?: ...,         // vắng mặt khi nhánh trả phí đã chạy
  remainingMissingGroups, remainingStaleGroups, durationMs
}
```

Ba giá trị boolean được tách riêng **có chủ đích**. Trước đây một cờ `refreshed` duy nhất gộp cả ba, nên `refreshed: true` có thể có nghĩa là "đã tiêu một credit và không thu được gì" mà không ai nhận ra.

Tổ hợp đáng chú ý nhất là `externalAttempted: true, dataUpdated: false, fallbackUsed: true` — mất tiền, không được dữ liệu — và giờ nó đã có tên gọi rõ ràng.

`creditCharged` lấy từ header `x-credit-charged` khi nguồn có gửi. Vắng mặt nghĩa là nguồn không nói, **không bao giờ** có nghĩa là bằng 0.

`detail` luôn là bản chiếu **đọc lại từ kho chuẩn**, không bao giờ là phản hồi thô của nguồn. Một vị trí trả phí về mà lại cũ hơn khung AIS gần nhất thì vẫn thua AIS ở bước resolver: trả tiền không mua được quyền ghi đè lên dữ liệu mới hơn.

Những thứ **không bao giờ** xuất hiện trong kết quả: HTML thô, chuỗi lỗi của nguồn, stack trace, khoá API. Có test chốt điều này.

---

## 6. Cấu hình

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PAID_FALLBACK_ENABLED` | `false` | công tắc tổng phía server; chỉ đúng chuỗi `"true"` mới bật |
| `FREE_FALLBACK_TOTAL_TIMEOUT_MS` | `15000` | ngân sách thời gian cho cả luồng |
| `PAID_FALLBACK_COOLDOWN_MS` | `600000` | thời gian nghỉ sau một lần gọi trả phí cho cùng một tàu |
| `INTERNAL_ACQUIRE_TOKEN` | *(rỗng)* | mã bí mật của kênh lệnh nội bộ; để rỗng thì kênh từ chối tất cả |
| `MYSHIPTRACKING_API_KEY` | *(rỗng)* | khoá trả phí; chỉ nằm phía server, không bao giờ trả ra, không bao giờ ghi log |

Cách đọc cấu hình là `=== "true"`, **không phải** `!== "false"`. Mọi kiểu gõ sai — `"1"`, `"yes"`, `"TRUE!"`, để trống — đều phải rơi về TẮT. Bật nhầm do gõ sai thì đó là hoá đơn, không phải bug.

Muốn một request trả phí chạy được thì **cả hai** công tắc phải bật: `PAID_FALLBACK_ENABLED` phía server **và** `allowPaidFallback` từ bên gọi. Một dòng cấu hình sai bên Marine không được phép biến thành hoá đơn của Bot.

---

## 7. Kênh lệnh nội bộ

```
POST /internal/vessels/:id/acquire
X-Internal-Token: <INTERNAL_ACQUIRE_TOKEN>
{ "need": "POSITION" | "DETAIL", "allowPaidFallback": false }
```

| Tính chất | Hành vi |
|---|---|
| Điều kiện gắn route | chỉ gắn khi có đủ phụ thuộc `internalAcquire`; không thì trả 404 |
| Xác thực | qua `X-Internal-Token`, so sánh theo thời gian hằng số. **Không dùng** `API_KEY` — kênh này tiêu tiền nên phải thu hồi được độc lập. Token cấu hình rỗng thì từ chối mọi thứ. |
| Nơi lắng nghe | loopback (`HTTP_HOST=127.0.0.1`) hoặc mạng nội bộ. Không bao giờ mở ra ngoài. |
| Định danh tàu | kiểm tra ngay ở biên bằng validator của domain; giá trị rác bị trả 400 trước khi bất kỳ nhánh nào chạy |
| Body | chỉ nhận `need` và `allowPaidFallback`. Gửi kèm `source`/`sources`/`provider`/`useMyShipTracking` thì trả 400 |
| `allowPaidFallback` | phải là kiểu boolean; gửi chuỗi `"true"` sẽ bị 400, không được hiểu là đồng ý |
| Giới hạn tần suất | 3 lần/phút cho mỗi định danh, 120 lần/phút cho cả route, theo cửa sổ cố định, bảng khoá có giới hạn |
| Timeout | dùng chính ngân sách tổng của use case; route không thêm timeout thứ hai |
| Phản hồi | theo hợp đồng kết quả ở trên, cộng thêm `paidRequestedButDisabled` |

**Marine không bao giờ được chỉ định nguồn.** Nếu được phép, danh sách nguồn của Bot trở thành API công khai, và việc đổi một crawler sẽ thành thay đổi phá vỡ tương thích với mobile.

**Bot không bao giờ quyết định người dùng đã trả tiền hay chưa.** Xác thực, gói cước và thanh toán là việc của Marine. Bot chỉ trả lời đúng một câu: "lệnh gọi này có được phép tiêu một credit không?".

---

## 8. Đo chi phí

`npm run fallback:cost` chạy đúng bộ điều phối thật với hai nhánh được thay bằng bản giả có đếm, rồi in ra số lần gọi trả phí thực sự xảy ra.

Nó đo **hành vi của code**. Còn tỉ lệ trượt ở local và tỉ lệ hỏng của nguồn miễn phí là **đầu vào do ta đưa**, không phải kết quả đo được.

Đo ngày 2026-08-17, 100 tàu khác nhau, seed 20260817, đồng hồ mô phỏng tiến 1 giây mỗi request:

| Kịch bản | 100 req | 1.000 req | 10.000 req | credit/req |
|---|---|---|---|---|
| POSITION, 20% trượt local, 10% miễn phí hỏng, **trả phí TẮT** | 0 | 0 | 0 | 0 |
| POSITION, 20% trượt local, 10% miễn phí hỏng, trả phí BẬT | 3 | 25 | 197 | ~0,020 |
| POSITION, 20% trượt local, **nhánh miễn phí chết hẳn**, trả phí BẬT | 26 | 186 | 1.764 | ~0,176 |
| DETAIL, chỉ thiếu PARTICULARS, miễn phí chết, trả phí BẬT | 0 | 0 | 0 | 0 |

Đọc bảng này thế nào:

- Dòng 1 chính là production hiện nay. Công tắc tắt nên hoá đơn bằng 0 bất kể lưu lượng. Đây là dòng duy nhất đúng mà không cần đo thêm gì.
- Dòng 3 là trường hợp xấu nhất còn thực tế: kể cả khi mọi nguồn miễn phí chết, cooldown theo từng tàu vẫn giữ số lần gọi trả phí tăng chậm hơn tuyến tính — ở mốc 10.000 request, có 968 trong số 2.732 request đã cạn nguồn miễn phí bị cooldown chặn lại.
- Dòng 4 là cổng 2 đang làm đúng việc: 9.660 request, 0 credit, vì một endpoint vị trí không hề có thông số kỹ thuật.

**Thứ chưa đo được: tỉ lệ trượt thật của nhánh miễn phí.** Muốn có con số đó thì phải chạy nhánh miễn phí với nguồn thật rồi đọc `freeExhausted / requests` từ `GetVesselWithFallback.getStats()`. Chừng nào chưa có con số đó thì **không được** đặt `PAID_FALLBACK_ENABLED=true` trên production.

---

## 9. Cái gì đã nối dây, cái gì chưa

[createVesselAcquisitionDependencies.ts](../src/bootstrap/createVesselAcquisitionDependencies.ts) dựng `GetCanonicalVesselDetail`, `GetOrRefreshVesselDetail` và `GetVesselWithFallback`, rồi đưa ra ngoài qua `buildContainer()`. Việc dựng này hoàn toàn im lặng: không crawl, không request, không tốn credit.

`server.ts` **chỉ** gắn kênh nội bộ khi `INTERNAL_ACQUIRE_TOKEN` khác rỗng. Token rỗng thì route đó không tồn tại.

**Nhánh trả phí chưa được dựng**, vì `TrackVesselCurrentPosition` cần hai thứ mà kho mã này chưa có:

1. một adapter hiện thực `PaidPositionSource` dựa trên `MyShipTrackingClient`;
2. một sổ credit cho `PaidBudgetSnapshot`. Cổng kiểm tra coi `remainingCalls: null` là từ chối, nên một sổ giả tạm sẽ hoặc là nói dối về số dư, hoặc là từ chối tất cả trong khi vẫn giả vờ rằng nhánh này tồn tại.

Chừng nào chưa có cả hai, bộ điều phối trả về `paidSkipReason: LANE_UNAVAILABLE` và phục vụ bằng LOCAL + MIỄN PHÍ. Đó là trạng thái trung thực, và cũng là trạng thái an toàn.

Về các cổng cooldown: nhánh miễn phí và cooldown trả phí dùng **hai instance `DetailRefreshGate` riêng biệt**, và bộ điều phối còn thêm tiền tố `paid:` vào khoá của nó. Cooldown của crawl miễn phí không bao giờ được phép làm im một lệnh gọi trả phí, và ngược lại.

Cổng trả phí dùng **cùng một** thời gian cooldown cho cả lần thất bại lẫn lần thành công — thử lại ngay sau một lần bị tính tiền hỏng chính là cách một bản ghi tàu lỗi biến thành chuỗi lần tính tiền lặp lại.

---

## 10. Kế hoạch triển khai từng bước

1. Giữ `PAID_FALLBACK_ENABLED=false` và `INTERNAL_ACQUIRE_TOKEN` rỗng.
2. Chỉ đặt `INTERNAL_ACQUIRE_TOKEN` trên môi trường staging; đo `freeExhausted / requests` từ `getStats()` trên một mẫu lưu lượng thật.
3. Chạy lại `npm run fallback:cost` với tỉ lệ vừa đo được; từ bảng kết quả mà chốt trần credit mỗi tháng.
4. Bật `USE_BOT_VESSEL_ACQUISITION` bên Marine cho một nhóm nhỏ người dùng — xem [BOT_ACQUISITION_FALLBACK.md](../../soosky-marine-api-clone/docs/BOT_ACQUISITION_FALLBACK.md).
5. Xây adapter trả phí và sổ credit (mục 9), rồi mới cân nhắc `PAID_FALLBACK_ENABLED=true`, và vẫn phải xin phép theo từng request.

Cố ý chưa làm: không chuyển đổi trên production, không scheduler, không dùng các endpoint hàng loạt hay lịch sử của MyShipTracking, không gỡ adapter MyShipTracking sẵn có của Marine.

---

## 11. Tài liệu liên quan

- [BOT_MARINE_INTEGRATION.md](BOT_MARINE_INTEGRATION.md) — bảng đối chiếu hợp đồng tới từng trường dữ liệu
- [GetVesselWithFallback.test.ts](../src/application/use-cases/vessel/GetVesselWithFallback.test.ts) — 23 test, gồm cả các cổng chặn chi phí
- [internalAcquireRoute.test.ts](../src/interfaces/http/internalAcquireRoute.test.ts) — 14 test cho phần ranh giới
- [fallbackCostSim.ts](../src/interfaces/cli/fallbackCostSim.ts) — lệnh `npm run fallback:cost`
