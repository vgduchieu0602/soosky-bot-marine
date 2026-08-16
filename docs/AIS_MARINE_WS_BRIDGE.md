# AIS_MARINE_WS_BRIDGE — phase AIS-2

> Client WebSocket đọc stream AIS **nội bộ** mà Soosky-marine-api production đã phát sẵn, rồi đẩy qua mapper AIS-1.
>
> Phase này **CHỈ** là transport. Không Mongo, không recorder, không resolver, không gộp mẻ.
>
> Tiếp nối [AIS_CANONICAL_INGESTION.md](./AIS_CANONICAL_INGESTION.md) (AIS-1 — mapping).

---

## 0. Đường đi

```
AISStream.io                         ← nhà cung cấp, production sở hữu DUY NHẤT
      ↓  wss://stream.aisstream.io/v0/stream
Soosky-marine-api                    ← KHÔNG ĐƯỢC SỬA
      ↓  ws://<host>:<port>/ais-stream        (WS nội bộ, đã có sẵn)
MarineAisWebSocketClient             ← AIS-2, file này
      ↓  JSON.parse → isMarineAisMessage → mapMarineAisMessage
emit("normalizedData", { result, receivedAt, mmsi, type })
      ↓
(AIS-3: coalescing → bulkWrite → vessel_observations)
```

Bot **không** mở connection thứ hai tới nhà cung cấp AIS. Nó chỉ là **một client nữa** của WebSocket mà production vốn đã broadcast — đúng phương án PA2 trong [MARINE_API_INTEGRATION_AUDIT.md §E.1](./MARINE_API_INTEGRATION_AUDIT.md).

---

## 1. Audit hợp đồng WebSocket production

Bằng chứng từ `soosky-marine-api/src/server/Server.ts`:

```ts
private readonly _httpServer = http.createServer(this._server);
private readonly _wss = new WebSocket.Server({ server: this._httpServer, path: "/ais-stream" });
```

| Hạng mục | Kết quả audit |
|---|---|
| **Path** | `/ais-stream` — cứng trong code, không cấu hình được |
| **Port / host** | **Dùng chung `_httpServer` với REST API** → đúng `HTTP_PORT` / `HTTP_HOST` của production. `listen()` mặc định `localhost:3000` khi env rỗng |
| **Protocol** | `http.createServer` → **`ws://`** ở tầng ứng dụng. Thành `wss://` chỉ khi có reverse proxy TLS phía trước |
| **Xác thực** | 🔴 **KHÔNG CÓ.** Không `verifyClient`, không token, không kiểm origin. Ai tới được cổng là đọc được stream |
| **Frame chào** | ✅ Có. Mỗi client vừa nối nhận `{"message":"Connected to Soosky Marine WebSocket Server!"}` |
| **Payload** | `JSON.stringify(AisMessage)` — text frame, không nén, không binary |
| **Ping/pong** | 🔴 **KHÔNG CÓ** cho client. `_initInternalWss` chỉ đăng ký `connection`/`close`/`error`. `AisWebSocketManager` có ping nhưng đó là ping **lên AISStream**, không phải xuống bot |
| **Reconnect phía server** | Không áp dụng (nó là server). Không có replay, không có buffer — client mất kết nối là **mất luôn** frame trong khoảng đó |
| **Backpressure** | Không xử lý. `_broadcastToClients` gửi cho mọi client `readyState === OPEN`, không kiểm `bufferedAmount` |

```ts
private _broadcastToClients(data: AisMessage): void {
    const message = JSON.stringify(data);
    this._wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
}
```

### 🔴 Frame chào — cái bẫy dễ dính nhất

```ts
ws.send(JSON.stringify({ message: "Connected to Soosky Marine WebSocket Server!" }));
```

Frame này là **JSON hợp lệ nhưng KHÔNG phải `AisMessage`**. Client ngây thơ sẽ đếm nó là `CONTRACT_MISMATCH` **mỗi lần reconnect** → báo động giả liên miên.

Client của bot nhận diện riêng và đếm vào `serverNotices`: có `message` dạng chuỗi, **không** có `type`, **không** có `data`.

---

## 2. Cấu hình

