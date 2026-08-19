# Ranh giới trách nhiệm Bot / Marine

Tài liệu này trả lời một câu hỏi duy nhất: việc nào của Bot, việc nào của Marine.

## Bot — bên thu thập và ghi dữ liệu

Bot chịu trách nhiệm: chạy crawler, quyết định dùng nguồn nào, tích hợp nhà cung cấp trả phí, ghi dữ liệu tàu và bản quan sát vào kho chuẩn, và giữ route nội bộ (được bảo vệ bằng token) để nhận lệnh thu thập.

Marine chỉ được yêu cầu **loại năng lực** cần lấy — `POSITION` hoặc `DETAIL` — chứ không được chỉ định lấy từ nguồn nào.

## Marine — bên đọc, phục vụ công khai và realtime

Marine chịu trách nhiệm: API công khai, tương thích với mobile, đọc từ Mongo và AIS, quyết định gói cước/quyền dùng, và giữ kết nối AISStream trên production.

Các endpoint bản đồ chỉ đọc từ Mongo cộng với trạng thái AIS của Marine. Chúng **không bao giờ** gọi sang Bot hay gọi nhà cung cấp trả phí ngay trong lúc xử lý request.

## Đường đi của nhánh trả phí

Thiết kế chuẩn: `Marine -> Bot -> nguồn local/miễn phí -> trả phí (chỉ khi được cho phép rõ ràng)`.

Hiện tại Bot **cố ý chưa nối** adapter trả phí, vì sổ ghi credit và adapter production chưa được kiểm chứng. Do đó **không được coi `PAID_UPDATED` là sẵn sàng cho production ở thời điểm này.**

## Chống trùng lệnh (idempotency)

Route nội bộ của Bot nhận thêm `acquisitionRequestId` (tuỳ chọn) và giữ một sổ tạm trong bộ nhớ, có giới hạn dung lượng và tự hết hạn theo TTL. ID lặp lại sẽ dùng lại kết quả của lệnh gốc — kể cả khi kết quả đó là một lỗi không rõ ràng — nên việc gọi lại không thể tạo ra hai lần tính phí.

Lưu ý quan trọng: sổ này chỉ nằm trong một tiến trình. Nếu production chạy nhiều instance thì phải có kho idempotency dùng chung **trước khi** bật nhánh trả phí.

## Sơ đồ

```
NGUỒN MIỄN PHÍ
    |
    v
BOT (thu thập / ghi)
    |
    v
MONGO CHUẨN ----> MARINE (đọc / công khai / realtime) ----> MOBILE
                     ^
                     |
                  AISSTREAM (chỉ Marine giữ)

TRẢ PHÍ ĐƯỜNG THƯỜNG:  MARINE -> BOT -> MYSHIPTRACKING
TRẢ PHÍ KHẨN CẤP:      MARINE -> MYSHIPTRACKING   (chỉ khi BOT_UNAVAILABLE + có cho phép trả phí rõ ràng)
```
