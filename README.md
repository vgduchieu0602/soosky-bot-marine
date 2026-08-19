# Crawl-Marine-Bot (`crawlbot` v1.0.0)

Bot thu thập và chuẩn hoá dữ liệu tàu biển cho hệ Soosky Marine — TypeScript + Clean Architecture.

Bot **không** phải service public. Nó là tiến trình hậu cần: quét vùng biển từ các nguồn tàu miễn phí, nhận AIS qua WebSocket nội bộ (tuỳ chọn), ghi lại từng bản quan sát, hợp nhất nhiều nguồn thành **một bản ghi tàu chuẩn hiện tại**, và phục vụ read model cho map/detail.

`Soosky-marine-api` vẫn là chủ sở hữu duy nhất của kết nối AISStream đầu nguồn, API công khai và WebSocket cho mobile. Bot không thay thế nó.

---

## 1. Bot làm gì

| Trách nhiệm | Cơ chế |
|---|---|
| Phát hiện tàu theo vùng | `AdaptiveRegionScheduler` quét vùng theo mật độ đo được, một vùng một lúc |
| Nhận AIS | `MarineAisWebSocketClient` → mapper → `AisCoalescingBuffer` (gộp theo MMSI) |
| Ghi bản quan sát | `ObservationRecorder` + dedupe theo vân tay, có retention |
| Hợp nhất nguồn | Resolver (identity / particulars / position / voyage) → bản ghi tàu chuẩn |
| Làm giàu chi tiết | `GetOrRefreshVesselDetail` gọi có ngân sách, có cooldown chống ban |
| Read model map | `QueryMap` / `GetMapVessels` — truy vấn theo viewport + cluster theo zoom |
| Kênh lệnh nội bộ | `POST /internal/vessels/:id/acquire` — Marine API gọi khi dữ liệu của nó chưa đủ |

Nguyên tắc xuyên suốt: **LOCAL → FREE → PAID**. Nhánh trả phí (`myshiptracking`) mặc định TẮT và chưa nối vào composition root.

---

## 2. Kiến trúc

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

```text
src/
├── domain/            entity, value object, enum, validator — thuần, không import framework
├── application/       use-case, service, contract (port) — không import infrastructure
│   ├── contracts/     repositories · providers · cache · geo
│   ├── services/      acquisition · crawl-runtime · ingestion · map · observation · resolution
│   └── use-cases/     acquisition · ingestion · map · observation · resolution · tracking · vessel · watchlist
├── infrastructure/    integrations · persistence · cache · http · scheduler
├── interfaces/        http (Express) · cli · runtime
├── bootstrap/         composition root — chỉ lắp ráp, không có luật nghiệp vụ
├── config/            loadConfig(env), số sai thì THROW ngay lúc khởi động
└── legacy/            luồng VesselFinder đời cũ, cô lập có chủ ý — KHÔNG lấy làm khuôn mẫu
```

Chi tiết: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · ranh giới: [docs/ARCHITECTURE_BOUNDARY.md](docs/ARCHITECTURE_BOUNDARY.md)

### Luồng dữ liệu

```text
AIS:   Marine WS nội bộ → MarineAisWebSocketClient → MessageMapper
       → AisCoalescingBuffer → IngestAisBatch → observation → resolver → canonical

Crawl: ShipFinder / ShipInfo / VesselFinder → provider adapter
       → observation → resolver → canonical
```

---

## 3. Nguồn dữ liệu

Năng lực từng nguồn được khai báo thành **code kiểm tra được** (`sourceCapabilityMatrix.ts`), không phải kiến thức trong đầu. Ba mức: CONFIRMED (code đã bóc thật) · CANDIDATE (chưa audit/POC) · UNSUPPORTED.

| Nguồn | Chi phí | Đang bật | Ưu tiên |
|---|---|---|---|
| `aisstream` | EXISTING_STREAM | — | 10 |
| `vesselfinder` | FREE | ✅ | 20 |
| `shiptraffic` | FREE | — | 40 |
| `shipinfo` | FREE | — | 45 |
| `vesseltracker` | FREE | — | 50 |
| `shipfinder` | FREE | — | 55 |
| `boatnerd` | FREE | — | 60 |
| `marinetraffic_live` | FREE | — | 70 |
| `myshiptracking` | **PAID** | ✅ (cần API key) | 900 |

