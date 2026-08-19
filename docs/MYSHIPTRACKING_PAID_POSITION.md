# Nhánh lấy vị trí trả phí qua MyShipTracking

## Bối cảnh

TRACK-1 thêm đúng một thao tác: người dùng bấm rõ ràng để làm mới vị trí của **một** tàu, và thao tác đó được phép tốn tiền. Nhánh này tách hẳn khỏi việc đọc bản đồ, làm mới chi tiết miễn phí, xử lý khi DB không có dữ liệu, xử lý khi crawler lỗi, và khỏi mọi lịch chạy tự động.

## Vấn đề

API trả phí tuyệt đối không được biến thành "phương án dự phòng miễn phí" một cách vô tình, và cũng không được tiêu nhiều credit cho một hành động duy nhất của người dùng.

## Điều rút ra

Tài liệu chính thức Vessel Status đã được rà ngày 2026-08-17:

- Endpoint: `GET https://api.myshiptracking.com/api/v2/vessel`
- Xác thực: `Authorization: Bearer <key>` (hoặc `x-api-key`)
- Nhận **đúng một** tham số `mmsi` hoặc `imo`
- Hai mức: `simple` (1 credit) và `extended` (3 credit)
- Nếu không tìm thấy kết quả thì **không bị tính tiền**
- Header `X-Credit-Charged`, khi có, là số credit thực sự bị trừ

Nhánh này luôn gửi `response=simple`: TRACK-1 chỉ cần vị trí hiện tại, còn việc làm giàu thông tin vẫn thuộc về luồng thu thập miễn phí.

Hai chi tiết nhỏ nhưng dễ gây lỗi: ví dụ trong tài liệu có `lat: 0, lng: 0`, nên toạ độ bằng 0 vẫn phải được coi là hợp lệ theo bộ kiểm tra toạ độ hiện tại. Tài liệu cũng trả `nav_status` dạng số dù bảng mô tả ghi là chữ, nên mapper chấp nhận cả hai: mã AIS 0..15 hoặc chuỗi không rỗng.

## Quyết định

- `TrackVesselCurrentPosition` là **cửa vào duy nhất** của nhánh trả phí. Nó đi qua `PaidFallbackGate` với lý do `EXPLICIT_TRACKING`, nhận một MMSI/IMO (nếu đưa cả hai thì MMSI thắng), có hạn mức biết trước rõ ràng, và một bảng chống gọi trùng theo từng tàu trong phạm vi tiến trình.
- `MyShipTrackingClient` gửi **đúng một** request `GET /api/v2/vessel?response=simple`, có timeout, và **không tự thử lại**. Thà chịu mập mờ về việc đã bị tính tiền hay chưa sau lỗi mạng/5xx, còn hơn rủi ro bị tính tiền lần thứ hai.
- Lỗi HTTP/API được phân loại rõ: 404 `NOT_FOUND`, 402 `NO_CREDITS`, 429 `RATE_LIMITED`, 401/403 `UNAUTHORIZED`, 400 `BAD_REQUEST`, 5xx `SERVER_ERROR`. Chỉ khi thành công mới tạo bản quan sát.
- Kết quả thành công đi theo đường: `ProviderDetailsResult` → `VesselObservation` → resolver và kho chuẩn sẵn có. Nó **không bao giờ** ghi thẳng vào trạng thái chuẩn, và cũng không có đặc quyền ưu tiên vì là nguồn trả phí.
- Bản quan sát vị trí trả phí được giữ 7 ngày, khớp với cửa sổ ứng viên của resolver. Chúng hiếm và tốn tiền, nhưng không vì thế mà giữ vĩnh viễn.

## Việc cần làm tiếp

- TRACK-2 sẽ thiết kế phần phân quyền, lịch chạy, tính tiền theo sản phẩm, và route API production. Không phần nào trong số đó thuộc TRACK-1.
- Mọi bài chạy thử thủ công đều phải bắt xác nhận trả phí rõ ràng và **không bao giờ in khoá API ra màn hình**.

## Ghi chú liên quan

[[ACQUISITION_POLICY]] [[RESOLVER_POLICY]] [[OBSERVATION_STORAGE]]