Một biến duy nhất, không hardcode hostname:

```bash
MARINE_AIS_WS_URL=ws://127.0.0.1:3000/ais-stream
```

- Trống → **không có gì kết nối**. Không service nào tự bật.
- ⚠️ Endpoint **không xác thực** → chỉ nên đi qua loopback, mạng nội bộ, hoặc SSH tunnel. Đừng phơi ra internet.
- Không có credential nào để commit — chính vì nó không có xác thực.

---

## 3. Cổng chặn URL

```ts
assertMarineAisUrl(url)   // chạy trong constructor -> fail fast
```

Ném ngay khi:

| Trường hợp | |
|---|---|
| Không parse được thành URL | `MARINE_AIS_WS_URL không phải URL hợp lệ` |
| Protocol không phải `ws:`/`wss:` | chặn `https://`, `file://`, … |
| Hostname là `aisstream.io` hoặc `*.aisstream.io` | `trỏ thẳng tới nhà cung cấp AIS` |

Lý do cổng thứ ba: quyết định kiến trúc "production là chủ sở hữu duy nhất của connection AISStream" phải được **code cưỡng chế**, không chỉ nằm trong tài liệu. Một dòng `.env` sửa nhầm không được phép biến bot thành client thứ hai của nhà cung cấp.

Không có framework bảo mật URL nào — đúng ba phép kiểm, đọc hết trong 10 giây.

---

## 4. Vòng đời

```ts
const client = new MarineAisWebSocketClient({ url });   // cổng URL chạy Ở ĐÂY
client.start();          // đồng bộ, không throw
await client.stop();     // đóng sạch
client.isActive();       // đang CONNECTING hoặc OPEN
client.getStats();
```

### Một connection, không hơn

`start()` gọi bao nhiêu lần cũng chỉ có **một** socket:

```ts
if (this.isActive()) return;   // CONNECTING hoặc OPEN -> không mở thêm
```

Mọi handler đều bắt đầu bằng `if (this.socket !== socket) return;` — socket cũ đang hấp hối không được phép nói thay socket mới.

### `stop()` là dứt khoát

1. `stopped = true` → mọi đường tới `openSocket()` bị chặn
2. huỷ timer reconnect **và** timer stale
3. `socket.removeAllListeners()` **trước** khi `close()` — nếu không, chính handler `close` sẽ xếp lịch reconnect cho một client vừa bị dừng
4. chờ close handshake, quá `closeTimeoutMs` thì `terminate()`

POC đã nối `SIGINT`/`SIGTERM` → `stop()`. Bootstrap production chưa cần sửa vì chưa service nào chạy client.

---

## 5. Reconnect

Backoff mũ **có trần**, single-flight:

```
1s → 2s → 4s → 8s → 16s → 30s → 30s → …
initialReconnectDelayMs = 1000
maxReconnectDelayMs     = 30000
reconnectBackoffFactor  = 2
```

- Chỉ xếp lịch từ handler `close`. `ws` luôn phát `error` **rồi mới** `close`, đặt ở cả hai chỗ sẽ nhân đôi timer.
- `reconnectTimer !== null` → không xếp thêm.
- Kết nối lại thành công → backoff **reset về 1s**, nếu không lần rớt sau phải chờ 30s dù mạng đã ổn.
- Timer đều `.unref()` → không giữ process sống.

Không jitter: chỉ có **một** connection, không có đàn client nào để giẫm chân nhau.

⚠️ **Frame mất trong lúc mất kết nối là mất hẳn.** Production không buffer, không replay. AIS phát lại vị trí mỗi 2–10 giây nên chấp nhận được; `ShipStaticData` thưa hơn (~6 phút) nên một lần rớt dài có thể làm chậm việc biết tên tàu.

---

## 6. Đường xử lý một frame

```
frame
 ├─ binary?           → CONTRACT_MISMATCH
 ├─ JSON.parse hỏng   → MALFORMED_JSON
 ├─ frame chào server → serverNotices++        (KHÔNG phải lỗi)
 ├─ isMarineAisMessage = false → CONTRACT_MISMATCH   (mapper KHÔNG được gọi)
 └─ mapMarineAisMessage(message, now())
      ├─ ok=false → mappingRejected++ + emit rejectedMessage
      └─ ok=true  → emit normalizedData
```