Luật cứng: **không tự nâng CANDIDATE → CONFIRMED**. Chỉ nâng sau audit/POC thật; test chặn vi phạm.

Bảng tra: [docs/SOURCE_CAPABILITY_MATRIX.md](docs/SOURCE_CAPABILITY_MATRIX.md) · bản tương tác: [docs/SOURCE_CAPABILITY_MATRIX.html](docs/SOURCE_CAPABILITY_MATRIX.html) · audit từng nguồn: [docs/sources/](docs/sources/)

---

## 4. Chạy dự án

Yêu cầu: Node >= 18, MongoDB. Redis tuỳ chọn (không có thì dùng cache in-memory).

```bash
npm install
cp .env.example .env    # điền API_KEY và MONGODB_URI
npm run build
npm test
```

### Hai dạng tiến trình production

```bash
npm run build && npm run start:bot   # marine-bot: Mongo + AIS + crawl + cleanup
npm run enrich                        # worker làm giàu, RIÊNG và TUỲ CHỌN
```

PM2 (`ecosystem.config.cjs`) bắt buộc `instances: 1`, `exec_mode: fork`. Chạy cluster sẽ nhân đôi kết nối AIS và việc crawl khi chưa có điều phối phân tán.

### HTTP server (legacy detail lookup / health)

```bash
npm start          # ts-node, bind 127.0.0.1:3000
npm run start:prod # từ dist/
```

| Route | Auth | Ghi chú |
|---|---|---|
| `GET /health` | — | |
| `GET /positions` | — | read model cho map |
| `GET /vessel/:id` | `X-API-Key` | |
| `GET·POST /watchlist`, `DELETE /watchlist/:id` | `X-API-Key` | |
| `POST /internal/vessels/:id/acquire` | `X-Internal-Token` | **chỉ mount khi `INTERNAL_ACQUIRE_TOKEN` không rỗng** |

Server **từ chối khởi động** khi `API_KEY` rỗng. Mặc định bind loopback — muốn ra ngoài thì đặt sau reverse proxy.

---

## 5. Cấu hình

Toàn bộ ở [.env.example](.env.example), mỗi biến kèm lý do. Nhóm quan trọng:

| Nhóm | Biến then chốt |
|---|---|
| HTTP | `HTTP_HOST` `PORT` `API_KEY` |
| Lưu trữ | `MONGODB_URI` `REDIS_URL` `CACHE_TTL_MS` |
| Độ mới của map | `POSITION_STALE_AFTER_MS` `POSITION_CLEANUP_EVERY_MS` |
| Quét vùng | `SCAN_BBOX` `SCAN_INTERVAL_MS` `SCAN_TILE_DELAY_MS` `SCAN_SUBDIVIDE_THRESHOLD` `SCAN_BLOCK_COOLDOWN_MS` |
| AIS | `BOT_AIS_ENABLED` `MARINE_AIS_WS_URL` `AIS_COALESCE_WINDOW_MS` `AIS_MAX_BUFFERED_VESSELS` `AIS_FLUSH_BATCH_SIZE` |
| Vòng đời | `RUNTIME_SHUTDOWN_TIMEOUT_MS` `AIS_RECONNECT_*` |
| Detail | `DETAIL_REFRESH_TIMEOUT_MS` `DETAIL_REFRESH_MAX_SOURCES` `DETAIL_REFRESH_COOLDOWN_MS` |
| Fallback trả phí | `PAID_FALLBACK_ENABLED` `MYSHIPTRACKING_API_KEY` `FREE_FALLBACK_TOTAL_TIMEOUT_MS` |
| Kênh nội bộ | `INTERNAL_ACQUIRE_TOKEN` |

Ba cái dễ sai nhất:

- **`AIS_COALESCE_WINDOW_MS`** là núm vặn quan trọng nhất của cả đường ống. Dedupe theo vân tay KHÔNG chặn được vị trí AIS (mỗi frame một `sourceReceivedAt` khác nhau), nên số document ghi xuống Mongo = `86400 / windowSeconds` mỗi tàu mỗi ngày. Mặc định 60s; 10s đã đo được ~8.640 vị trí/tàu/ngày.
- **`MARINE_AIS_WS_URL` không được trỏ tới `stream.aisstream.io`.** Client tự chặn và ném ngay lúc dựng — production là chủ sở hữu duy nhất của kết nối nhà cung cấp.
- **`SHIPFINDER_SOURCE_UTC_OFFSET_MINUTES` cố tình không có mặc định.** ShipFinder không khai báo múi giờ ở đâu; UTC+8 chỉ là suy luận từ audit. Không khai thì ShipFinder không phát ra nhóm position — thà thiếu vị trí còn hơn gắn mốc sai hàng giờ.

