# Runtime production

## Bối cảnh

RUNTIME-1 chạy **một** tiến trình Node.js trên **một** VPS. Tiến trình đó lo: nạp AIS, chạy crawl theo watchlist sẵn có, và việc dọn dẹp định kỳ. Phần làm giàu dữ liệu (enrich) vẫn là tiến trình riêng, tuỳ chọn.

## Vấn đề

Những cái timer không ai chịu trách nhiệm — interval, hẹn giờ kết nối lại, hàng đợi không giới hạn — sẽ khiến công việc bị làm trùng, hoặc khiến PM2 không restart sạch được.

## Điều rút ra

Bot có đúng hai dạng tiến trình:

- `marine-bot`: chạy `npm run build` rồi `npm run start:bot`. Một tiến trình PM2 kiểu fork sở hữu Mongo, AIS (khi có cấu hình), crawl và dọn dẹp.
- `npm run enrich`: worker làm giàu dữ liệu chạy riêng, tuỳ chọn. Bot **không** tự khởi động nó.

### Vòng đời

`ProductionRuntime` là bên sở hữu vòng đời.

Thứ tự khởi động: kết nối Mongo → dựng các phụ thuộc → coordinator AIS → các scheduler định kỳ.

Thứ tự tắt đi ngược lại theo chiều "ngừng sinh việc mới": dừng scheduler → dừng AIS và việc kết nối lại, rút nốt các lô cuối (có giới hạn) → đóng Mongo.

`SIGTERM`, `SIGINT`, exception chưa bắt và promise reject chưa xử lý đều đi chung **một** đường tắt máy có bảo vệ. Toàn bộ quá trình tắt bị chặn thời gian bởi `RUNTIME_SHUTDOWN_TIMEOUT_MS` (mặc định 15 giây).

### Kết nối lại AIS

Bắt đầu chờ 1 giây, mỗi lần thất bại thì gấp đôi, tối đa 30 giây. Ở bootstrap production có cộng thêm 20% nhiễu ngẫu nhiên (jitter) để tránh nhiều tiến trình cùng gõ cửa một lúc. Kết nối thành công thì reset về đầu; khi dừng thì huỷ luôn lần hẹn đang chờ.

Không tự chế ping giao thức: WebSocket nội bộ của Marine không công bố cơ chế ping nào. Phần phát hiện kết nối "chết mà không báo" vẫn để tắt, trừ khi người vận hành đưa ra một ngưỡng timeout đã kiểm chứng.

## Quyết định

- **Gộp AIS theo MMSI.** `AisCoalescingBuffer` chỉ giữ vị trí mới nhất và danh tính mới nhất của từng tàu, không giữ khung dữ liệu thô. Nó bị chặn theo kiểu LRU bởi `AIS_MAX_BUFFERED_VESSELS` (mặc định 50.000); khi đầy thì đẩy ra con tàu lâu chưa đụng tới nhất và đếm số lần đẩy ra khi dữ liệu chưa kịp ghi. Tập chờ xử lý là một tập con của chính map có giới hạn đó.
- **Mỗi lần rút tối đa 500 tàu** (`AIS_FLUSH_BATCH_SIZE`); mỗi chu kỳ coordinator xử lý tối đa 20 lô, và tại một thời điểm chỉ có một lượt chạy. Khi Mongo chậm hoặc lỗi, hệ thống chỉ đẩy lại trạng thái mới nhất, chứ không tích một hàng đợi tin nhắn vô hạn. Lỗi hiện ra qua bộ đếm ghi dữ liệu và qua trạng thái sức khoẻ bị hạ cấp.
- `IngestAisBatch` gọi **một** `saveMany` cho mỗi lô đã gộp, rồi giải các tàu bị ảnh hưởng với mức song song cố định là 10. Ba nhịp — khung dữ liệu vào, ghi bản quan sát, và giải bản chuẩn — cố ý khác nhau.
- `IntervalScheduler` chạy an toàn khi gọi lặp, và **bỏ qua** nhịp bị chồng lấn thay vì xếp hàng chờ. Bộ đếm `skippedOverlaps` giúp nhìn ra tình trạng quá tải.
- PM2 bắt buộc dùng `instances: 1` và `exec_mode: fork`. Chạy cluster sẽ nhân đôi kết nối AIS và việc crawl trong khi không có cơ chế điều phối phân tán.

### Các cấu trúc sống lâu trong tiến trình