**Không nhánh nào giết socket.** Một tàu phát MMSI rác không được làm rụng cả stream.

`receivedAt` lấy **một lần** ngay khi frame tới, từ `options.now()` tiêm được — không rải `Date.now()` trong code (AIS-1 §5).

---

## 7. Sự kiện

| Event | Payload |
|---|---|
| `connected` | `{ url }` |
| `disconnected` | `{ intentional, code?, reason? }` |
| `normalizedData` | `{ result: ProviderDetailsResult, receivedAt: Date, mmsi: string, type }` |
| `rejectedMessage` | `{ reason, detail? }` |
| `error` | `Error` |

`result` là **đúng** kiểu mà 3 provider pull đang dùng → cắm thẳng vào `detailsResultToObservations` ở AIS-3, không cần adapter.

⚠️ `EventEmitter` **ném** khi phát `error` mà không ai nghe. Client bọc lại (`emitSafe`) — với một thứ phải sống sót qua mọi frame rác, chết vì chính event lỗi là kiểu chết ngớ ngẩn nhất.

### 🔴 Listener PHẢI không chặn

Toàn bộ đường xử lý frame là **đồng bộ**. Listener của `normalizedData` cũng phải vậy. Một `await` chậm trong listener sẽ dồn ứ ngay ở socket, và production **không** có backpressure — nó cứ `send()` bất kể client có theo kịp hay không.

Ghi DB có mẻ là việc của **AIS-3** với buffer có trần, không phải của listener trực tiếp.

---

## 8. Bộ đếm

```ts
client.getStats()
```

| Trường | Nghĩa |
|---|---|
| `receivedFrames` | mọi frame, kể cả rác |
| `serverNotices` | frame chào của production |
| `validMessages` | qua được `isMarineAisMessage` |
| `mappingSuccess` / `mappingRejected` | kết quả mapper |
| `malformedJson` / `contractMismatch` | hỏng ở mức frame |
| `connections` | số lần mở được connection |
| `reconnects` | số lần **lên lịch** nối lại |
| `rejectionsByReason` | đếm theo từng mã lý do |

Trong RAM, không persist, chưa Prometheus.

### Log: mỗi lý do đúng MỘT dòng

Stream toàn cầu là hàng nghìn frame/giây. Client log **lần đầu** của mỗi mã lý do rồi im — số thật nằm ở `getStats()`. Không `console.log(rawFrame)` ở bất kỳ đâu. Có test khoá: 25 frame hỏng → đúng 1 dòng cảnh báo.

---

## 9. Không giữ lịch sử

Client **không** có mảng nào tích frame. Xử lý xong là GC được ngay. Có test kiểm: sau 25 frame, không thuộc tính nào của client là mảng khác rỗng.

Buffer gộp có trần là chuyện của AIS-3.

---

## 10. Lưới phát hiện connection chết (tuỳ chọn, mặc định TẮT)

```ts
staleConnectionTimeoutMs?: number   // undefined = tắt
```

Không nhận frame nào trong ngần này ms → `terminate()` → `close` → reconnect.

**Bằng chứng để có tuỳ chọn này:** audit cho thấy WS nội bộ của Marine **không ping** client. Một socket half-open sẽ im lặng mãi mãi mà `close` không bao giờ tới, nên reconnect cũng không bao giờ chạy.

**Bằng chứng để mặc định TẮT:** ngưỡng đặt sai sẽ tự cắt một connection đang khoẻ. Người vận hành bật là ký tên vào ngưỡng đó — cùng lối với `SHIPFINDER_SOURCE_UTC_OFFSET_MINUTES`.

Không tự chế heartbeat tầng ứng dụng: production không có phía đối ứng để bắt tay.

---

## 11. Type mới của production sau này

Nếu production broadcast thêm loại message:

- `isMarineAisMessage` trả `false` → `contractMismatch++`
- client **không** crash, stream vẫn chạy
- `getStats().contractMismatch` tăng đều đặn = tín hiệu phải cập nhật hợp đồng

