# Rà soát nguồn MarineTraffic.live — `https://marinetraffic.live/`

**Ngày rà soát:** 2026-08-18 · **Giai đoạn:** 4 (chứng minh VesselBasics trên toàn bộ nguồn bản đồ)
**Kết luận:** `NOT_USABLE` — Cloudflare bắt vượt thử thách tương tác ngay ở trang gốc
**Đã viết provider chưa:** chưa (mục 11 cấm hiện thực một nguồn không dùng được)

---

## 1. Kết quả thử thật

Một `GET` bình thường với User-Agent giống trình duyệt và `Accept: text/html`:

```
status  : 403
server  : cloudflare
cf-ray  : a2d2313268be0540-HKG
bytes   : 5537
latency : 138 ms
```

Nội dung trả về là trang chặn của Cloudflare:

```html
<title>Just a moment...</title>
<meta http-equiv="content-security-policy"
      content="... script-src 'nonce-…' 'unsafe-eval' https://challenges.cloudflare.com; …
               frame-src 'self' https://challenges.cloudflare.com blob:; …">
```

Các dấu hiệu xuất hiện trong nội dung: `cloudflare`, `challenge`, `Just a moment`.

Máy chủ vẫn phản hồi nhanh và bình thường — đây là **rào chặn bot**, không phải sự cố dịch vụ, cũng không phải bị chặn ở tầng mạng.

## 2. Vì sao dừng rà soát ở đây

Muốn qua được trang này thì phải chạy thử thách của Cloudflare trong một môi trường trình duyệt thật, hoặc dùng lại cookie đã giải xong. Mục 4 của giai đoạn 4 cấm:

- dùng trình duyệt nguỵ trang
- phá captcha
- dịch ngược chữ ký request
- chạm vào endpoint riêng tư có bảo vệ

Giải hoặc né thử thách rơi đúng vào những điều cấm đó, nên không gửi thêm request nào nữa. Cụ thể là **không có nỗ lực nào** nhằm dò các endpoint bản đồ/XHR nằm sau thử thách, vì muốn tới được chúng thì trước hết phải làm điều bị cấm.

Theo mục 10: việc giao diện công khai của họ hiển thị dữ liệu tàu **không** được coi là bằng chứng rằng có một endpoint quét vùng không cần xác thực dùng lại được. Chưa chứng minh thì không khẳng định.

## 3. Phân loại

| câu hỏi | trả lời |
|---|---|
| Quét được theo vùng/khung nhìn không? | **không xác định được** — thử thách chặn ngay từ trang gốc |
| Tra cứu theo MMSI được không? | **không xác định được** |
| Lấy được trường nào của VesselBasics? | **không trường nào** |
| Độ tươi vị trí | không đo được |
| Chi phí mỗi request | không đo được |
| Có cần xác thực không? | chưa tới được bước đó; thử thách đứng trước cả câu hỏi xác thực |
| Hiện tại dùng được trong vận hành không? | **không** |

**Trạng thái nguồn (mục 5): `NOT_USABLE`**

Lưu ý đây là kiểu hỏng **khác** với VesselFinder. VesselFinder bị chặn ngay ở tầng TCP từ đường ra mạng này (tức là ở mức gói tin). Còn MarineTraffic.live vẫn trả lời tức thì ở tầng HTTP rồi mới đòi vượt thử thách tương tác.

## 4. Nếu sau này vẫn muốn dùng nguồn này

Các hướng còn nằm trong khuôn khổ cho phép:

1. Liên hệ đơn vị vận hành để xin quyền truy cập API có tài liệu, hoặc xin hạn mức crawl.
2. Kiểm tra xem họ có nguồn dữ liệu công bố hoặc bán bản quyền hay không.

Còn hướng tự động giải thử thách thì **không** phải lựa chọn hợp lệ, và không được khuyến nghị.