---

## 6. Lưu trữ

Hiện thực nhóm theo công nghệ: `persistence/mongo/` · `persistence/memory/` · `persistence/file/`.

Model Mongoose: `Vessel` · `VesselPosition` · `LatestPosition` · `WatchlistItem` · `VesselObservation` · `CurrentVessel` · `CrawlRegionState` · `CrawlCheckpoint`.

**Entity domain không phải model Mongoose.** Object domain không bao giờ import Mongoose; repository Mongo hiện thực contract của application và làm cầu nối.

Tham khảo: [docs/OBSERVATION_STORAGE.md](docs/OBSERVATION_STORAGE.md) · [docs/CANONICAL_CURRENT_STORAGE.md](docs/CANONICAL_CURRENT_STORAGE.md) · [docs/AIS_LOAD_AND_RETENTION.md](docs/AIS_LOAD_AND_RETENTION.md)

---

## 7. CLI

Mọi CLI vào qua composition root, không tự dựng phụ thuộc.

**Vận hành**

```bash
npm run crawl                  # crawl watchlist một lượt
npm run scan                   # quét vùng theo SCAN_BBOX
npm run enrich                 # worker làm giàu
npm run get -- <mmsi|imo>      # tra một tàu
npm run audit                  # audit dữ liệu đã lưu
npm run check-drift            # phát hiện HTML nguồn đổi cấu trúc
npm run reset-indexes
npm run map:backfill-location
```

**POC / smoke từng nguồn**

```bash
npm run shipinfo:smoke      npm run shipinfo:poc
npm run shipfinder:smoke    npm run shipfinder:poc
npm run acquire:free:poc    npm run fallback:cost
npm run marine-ais:poc      npm run marine-ais:buffer-sim
npm run map:query-poc       npm run map:cluster-poc
```

**Data proof** (sinh báo cáo có mốc thời gian vào `docs/reports/`)

```bash
npm run bot:discovery       npm run bot:map        npm run bot:detail-proof
npm run bot:continuous      npm run bot:data-report
npm run proof:regional      npm run proof:free-motion
npm run adaptive:cycle      npm run adaptive:soak  npm run adaptive:report
```

**Đo tải runtime**

```bash
npm run runtime:load-poc -- --vessels=10000 --events=60000
```

Bài đo này tất định và chỉ dùng repository in-memory. Nó phát hiện hồi quy — **không** khẳng định gì về throughput Mongo trên production.

---

## 8. Test & CI

```bash
npm test                  # node:test qua ts-node, 95 file *.test.ts nằm cạnh source
npm run contract:parity   # kiểm hợp đồng canonical v1 khớp giữa doc và code
```

CI (GitHub Actions, Node 22): `npm ci` → `npm run build` → `npm test`.

Không có framework crawler (không puppeteer/cheerio/axios) — dùng `fetch` global + parser regex, có fixture cho từng nguồn.

---

## 9. Vòng đời production

`ProductionRuntime` sở hữu vòng đời.

Khởi động: Mongo → dựng phụ thuộc → coordinator AIS → scheduler định kỳ.
Tắt (ngược lại, theo chiều "ngừng sinh việc mới"): dừng scheduler → dừng AIS và việc kết nối lại, rút nốt các lô cuối → đóng Mongo.

`SIGTERM`, `SIGINT`, uncaught exception và unhandled rejection đi chung **một** đường tắt máy có bảo vệ, chặn thời gian bởi `RUNTIME_SHUTDOWN_TIMEOUT_MS` (mặc định 15s).

Kết nối lại AIS: backoff 1s → gấp đôi → tối đa 30s, cộng 20% jitter.

Ảnh chụp sức khoẻ trong tiến trình (**không** phải endpoint công khai):

```text
{ status, mongo, ais: { enabled, connected, pending }, workers, memory }
```

Mongo đã kết nối nhưng AIS đang reconnect → `DEGRADED`. Thiếu Mongo thì không bao giờ `READY`.