Việc phải làm khi đó: cập nhật `MarineAisTypes.ts` + [AIS_CANONICAL_INGESTION.md §2](./AIS_CANONICAL_INGESTION.md), rồi mới tới mapper.

⚠️ Hiện production `_dataTransform` **ném** với type lạ và `_handleWsMessage` nuốt lỗi — nên message 18/19/24 (class B) **không bao giờ** tới được bot. Đây là giới hạn của production, không phải của client.

---

## 12. Dependency

Thêm `ws@^8` (runtime) + `@types/ws` (dev).

| Vì sao không dùng `WebSocket` global của Node | |
|---|---|
| `engines` khai `>=18`, mà global `WebSocket` chỉ ổn định từ **Node 22** | |
| Node core **không có** WebSocket **server** → test không dựng nổi server giả | |
| Production dùng đúng `ws` → cùng hành vi trên dây | |

`ws` không có dependency con. Không axios, không socket.io.

---

## 13. Chưa autostart

`container.ts` **không** được sửa. Không service nào, không test nào, không lệnh build nào tự mở connection.

Đường duy nhất tới socket ở phase này:

```bash
npm run marine-ais:poc
```

Có trần bắt buộc — không bao giờ chạy vô hạn:

```bash
npm run marine-ais:poc -- --max-messages=50 --max-seconds=30 --samples=5
# mặc định: --max-messages=20 --max-seconds=60 --samples=3
```

In tối đa vài sample một dòng (mmsi, lat/lng hoặc name/type, `sourceReceivedAt`), rồi bảng đếm, rồi thoát. Không ghi DB.

---

## 14. File

| File | |
|---|---|
| `src/infrastructure/ais/MarineAisWebSocketClient.ts` | client |
| `src/infrastructure/ais/MarineAisWebSocketClient.test.ts` | test với WS server giả ở localhost |
| `src/interfaces/cli/marineAisPoc.ts` | POC gọi tay, có trần |
| `src/config/index.ts` | `marineAisWsUrl` |
| `.env.example` | `MARINE_AIS_WS_URL` |
| `package.json` | `ws` · `@types/ws` · script `marine-ais:poc` |

---

## 15. Rủi ro

| # | | |
|---|---|---|
| 1 | WS nội bộ **không xác thực** — ai vào được cổng là đọc được toàn bộ stream AIS | 🔴 vận hành |
| 2 | Production **không có** backpressure. Listener chậm ở AIS-3 sẽ dồn ứ socket, và server vẫn cứ `send()` | 🔴 chặn AIS-3 |
| 3 | Mất kết nối = **mất frame**. Không replay, không buffer phía server | 🟡 |
| 4 | Không ping/pong → socket half-open chỉ phát hiện được khi bật `staleConnectionTimeoutMs` | 🟡 |
| 5 | Chưa đo throughput thật (POC mới chạy với server giả) — chưa có số để chọn cửa sổ gộp mẻ cho AIS-3 | 🟡 |

---

## 16. Phạm vi đề xuất cho AIS-3

1. **Đo trước.** Chạy POC với trần cao hơn trên production thật → frame/giây, tỉ lệ position/static, số MMSI riêng biệt.
2. **Coalescing có trần**: `Map<mmsi, latestPosition>`, giữ bản mới nhất theo `sourceReceivedAt`, **có giới hạn số key** — vượt thì bỏ theo LRU và ĐẾM số bị bỏ.
3. **Flush theo chu kỳ** (1–5 giây) → `detailsResultToObservations` → `ObservationRecorder.recordDetails` → `bulkWrite`.
4. **Backpressure thật**: buffer đầy thì bỏ frame và đếm, KHÔNG để hàng đợi phình vô hạn.
5. Identity đi làn riêng, nhịp thưa hơn nhiều (message 5 ~6 phút/tàu).
6. Chỉ khi đó mới nối scheduler/bootstrap.

⛔ AIS-3 **không** làm: GeoJSON · MyShipTracking · bậc freshness `REALTIME` · sửa production.

---

*Audit thực hiện trên clone Soosky-marine-api nhánh mặc định. Không sửa file nào của production.*
