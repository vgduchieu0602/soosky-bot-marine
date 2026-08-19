# Kiến trúc hệ thống

Đây là tài liệu kiến trúc **có hiệu lực**. Các tài liệu theo giai đoạn trước đó chỉ mang tính lịch sử hoặc tham khảo chi tiết, không được phép ghi đè cấu trúc mô tả ở đây.

## Hệ thống này làm gì

`Soosky-bot-marine` nhận dữ liệu từ WebSocket AIS của Marine, crawl và làm giàu dữ liệu từ các nguồn tàu miễn phí, chuẩn hoá dữ liệu thô thành bản quan sát, hợp nhất dữ liệu nhiều nguồn, và duy trì bản ghi tàu chuẩn hiện tại. Phần nạp dữ liệu theo dõi trả phí để dành cho giai đoạn sau.

`Soosky-marine-api` vẫn giữ nguyên trách nhiệm: kết nối AISStream đầu nguồn, API công khai và WebSocket phục vụ mobile. Đợt refactor này không đụng gì tới dịch vụ production đó.

## Các tầng và luật phụ thuộc

Mũi tên đọc là "được phép biết tới":

```text
domain
  ↑
application
  ↑
infrastructure / interfaces
  ↑
bootstrap
```

- `domain/` chứa các khái niệm hàng hải thuần: entity, value object, enum, validator và lỗi domain. Nó **không biết** gì về giao vận, lưu trữ, nhà cung cấp bên ngoài, hay bất kỳ tầng nào khác.
- `application/` chứa các luồng nghiệp vụ hoàn chỉnh, service dùng lại được, và các contract. Code ở đây được import domain và contract của chính application, nhưng **không được** import infrastructure.
- `infrastructure/` hiện thực phần tích hợp bên ngoài, lưu trữ, cùng các adapter HTTP và cache dùng chung.
- `interfaces/` là các cửa vào HTTP và CLI, gọi tới những object application đã được cấu hình sẵn.
- `bootstrap/` là nơi lắp ráp. Nó tạo adapter cụ thể rồi nối vào object application; nó **không chứa** luật nghiệp vụ nào.

## Các luồng dữ liệu chính

### Luồng AIS

```text
WebSocket production của Marine
  → MarineAisWebSocketClient
  → MarineAisMessageMapper
  → AisCoalescingBuffer (service nạp dữ liệu, thuộc application)
  → pipeline observation / resolver
  → bản ghi tàu chuẩn hiện tại
```

`AisCoalescingBuffer` chỉ nhận `AisIngestionEvent` — một khuôn dữ liệu nhỏ do chính application sở hữu. Sự kiện từ adapter Marine tương thích về mặt cấu trúc, nên bộ đệm **không** phụ thuộc vào WebSocket client hay các DTO giao vận của Marine.

### Luồng crawl nguồn miễn phí

```text
ShipFinder / ShipInfo / VesselFinder
  → provider adapter
  → observation
  → resolver
  → bản ghi tàu chuẩn hiện tại
```

Mỗi nguồn bên ngoài giữ client, parser, mapper, kiểu dữ liệu, fixture và provider của riêng nó trong đúng thư mục `infrastructure/integrations/<tên-nguồn>/`.

## Lưu trữ

Các hiện thực lưu trữ được nhóm theo công nghệ:

- `infrastructure/persistence/mongo/`
- `infrastructure/persistence/memory/`
- `infrastructure/persistence/file/`

Schema Mongo và model Mongoose nằm cùng nhau trong từng module model.

Một điểm cần nhớ: **entity domain không phải model Mongoose**. Object domain không bao giờ import Mongoose; ngược lại, repository Mongo hiện thực contract repository của application và làm cầu nối giữa object application với document Mongo.

## Use case, service và contract

**Use case** là một luồng nghiệp vụ hoàn chỉnh — ví dụ "thu thập dữ liệu tàu" hay "giải và lưu trạng thái tàu hiện tại". **Service** hỗ trợ cho một hoặc nhiều luồng, chứa logic chính sách hoặc điều phối.

Use case nhóm theo trách nhiệm:

- `application/use-cases/acquisition/`
- `application/use-cases/observation/`
- `application/use-cases/resolution/`
- `application/use-cases/vessel/`
- `application/use-cases/watchlist/`

Hiện chưa có use case nào cho việc nạp AIS; giai đoạn AIS-4 mới là lúc có thể thêm.

Ví dụ để phân biệt:

- `AisCoalescingBuffer` là service nạp dữ liệu ở tầng application.
- `PositionResolver` là service giải dữ liệu ở tầng application.
- `MarineAisWebSocketClient` là adapter ở tầng infrastructure.

Contract nằm cạnh đúng trách nhiệm của nó: repository ở `application/contracts/repositories/`, contract nhà cung cấp ở `application/contracts/providers/`, contract cache ở `application/contracts/cache/`, và các nguyên thuỷ quét theo vùng địa lý ở `application/contracts/geo/`. Adapter cụ thể ở infrastructure sẽ hiện thực những contract này.

## Bootstrap

`bootstrap/container.ts` là nơi lắp ráp trung tâm. Nó tách rõ hai ranh giới tương thích:

- `createLegacyDependencies.ts` nối đường HTTP/CLI cũ theo mô hình VesselFinder, giữ lại cho tương thích.
- `createCanonicalDependencies.ts` nối các provider đa nguồn, observation, resolver và phần phụ thuộc của bản ghi tàu chuẩn.

Cả hai factory **chỉ** lắp ráp phụ thuộc. Chúng không khởi động crawler, scheduler hay AIS client.

## Code cũ (legacy)

`src/legacy/` giữ lại model, mapping và luồng quét theo kiểu VesselFinder đời trước để không làm vỡ phần đang chạy. Nó được cô lập có chủ đích và **không được lấy làm khuôn mẫu kiến trúc** cho tính năng mới.

Số ít chỗ import legacy đều nằm gọn trong các đường dẫn và adapter thuộc về legacy; domain và service application chuẩn không phụ thuộc vào code legacy.