Hạ tầng khởi đầu: 2 vCPU / 2GB RAM, Mongo đặt **bên ngoài**. VPS 1GB không khuyến nghị. Ngưỡng `max_memory_restart: 700M` của PM2 là hàng rào an toàn, không phải tuyên bố sức chứa.

Chi tiết: [docs/PRODUCTION_RUNTIME.md](docs/PRODUCTION_RUNTIME.md) · [docs/CRAWL_RUNTIME.md](docs/CRAWL_RUNTIME.md)

---

## 10. Tài liệu

| Chủ đề | File |
|---|---|
| Kiến trúc có hiệu lực | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Audit trạng thái hiện tại | [CURRENT_ARCHITECTURE.md](docs/CURRENT_ARCHITECTURE.md) · [CURRENT_DATA_FLOW.md](docs/CURRENT_DATA_FLOW.md) |
| Mô hình tàu chuẩn | [CANONICAL_VESSEL_MODEL.md](docs/CANONICAL_VESSEL_MODEL.md) · [contracts/CANONICAL_VESSEL_V1.md](docs/contracts/CANONICAL_VESSEL_V1.md) |
| Nguồn & năng lực | [SOURCE_CAPABILITY_MATRIX.md](docs/SOURCE_CAPABILITY_MATRIX.md) · [PROVIDER_ARCHITECTURE.md](docs/PROVIDER_ARCHITECTURE.md) |
| Chính sách thu thập | [ACQUISITION_POLICY.md](docs/ACQUISITION_POLICY.md) · [FREE_TO_PAID_FALLBACK.md](docs/FREE_TO_PAID_FALLBACK.md) · [RESOLVER_POLICY.md](docs/RESOLVER_POLICY.md) |
| Đường ống AIS | [AIS_CANONICAL_INGESTION.md](docs/AIS_CANONICAL_INGESTION.md) · [AIS_COALESCING_BUFFER.md](docs/AIS_COALESCING_BUFFER.md) · [AIS_BULK_PERSISTENCE.md](docs/AIS_BULK_PERSISTENCE.md) · [AIS_MARINE_WS_BRIDGE.md](docs/AIS_MARINE_WS_BRIDGE.md) |
| Map | [MAP_VIEWPORT_QUERY.md](docs/MAP_VIEWPORT_QUERY.md) · [MAP_ZOOM_AND_DENSITY.md](docs/MAP_ZOOM_AND_DENSITY.md) · [MAP_CANONICAL_READINESS.md](docs/MAP_CANONICAL_READINESS.md) |
| Detail | [DETAIL_CANONICAL_READ_MODEL.md](docs/DETAIL_CANONICAL_READ_MODEL.md) · [DETAIL_TARGETED_ENRICHMENT.md](docs/DETAIL_TARGETED_ENRICHMENT.md) |
| Tích hợp Marine | [BOT_MARINE_INTEGRATION.md](docs/BOT_MARINE_INTEGRATION.md) · [MARINE_API_INTEGRATION_AUDIT.md](docs/MARINE_API_INTEGRATION_AUDIT.md) |
| Phạm vi & sở hữu dữ liệu | [STANDALONE_SCOPE_AUDIT.md](docs/STANDALONE_SCOPE_AUDIT.md) · [CRAWL_DATA_OWNERSHIP.md](docs/CRAWL_DATA_OWNERSHIP.md) |
| Báo cáo đã chạy | [docs/reports/](docs/reports/) |

---

## 11. Ranh giới cần tôn trọng

- **`MONGODB_URI` không được trỏ vào MongoDB production của Soosky Marine.** `databaseSafety.ts` là chốt chặn.
- Bot **không** sở hữu kết nối AIS đầu nguồn. `BOT_AIS_ENABLED=false` là mặc định đúng cho production.
- Endpoint có thể tiêu credit thật phải bật **có chủ ý**: `INTERNAL_ACQUIRE_TOKEN` rỗng thì route không được mount.
- `PAID_FALLBACK_ENABLED` chỉ nhận đúng chuỗi `"true"`. Mọi giá trị khác, kể cả rỗng, đều là tắt.
- Không commit API key thật, không log key.
- `src/legacy/` giữ để không làm vỡ phần đang chạy — không dùng làm khuôn mẫu cho tính năng mới.

---

Giấy phép: MIT
