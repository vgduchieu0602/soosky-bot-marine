# Hợp đồng dữ liệu tàu chuẩn — phiên bản V1

`VesselBasics` và `VesselDetails` là hai khuôn dữ liệu (DTO) nằm ở ranh giới công khai giữa hai hệ thống. Chúng được chép **nguyên văn** ở cả Soosky-bot-marine lẫn Soosky-marine-api. Đây là chủ ý, không phải thiếu sót: không tách thành package dùng chung, cũng không phải model lưu trữ hay model domain.

Bản chụp để máy tự kiểm tra là `vessel-contract-v1.json`. Trước khi đẩy thay đổi từ phía Bot, chạy:

```bash
OTHER_MARINE_REPO=<đường-dẫn> npm run contract:parity
```

Mọi thay đổi phá vỡ tương thích đều bắt buộc tăng version rõ ràng và phải được phía Marine duyệt.

## Luật bắt buộc

- Chuỗi thiếu dữ liệu ở ranh giới ghi là `---`; số thiếu dữ liệu ghi là `null`.
- `received` là mốc thời gian ISO-8601 lấy từ đúng bản chụp vị trí đã chọn, hoặc `---`. Các trường vị trí phải cùng đến từ **một** bản chụp đó, không được ghép từ nhiều bản.
- Hành trình gồm ba mốc: `current`, `last`, `next`. Mọi khoá cảng đều dùng `portUnlocode`.
- Việc ánh xạ dữ liệu chỉ diễn ra ở ranh giới tầng application — tuyệt đối không nhét vào schema Mongo hay entity domain.

## Ai sở hữu cái gì

Bot sở hữu: việc crawl, khoá API của nhà cung cấp trả phí, kho dữ liệu chuẩn, và mọi thao tác ghi.

Phần dữ liệu chuẩn mà Marine được phép đọc: MMSI/IMO, danh tính tàu (tên/loại/IMO), vị trí (lat/lon/hướng/tốc độ/trạng thái hành hải), mốc thời gian của bản quan sát đã chọn, và các trường hành trình/vị trí khi có.

Bot đổi schema nội bộ **không** tính là đổi hợp đồng công khai, chừng nào file mapper này chưa đổi.