| Cấu trúc | Giới hạn / cách dọn |
| --- | --- |
| Mục AIS + MMSI đang chờ | tối đa 50.000 theo LRU; tập chờ là tập con; các lô rút dần cho hết |
| Lý do loại bỏ AIS / chống spam log | số khoá hữu hạn, sinh từ enum |
| Timer kết nối lại / phát hiện chết của AIS | mỗi loại một cái; bị xoá khi dừng |
| Cổng chặn làm mới chi tiết | vẫn giữ trần LRU 20.000 mục và TTL sẵn có |
| Map chống gọi trùng của chi tiết và của nhánh trả phí | mục bị xoá trong `finally`, kể cả khi lỗi |
| Timer của scheduler | một cái duy nhất, xoá bởi `stop()` |

### Sức khoẻ tiến trình

Đây là ảnh chụp trong tiến trình, **không phải** endpoint công khai:

```
{ status, mongo, ais: { enabled, connected, pending }, workers, memory }
```

Mongo đã kết nối nhưng AIS đang kết nối lại thì trạng thái là `DEGRADED`. Thiếu Mongo thì không bao giờ được coi là `READY`.

## Việc cần làm

Chạy bài đo tải trước khi chọn cấu hình VPS:

```bash
npm run runtime:load-poc -- --vessels=10000 --events=60000
# hoặc chạy kèm node --expose-gc
```

Bài đo này chạy tất định và chỉ dùng repository trong bộ nhớ. Nó báo cáo: số khung dữ liệu, số mục đã gộp, số bản quan sát, số lần giải bản chuẩn, số lần đọc/ghi repository, RSS/heap, và số tàu tối đa nằm trong bộ đệm. Nó **không** khẳng định gì về throughput của Mongo trên production.

### Số liệu nền chạy local (bộ nhớ)

Với 1.000 tàu, rút bộ đệm mỗi 1.000 khung, chạy 1.000/5.000/10.000 khung tổng hợp — tương ứng 10 giây ở nhịp 100/500/1000 tin/giây:

- Thời gian: 203ms / 1,57s / 4,69s
- Số bản quan sát ghi trên mỗi khung: 1,00 / 0,98 / 0,98
- Số lần gọi `saveMany`: 2 / 10 / 20
- Số lần đọc repository cho mỗi tàu đã giải: 4
- Tối đa chờ xử lý: 1.000, không có lần nào bị đẩy ra

Heap lúc kết thúc là 183,7 / 153,6 / 182,7 MiB, nhưng đo trong tiến trình test vốn đã nạp sẵn nhiều thứ — nên các con số này chỉ dùng để phát hiện hồi quy, **không phải** lời hứa về sức chứa của VPS.

Một bài ép riêng với 60.000 tàu khác nhau và trần 50.000: giữ đúng 50.000 mục, đẩy ra 10.000 mục cũ nhất còn dữ liệu chưa ghi, rồi rút sạch về 0. Phần bộ nhớ tăng thêm của bộ đệm khoảng 17,3 MiB (khoảng 362 byte cho mỗi tàu được giữ, trong lần chạy đó).

### Ước lượng khối lượng

Ở nhịp 100/500/1000 tin mỗi giây, lượng dữ liệu vào là 8,64 triệu / 43,2 triệu / 86,4 triệu khung mỗi ngày.

Nhưng nhịp ghi bản quan sát và ghi bản chuẩn **không** phụ thuộc vào nhịp đó — nó phụ thuộc vào số MMSI khác nhau trong mỗi cửa sổ gộp. Một con tàu với cửa sổ mặc định 60 giây thì tối đa có 1.440 bản quan sát vị trí mỗi ngày. Muốn hứa về sức chứa lưu trữ toàn cầu thì phải đo thật bằng mẫu tổng hợp cộng với index BSON trước đã.

### Khuyến nghị hạ tầng

Khởi đầu nên dùng 2 vCPU / 2GB RAM và Mongo đặt bên ngoài, cho một lần triển khai nhỏ.

VPS 1GB thì không khuyến nghị, trừ khi đã đo được mức RSS thấp ổn định **và** Mongo nằm ngoài. Mongo chạy chung VPS sẽ tranh RAM, CPU và IOPS đĩa; nạp AIS toàn cầu thì bắt buộc Mongo ngoài hoặc máy to hơn.

Ngưỡng restart 700M của PM2 là hàng rào an toàn thận trọng, không phải tuyên bố về sức chứa.

## Ghi chú liên quan

[[AIS_COALESCING_BUFFER]] [[AIS_BULK_PERSISTENCE]] [[CRAWL_RUNTIME]]
