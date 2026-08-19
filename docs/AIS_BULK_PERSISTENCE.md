# Lưu AIS theo lô

## Bối cảnh

Giai đoạn AIS-4 nối `AisCoalescingBuffer` (bộ đệm gộp theo từng MMSI, có giới hạn dung lượng) vào kho bản quan sát chuẩn và bước giải trạng thái tàu hiện tại. Phần này được nối dây trong `createCanonicalDependencies`, nhưng nằm im cho tới khi có runtime tạo ra coordinator AIS của Marine.

## Vấn đề

Hàm `saveMany()` cũ trên Mongo thực ra gọi `save()` từng cái một: mỗi bản quan sát tốn một truy vấn `exists()` rồi một `create()`. Với luồng AIS toàn cầu thì cách này không sống nổi, và cũng không cho ta thao tác theo lô có giới hạn.

## Điều rút ra

`MongoVesselObservationRepository.saveMany()` giờ làm theo thứ tự: tính hết fingerprint trước, giữ lại bản xuất hiện đầu tiên cho mỗi fingerprint theo đúng thứ tự đầu vào, rồi tìm các bản đã có bằng **một** truy vấn `$or` gom theo mốc cắt dedupe. Sau đó chỉ chạy **một** lệnh `insertMany()` có thứ tự cho những bản chưa có ở cả trong lô lẫn trong MongoDB.

Kết quả trả về vẫn khớp chính xác thứ tự đầu vào.

Hành vi của `save()` cũ được giữ nguyên có chủ đích. Bản lưu trong bộ nhớ cũng giữ đúng thứ tự và cách xử lý trùng lặp như vậy, để test và môi trường dev không lệch.

## Quyết định

`IngestAisBatch` chuyển các mục đã gộp qua `detailsResultToObservations()`, gọi `saveMany()` đúng một lần, rồi giải mỗi MMSI bị ảnh hưởng đúng một lần. Việc giải chạy qua một nhóm worker nhỏ giới hạn bởi `AIS_RESOLVE_CONCURRENCY` (mặc định `10`) thay vì `Promise.all` không giới hạn.

Coordinator của Marine chỉ cho phép **một** lần ghi xuống DB tại một thời điểm. Trong lúc ghi chậm, bộ đệm vẫn tiếp tục gộp trạng thái mới nhất; nó không tích thêm một hàng đợi thứ hai chứa các lô đã rút ra.

Lô ghi thất bại được đẩy ngược lại chính bộ đệm đó, nên một khung dữ liệu cũ bị thử lại không thể ghi đè lên khung mới hơn đã nhận trong lúc lỗi.

Mỗi lô ghi — thành công hay thất bại — chỉ sinh ra một dòng log tổng hợp cộng với bộ đếm của coordinator. Không bao giờ log từng tàu.

## Việc cần làm tiếp

- AIS-4 chưa làm phần xoá dữ liệu cũ. Luồng toàn cầu có thể làm `vessel_observations` phình rất nhanh; chính sách giữ dữ liệu và quyết định về TTL/index để dành cho giai đoạn sau.
- Việc đọc của resolver vẫn chạy theo từng tàu. Cần đo tải Mongo bằng một bài mô phỏng nạp có giới hạn trước khi tính đến chuyện gom resolver theo lô ở AIS-5.
- AIS-5 chỉ được thêm phần bản đồ/GeoJSON sau khi có thiết kế riêng và có số liệu tải thực tế.

## Ghi chú liên quan

- [[AIS_COALESCING_BUFFER]]
- [[AIS_CANONICAL_INGESTION]]
- [[RESOLVER_POLICY]]
