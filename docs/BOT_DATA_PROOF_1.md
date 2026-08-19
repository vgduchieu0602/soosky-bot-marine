# BOT-DATA-PROOF-1 — Chứng minh pipeline dữ liệu

Đây là biên bản chạy thật để chứng minh Bot tự crawl và tự dựng được dữ liệu chuẩn, không cần Marine, không tốn tiền.

## Rào an toàn bắt buộc

| Chốt chặn | Giá trị |
|---|---|
| `BOT_DATA_PROOF_MODE` | `true` |
| Mongo DB | `soosky_marine_bot_dev` (local `127.0.0.1:27017`) |
| Chặn nhầm DB production | `src/config/databaseSafety.ts` từ chối các tên DB production đã biết |
| `BOT_AIS_ENABLED` | `false` |
| `PAID_FALLBACK_ENABLED` | `false` |
| Số lần gọi MyShipTracking | **0** (báo cáo ghi `myShipTrackingKeyPresent: false`) |
| Tích hợp Marine | **không có** |

## Lệnh đã chạy

```bash
export BOT_DATA_PROOF_MODE=true
export MONGODB_URI='mongodb://127.0.0.1:27017/soosky_marine_bot_dev'
export BOT_AIS_ENABLED=false
export PAID_FALLBACK_ENABLED=false

npm run build
npm test

npm run bot:discovery -- --pages=10 --reset-checkpoint
npm run bot:discovery -- --pages=100   # chạy tiếp từ checkpoint
npm run bot:map-proof
npm run bot:detail-proof -- --sample=30
npm run bot:data-report
```

## Đường đi dữ liệu đã được chứng minh

```
Ô bản đồ mp2 của VesselFinder
  → VesselFinderProvider.scanArea
  → ObservationRecorder.recordPositions
  → vessel_observations
  → ResolveAndStoreCurrentVessel
  → canonical_current_vessels
```

Không có đường tắt nào từ crawler đi thẳng vào kho chuẩn.

## Kết quả chạy thật (tóm tắt)

### Giai đoạn tìm tàu (gộp nhiều lần chạy)

| Chỉ số | Bằng chứng |
|---|---|
| Số trang trả HTTP 200 | 10 + 10 + 5 + 20 (cộng chuỗi chạy tiếp trước đó tới ô số 103) |
| Lỗi / 403 / 429 | **0** trong các lô báo cáo thành công |
| Số dòng thô (lô 20 ô gần nhất) | 1081 |
| Số MMSI khác nhau (lô đó) | 1081 |
| Checkpoint | `bot_crawl_checkpoints`, job `data-proof-discovery` → tileIndex **103**/108 |
| Chạy tiếp | log ghi `Resuming checkpoint at tile 15/108` rồi chạy hết |

### Giai đoạn bản đồ

| Chỉ số | Giá trị |
|---|---|
| Số trang | 10 OK |
| Dòng vị trí | 154 thô / 153 khác nhau |
| Có lat/lon trong kho chuẩn | **2289 / 2289 = 100%** |
| course / speed / navStatus | gần 0% từ ô bản đồ (giới hạn của nguồn) |
| sourceObservedAt | gần 0% từ ô bản đồ (định dạng mp2 không có mốc thời gian) |

### Mẫu chi tiết (n=30, đa nguồn miễn phí)

| Trường | Độ phủ |
|---|---|
| vesselType | **90%** |
| flag | **100%** |
| grossTonnage | 0% |
| deadWeight | 0% |
| yearOfBuild | 0% |
| cảng / hành trình | 0% |

Nhiều lần thử dừng ở `NO_FREE_SOURCE_AVAILABLE` sau khi mới làm giàu được phần danh tính. Nhánh trả phí đã tắt theo thiết kế.

### Cơ sở dữ liệu

| Collection | Số lượng / ghi chú |
|---|---|
| `vessel_observations` | 4800 |
| `canonical_current_vessels` | 2289 (tất cả đều có lat/lon) |
| `bot_crawl_checkpoints` | con trỏ của discovery và map |
| Index của observations | mmsi/imo/source/fingerprint/expiresAt |
| Index của canonical | mmsi, imo, **location_2dsphere** |
| Dung lượng | khoảng 4,59 MB dữ liệu + 2,1 MB index (mẫu) |

### Tốc độ (đo thật)

| Lô | trang/phút | tàu/phút |
|---|---|---|
| discovery 20 ô / 39,3 giây / 1081 tàu | ~30,5 | ~1650 |
| map 10 ô / 17,2 giây / 154 tàu | ~35 | ~540 |

**Ước tính thời gian quét hết** (quy chiếu minh hoạ theo thang 31 nghìn trang danh sách; đơn vị thật của ta là ô bản đồ):

- lạc quan nhất: ~31k/40 ≈ **13 giờ**
- theo tốc độ đo được ~30 trang/phút: **~17 giờ**
- thận trọng (tính lỗi và thời gian nghỉ): **24–48 giờ**

### Bộ nhớ tiến trình

| Trạng thái | RSS | heap |
|---|---|---|
| đỉnh lúc crawl | ~500 MB | ~410 MB |
| lúc chạy báo cáo, gần như rảnh | ~480 MB | ~394 MB |

Không thấy bộ nhớ leo dần khi quét qua các ô rỗng (giữ ổn định ~460 MB trên vùng biển trống).

### Build / test

| | |
|---|---|
| `npm run build` | ĐẠT |
| `npm test` | **1054/1054 ĐẠT** |

## Đánh giá năng lực

| Nhu cầu | Chỉ dùng crawler có làm được không? |
|---|---|
| A. Tìm tàu (mật độ MMSI + tên) | **ĐƯỢC** — ô bản đồ VesselFinder chạy tốt |
| B. Lớp nền bản đồ (chấm lat/lon) | **ĐƯỢC** với chấm vị trí; **KHÔNG** lấy được course/speed/nav/thời gian nguồn một cách tin cậy từ dữ liệu nhị phân của bản đồ miễn phí |
| C. Chi tiết tàu (GT/DWT/hành trình) | **MỘT PHẦN** — cờ và loại tàu thì thường có; dung tích và hành trình cần nguồn miễn phí tốt hơn, hoặc phải trả phí |

## Kết luận

**ĐẠT CÓ ĐIỀU KIỆN**

Chưa đạt hoàn toàn vì:

- Chưa chạy liên tục 2–6 tiếng trong phiên này
- Chưa đo riêng việc rút dữ liệu khi nhận SIGTERM thật (phần xử lý thì đã có)
- Độ phủ dung tích và hành trình trên đường miễn phí vẫn 0%
- Chưa lập bảng đối chiếu tay đầy đủ 10 bản ghi với HTML nguồn
- Cây làm việc phía Marine chỉ thấy xoá vài file `tmp/*` không liên quan; không có sửa mã nguồn nào thuộc giai đoạn proof

## Commit đề xuất

```
feat(runtime): prove standalone marine crawl data pipeline
```
