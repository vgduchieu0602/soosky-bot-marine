# Ai sở hữu dữ liệu crawl

## Bối cảnh

Bot crawl làm chuỗi việc này: tìm ra tàu, thu dữ liệu từ các nguồn miễn phí, chuẩn hoá thành bản quan sát, giải ra trạng thái chuẩn, rồi lưu trạng thái đó vào `canonical_current_vessels`.

## Vấn đề

Nếu để hai hệ thống cùng mở kết nối AISStream riêng thì vừa tốn tiền gấp đôi, vừa sinh ra hai bên tranh nhau làm chủ dữ liệu realtime — không biết tin bên nào.

## Điều rút ra

`CrawlMapVessel` chỉ là một bản chiếu để đọc, phục vụ riêng cho crawl: giá trị nào chưa biết thì để `null`, không bịa. Các giá trị đặt tạm cho mobile khỏi vỡ giao diện **không phải** dữ liệu chuẩn.

Độ tươi của vị trí trên bản đồ là chuyện vận hành riêng, tách khỏi độ tươi của thông tin chi tiết hay hành trình.

## Quyết định

Soosky-marine-api là bên **duy nhất** giữ kết nối AISStream trên production.

Client AIS sẵn có của Bot vẫn giữ lại để dùng cho test/staging khi cần bật rõ ràng, nhưng mặc định `BOT_AIS_ENABLED=false` để runtime của nó không tự mở kết nối nào.

Production đọc trạng thái crawl chuẩn rồi trộn với ảnh chụp AIS trong bộ nhớ của chính nó.

## Việc cần theo dõi

Phải xem lại nhịp quét và nhịp watchlist. Lịch crawl 6 tiếng/lần hiện tại chậm hơn nhiều so với mốc "bản đồ tươi trong 30 phút" đặt ra ban đầu. Trước khi tin vào việc chỉ dùng crawl để phủ bản đồ diện rộng thì phải đo độ tươi thực tế trước.

## Ghi chú liên quan

[[AIS_CANONICAL_INGESTION]] · [[CRAWL_AIS_MAP_WRAPPER]]
