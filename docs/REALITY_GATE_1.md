# REALITY GATE 1 — Bot

Đây là biên bản nghiệm thu thực tế: chạy thật, không mô phỏng, để chứng minh Bot hoạt động đúng trên môi trường sạch.

**Commit đã kiểm:** `822d147fc013b8f388b96fd2906b5a7acdc8f5a9`
**Ngày:** 2026-08-17
**Node:** v22.22.2 · **npm:** 10.9.7

## Kết quả từng hạng mục

| Hạng mục | Kết quả | Bằng chứng |
|---|---|---|
| Cài sạch `npm ci` | **ĐẠT** | exit 0, 124 package |
| `npm test` | **ĐẠT** | 1050/1050 test qua, exit 0 |
| `npm run build` | **ĐẠT** | `tsc` exit 0 |
| Đối chiếu hợp đồng với Marine | **ĐẠT** | `VESSEL CONTRACT V1: MATCH` |
| Không dùng sai `NO_DATA` | **ĐẠT** | `"---"` chỉ xuất hiện trong contract/mapper/test; `NO_DATA` của resolver là enum trạng thái, không phải giá trị lưu vào DB |
| Kết nối Mongo | **ĐẠT** | local `mongodb://127.0.0.1:27017/soosky_marine_reality_gate` |
| Index 2dsphere | **ĐẠT** | `location_2dsphere` được tạo qua `CurrentVesselModel.createIndexes()` |
| Pipeline Bot ghi được dữ liệu | **ĐẠT** | `scripts/reality-gate-seed.ts` chạy qua `IngestAisBatch`: lưu 26 tàu, 52 bản quan sát, giải 26 tàu |
| Kiểm tra một bản ghi chuẩn mẫu | **ĐẠT** | có đủ mmsi/imo/identity/position.position.lat và lng/observedAt/location (JSON xem ở báo cáo phía Marine) |
| `explain` truy vấn 2dsphere | **ĐẠT** | kế hoạch thắng là `IXSCAN` trên `location_2dsphere`; nReturned=5 keysExamined=5 docsExamined=5 |
| Khởi động Bot khi tắt AIS | **ĐẠT** | `BOT_AIS_ENABLED=false`; tiến trình phục vụ `/health` ở cổng 3200 mà không cần cấu hình AISStream |
| Gọi nội bộ lấy dữ liệu miễn phí | **ĐẠT** | HTTP 200 trả `PARTIAL`/`LOCAL_HIT`, `fallbackUsed=false`, có echo lại `acquisitionRequestId` |
| Chống trùng lệnh khi gọi song song | **ĐẠT** | cùng `acquisitionRequestId` thì cả hai đều 200 `LOCAL_HIT` (chỉ một luồng xử lý thật) |
| Gọi với nhiều ID khác nhau | **ĐẠT*** | khi hết hạn mức thì trả HTTP 429 (giới hạn theo từng tàu bảo vệ chi phí gọi ra ngoài) |
| Gọi thật MyShipTracking trả phí | **KHÔNG CHẠY** | cố ý mock/tắt; không có credit |

\* Sau khi vượt ngưỡng 3 lần/phút cho mỗi tàu thì bị chặn đúng như thiết kế — an toàn về chi phí.

## Kết luận về trách nhiệm của Bot

Bot là bên sở hữu việc thu thập và ghi dữ liệu. Kênh lệnh nội bộ được bảo vệ bằng token. Nhánh trả phí đang tắt.
