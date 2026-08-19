# Rà soát phạm vi Bot chạy độc lập (điều chỉnh phạm vi)

**Ngày:** 2026-08-18
**Kho mã:** chỉ Soosky-bot-marine
**Nguyên tắc:** Bot là một dịch vụ độc lập chuyên thu thập từ **nguồn miễn phí**. Không làm phần tích hợp với Marine API.

## Phân loại từng phần

| Đường dẫn / hạng mục | Vì sao tồn tại | Quyết định |
|---|---|---|
| `src/infrastructure/integrations/vesselfinder/**` | Crawl bản đồ/chi tiết miễn phí | **GIỮ** |
| `src/infrastructure/integrations/shipfinder/**` | Crawl chi tiết miễn phí | **GIỮ** |
| `src/infrastructure/integrations/shipinfo/**` | Crawl chi tiết miễn phí | **GIỮ** |
| Observation / Resolver / Mongo chuẩn | Lõi của pipeline thu thập | **GIỮ** |
| `src/interfaces/cli/botDataProof.ts` + các script `bot:*` | Chứng minh dữ liệu ở chế độ độc lập | **GIỮ** |
| `src/config/databaseSafety.ts` | Chốt chặn để proof chạy trên DB tách riêng | **GIỮ** |
| `src/application/contracts/VesselBasics.ts` v.v. | **Chỉ là định nghĩa mục tiêu độ phủ trường dữ liệu** — không phải HTTP của Marine | **GIỮ** (với vai trò mục tiêu độ phủ) |
| `src/infrastructure/integrations/marine-ais/**` | Client WebSocket tuỳ chọn, dùng để đọc cầu AIS của **Marine API** | **ĐÓNG BĂNG** — mặc định tắt (`BOT_AIS_ENABLED=false`, `MARINE_AIS_WS_URL` để rỗng). Lần này chưa xoá để tránh refactor lớn, nhưng **không được dùng** cho công việc hiện tại. |
| `src/interfaces/cli/marineAis*.ts` + script npm `marine-ais:*` | PoC/mô phỏng cho cầu AIS đó | **ĐÓNG BĂNG** — không chạy khi làm proof chuyển động miễn phí |
| Nhánh AIS trong `src/bootstrap/createProductionRuntime.ts` | Chỉ nối Marine AIS khi bật rõ ràng | **ĐÓNG BĂNG** — nằm im trừ khi cờ được bật |
| `src/interfaces/http/internalAcquireRoute.ts` | Kênh HTTP nội bộ do Bot sở hữu (comment có nhắc Marine như bên dùng trong tương lai) | **ĐÓNG BĂNG** — Bot không gọi sang Marine; đây chỉ là bề mặt lệnh cục bộ, tuỳ chọn |
| `docs/BOT_MARINE_INTEGRATION.md`, `docs/AIS_MARINE_WS_BRIDGE.md`, v.v. | Ghi chép thiết kế tích hợp thời trước | **ĐÓNG BĂNG** — chỉ để tham khảo, không mô tả runtime hiện tại |
| Thư mục lồng `marine-api/` | Dự án lạ nằm lồng vào | **XOÁ** nếu có (đã gitignore). Tại thời điểm rà soát **không có trên đĩa**. |
| `MarineApiClient` / `MarineSyncService` v.v. | — | **Không tồn tại** |

## Kiểm tra phụ thuộc chéo dự án

- Không có `import`/`require` nào tới Soosky-marine-api hay package `marine-api` lồng bên trong: **KHÔNG CÓ**
- Cấu hình runtime mặc định: `botAisEnabled=false`, `marineAisWsUrl=""`, `paidFallbackEnabled=false`

## Những gì thực sự đã xoá lần này

- Thư mục lồng `marine-api/`: **không có** (không có gì để xoá)
- Không tìm thấy class client nào của Marine để xoá
- Không có phụ thuộc package nào tới kho Marine

## Xác nhận Bot chạy độc lập

Trách nhiệm của Bot vẫn là:

```
VesselFinder / ShipFinder / ShipInfo
  → crawl → chuẩn hoá → Observation → Resolver → Canonical → MongoDB của Bot
```

`VesselBasics` / `VesselDetails` = **mục tiêu độ phủ trường dữ liệu mong muốn**, không phải bề mặt API của Marine.

## Những việc KHÔNG được làm tiếp (theo đợt điều chỉnh này)

- Không bật cầu Marine AIS
- Không gọi HTTP sang Marine
- Không bắt đầu refactor kiến trúc thư mục AIS đang đóng băng
- Nếu làm lại proof chuyển động miễn phí thì chỉ chạy trong phạm vi `scripts/data-proof` hoặc CLI proof
