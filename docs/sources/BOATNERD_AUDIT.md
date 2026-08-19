# Rà soát nguồn BoatNerd — `https://ais.boatnerd.com/`

**Ngày rà soát:** 2026-08-18 · **Giai đoạn:** 4 (chứng minh VesselBasics trên toàn bộ nguồn bản đồ)
**Kết luận:** `NOT_USABLE` — mọi endpoint về tàu đều đòi khoá API
**Đã viết provider chưa:** chưa (mục 11 cấm hiện thực một nguồn không dùng được)

---

## 1. Trang này là gì

`ais.boatnerd.com` là một ứng dụng một trang chạy bằng JavaScript (build bằng Vite, dùng React + MapLibre GL). Tài liệu gốc chỉ nặng 1001 byte và **không chứa một chút dữ liệu tàu nào**:

```html
<title>BoatNerd Map</title>
<script type="module" crossorigin src="/assets/index.382b0c02.js"></script>
<div id="root"></div>
```

Toàn bộ dữ liệu do bundle tải về lúc chạy. Không có HTML dựng sẵn từ server để bóc tách, cũng không có khối JSON nhúng sẵn.

## 2. Đường lấy dữ liệu tìm được

Đọc trong bundle của ứng dụng (2.314.453 byte), API nằm cùng tên miền:

```js
API_BASE_URL = "/api/v1"
```

Các endpoint liên quan tới tàu mà bundle có nhắc tới:

```
${API_BASE_URL}/vessels
${API_BASE_URL}/vessels/search
${API_BASE_URL}/fleets
${API_BASE_URL}/fleets/with-vessels
${API_BASE_URL}/fleets/{id}/vessels
${API_BASE_URL}/fleets/vessels/mmsis
```

Các lớp bản đồ được nhắc tới: `vessels-source`, `vessels-icon-layer`, `vessels-label-layer`, `vessel-symbol-layer` — đúng kiểu của một nguồn cấp tàu theo khung nhìn hoặc theo ô bản đồ. Ảnh thời tiết lấy từ `/api/v1/tiles/{layer}/{z}/{x}/{y}.png`.

Bundle còn nạp thêm Firebase auth và Google reCAPTCHA (`https://www.google.com/recaptcha/enterprise.js`), và các lệnh gọi về fleet đều được bọc trong `getAuthHeaders()`.

## 3. Kết quả thử thật

Ba request không đăng nhập, dùng `GET` bình thường, User-Agent giống trình duyệt và `Referer: https://ais.boatnerd.com/`:

| endpoint | mã trạng thái | nội dung trả về |
|---|---:|---|
| `/api/v1/vessels` | **401** | `{"success":false,"message":"Invalid or missing API key"}` |
| `/api/v1/vessels/search?q=algoma` | **401** | như trên |
| `/api/v1/vessels?bbox=-92,41,-76,49` | **401** | như trên |

Độ trễ 270–735 ms, `content-type: application/json`. Nghĩa là endpoint có thật và phản hồi bình thường — nó chỉ từ chối người gọi không có khoá.

## 4. Vì sao dừng rà soát ở đây

Khoá API mà trang web công khai dùng thực ra nằm ngay trong bundle JavaScript. Bóc nó ra rồi dùng lại nghĩa là **dùng thông tin xác thực để chạm vào một endpoint riêng tư có bảo vệ** — điều mà mục 4 của giai đoạn 4 cấm hẳn, cùng với việc dùng trình duyệt nguỵ trang, phá captcha, và dịch ngược chữ ký request.

Không có bất kỳ hành động nào nhằm bóc, suy ra hay dùng lại khoá.

## 5. Phân loại

| câu hỏi | trả lời |
|---|---|
| Quét được theo vùng/khung nhìn không? | endpoint có tồn tại nhưng **bị khoá API chặn** |
| Tra cứu theo MMSI được không? | `/vessels/search` có tồn tại nhưng **bị khoá API chặn** |
| Lấy được trường nào của VesselBasics? | **không trường nào**, nếu không có khoá |
| Độ tươi vị trí | không đo được |
| Chi phí mỗi request | không đo được |
| Có cần xác thực không? | **có — khoá API** |
| Hiện tại dùng được trong vận hành không? | **không** |

**Trạng thái nguồn (mục 5): `NOT_USABLE`**

## 6. Ghi chú về phạm vi địa lý (mục 9)

BoatNerd là dự án cộng đồng cho vùng Ngũ Đại Hồ và đường thuỷ St. Lawrence. Tài liệu công khai và khung bản đồ của họ đều mang tính vùng miền.

Tuy nhiên **không đo được độ phủ địa lý** vì không lấy được dữ liệu tàu nào. Vậy nên ở đây không khẳng định gì cả — không khẳng định phủ toàn cầu, cũng không khẳng định phủ theo vùng. Theo mục 9, chỉ đọc tài liệu thì không được coi là bằng chứng.

## 7. Nếu sau này vẫn muốn dùng nguồn này

Cách làm đúng đắn là xin quyền truy cập API từ BoatNerd rồi cấu hình khoá như một biến do người vận hành cung cấp — đúng theo cách đã làm với `MYSHIPTRACKING_API_KEY`. Đó là quyết định về kinh doanh và bản quyền, không phải chuyện kỹ thuật crawl.

Cho tới lúc đó, nguồn này đóng góp **con số không** vào độ bền của VesselBasics.
