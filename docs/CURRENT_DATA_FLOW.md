# Luồng dữ liệu hiện tại — Crawl-Marine-Bot

> **Dữ liệu đi từ đâu tới đâu, field nào do ai ghi, ai ghi đè ai.**
> Bổ trợ cho [CURRENT_ARCHITECTURE.md](./CURRENT_ARCHITECTURE.md).
>
> §1–§8 là **ảnh chụp audit A0** (commit `937d664`) — mô tả đường **legacy** vẫn đang chạy production. Số mục giữ nguyên vì nhiều tài liệu và comment trong code đang trỏ tới (`§2.3`, `§3`, `§8`).
> §9 là **cập nhật** sau khi Phase 6/7 thêm đường observation đa nguồn.

---

## 0. Bản đồ một trang

```mermaid
flowchart LR
  subgraph SRC["NGUỒN"]
    VF["VesselFinder<br/>HTML + mp2 binary"]
    SI["ShipInfo<br/>(P6)"]
    SF["ShipFinder<br/>(P7)"]
  end

  subgraph LEG["ĐƯỜNG LEGACY — production"]
    UC["4 use case"]
    OLD[("vessels<br/>latestpositions<br/>vesselpositions")]
    API["GET /positions"]
  end

  subgraph NEW["ĐƯỜNG OBSERVATION — POC gọi tay"]
    PROV["Provider (P3)"]
    RT["Runtime (P4)"]
    REC["Recorder (P5)"]
    OBS[("vessel_observations")]
  end

  VF --> UC --> OLD --> API
  VF -.chưa nối.-> PROV
  SI --> PROV
  SF --> PROV
  PROV --> RT --> REC --> OBS
  OBS -.chưa có.-> RES["RESOLVER"]

  style LEG fill:#1e3a2f,stroke:#22c55e,color:#dbe7f2
  style NEW fill:#1e2a3a,stroke:#2fa8ff,color:#dbe7f2
  style RES fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
```

**Hai đường không giao nhau.** Legacy ghi đè theo `mmsi`; observation append-only, giữ mọi nguồn. Không dòng code nào so sánh chúng — đó là việc của resolver, **chưa tồn tại**.

---

## 1. Bốn đường ghi dữ liệu (đường cũ)

```mermaid
flowchart TD
  W1["W1 · ScanArea<br/><i>npm run scan</i>"] -->|mp2 binary| D1{"vessel đã tồn tại?"}
  D1 -->|chưa| SV1["saveVessel"]
  D1 -->|rồi| SKIP["bỏ qua lý lịch"]
  SV1 --> LP["savePositionLatest"]
  SKIP --> LP

  W2["W2 · EnrichVesselTypes<br/><i>npm run enrich</i>"] -->|HTML details| SV2["saveVessel<br/>(luôn đè)"] --> LP

  W3["W3 · CrawlFleetPositions<br/><i>scheduler / npm run crawl</i>"] -->|HTML details| SV3["saveVessel"] --> HIST["savePosition<br/>(history)"]
  W4["W4 · GetVesselDetails<br/><i>GET /vessel/:id</i>"] -->|HTML details| SV4["saveVessel"] --> HIST

  LP --> C2[("latestpositions")]
  HIST --> C3[("vesselpositions")]
  SV1 & SV2 & SV3 & SV4 --> C1[("vessels")]

  W5["W5 · CleanupStalePositions<br/><i>scheduler</i>"] -.xoá bản ghi quá hạn.-> C2

  style W5 fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
```

| # | Đường | Trigger | `vessels` | `vesselpositions` | `latestpositions` |
|---|---|---|---|---|---|
| W1 | `ScanArea.saveShips()` | `npm run scan` (loop) | ✅ chỉ khi **chưa tồn tại** | ❌ | ✅ |
| W2 | `EnrichVesselTypes.runOnce()` | `npm run enrich` (loop) | ✅ luôn đè | ❌ | ✅ |
| W3 | `CrawlFleetPositions.execute()` | scheduler / `npm run crawl` | ✅ luôn | ✅ | ⚠️ xem dưới |
| W4 | `GetVesselDetails.execute()` | `GET /vessel/:id` (cache miss) | ✅ luôn | ✅ | ⚠️ xem dưới |
| W5 | `CleanupStalePositions.execute()` | scheduler | ❌ giữ | ❌ giữ | 🗑️ xoá quá hạn |

### ⚠️ Hai adapter của cùng một port hành xử KHÁC NHAU

```mermaid
flowchart LR
  CALL["use case gọi<br/>savePosition()"] --> M["MongoVesselRepository"]
  CALL --> J["JsonFileVesselRepository"]
  CALL --> I["InMemoryVesselRepository"]

  M --> MH[("vesselpositions")]
  M -.->|KHÔNG| MLP[("latestpositions")]
  J --> JH[("positions.json")]
  J -->|CÓ, gián tiếp| JLP[("latest_positions.json")]
  I --> IH[("history RAM")]

  style MLP fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
```

Hệ quả thật: **chạy Mongo thì tàu trong watchlist (W3/W4) không hiện lên bản đồ** trừ khi cũng được `ScanArea`/`EnrichVesselTypes` chạm tới. Chạy JSON thì có. Chênh lệch ngữ nghĩa giữa các adapter của cùng một port.

---

## 2. Trường nào đến từ nguồn nào

```mermaid
flowchart LR
  MP2["mp2 binary<br/>/api/pub/mp2"] --> F4["mmsi · name<br/>lat · lon<br/><b>chính xác</b>"]
  HTML["HTML details<br/>/vessels/details/:id"] --> FA["name · imo · mmsi<br/>type · callsign · country<br/>length · width · draught"]
  HTML --> FB["lat · lon <b>làm tròn</b><br/>speed · course<br/>navStatusText · positionTime"]

  F4 --> CANON["entity Vessel / VesselPosition"]
  FA --> CANON
  FB --> CANON

  NEVER["flagCode · yearBuilt<br/>grossTonnage · deadweight · photoUrl<br/>headingDeg · navStatusCode<br/>destination · eta"] -.->|KHÔNG nguồn nào ghi| CANON

  style NEVER fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
```

### 2.1 mp2 binary — đúng **4** field
`mmsi`, `name`, `lat`, `lon` ([IAreaScanner.ts:9-14](../src/application/ports/IAreaScanner.ts#L9-L14)).
Decoder đọc thêm 1 int16 cờ và 1 int8 status nhưng **bỏ qua cả hai**. `name` rỗng → fallback `String(mmsi)`. Toạ độ `int32 / 600000`, **chính xác** → `latLonApproximate: false`.

### 2.2 Trang HTML chi tiết

| Field domain | Nguồn trong HTML |
|---|---|
| `name` | `<h1 class="title">` |
| `imo`, `mmsi` | ô bảng `"IMO / MMSI"`, fallback `#djson.imo/.mmsi` |
| `type` · `callsign` · `country` | ô `"AIS Type"` · `"Callsign"` · `"AIS Flag"` |
| `lengthM`, `widthM` | ô `"Length / Beam"` regex `([\d.]+)/([\d.]+)` |
| `draughtM` | ô `"Current draught"` |
| `lat`, `lon` | `#djson.ship_lat/ship_lon` — **làm tròn** → `latLonApproximate: true` |
| `speedKn` · `courseDeg` | `#djson.ship_sog` · `#djson.ship_cog` |
| `navStatusText` | ô `"Navigation Status"`, default `"Unknown"` |
| `positionTime` | `#djson.lrpd` — **chuỗi thô** `"0 min ago"`, không parse thành thời gian |
| `source` | hardcode `"vesselfinder"` |

Không có cả `imo` lẫn `mmsi` → mapper **throw** → bọc thành `E-2002`.

### 2.3 Trường CÓ trong schema nhưng KHÔNG nguồn nào ghi

`flagCode`, `yearBuilt`, `grossTonnage`, `deadweight`, `photoUrl` (vessels);
`headingDeg`, `navStatusCode`, `destination`, `eta` (positions).

`destination`/`eta` được `EnrichVesselTypes` **đọc và chuyển tiếp** nhưng mapper không bao giờ set → luôn `null`.

---

## 3. Ai ghi đè ai

Chỉ có **một** cơ chế: `savePositionLatest` = `replaceOne(..., upsert:true)` theo `mmsi` → **thay toàn bộ document**, không merge field.

```mermaid
sequenceDiagram
  autonumber
  participant MP2 as mp2 (ScanArea)
  participant HTML as HTML details (Enrich)
  participant LP as latestpositions

  MP2->>LP: replaceOne(mmsi)
  Note over LP: lat/lon CHÍNH XÁC<br/>speed/course = null

  HTML->>LP: getLatestPosition(mmsi)
  Note over HTML: MERGE thủ công<br/>lat/lon ← existing (mp2)<br/>speed/course/navStatus ← HTML
  HTML->>LP: replaceOne(mmsi) — doc đầy đủ

  MP2->>LP: vòng scan kế tiếp<br/>replaceOne(mmsi) — KHÔNG đọc existing
  Note over LP: ⚠️ speed/course/navStatus<br/>vừa enrich BỊ XOÁ về null
```

| | Đọc bản cũ trước khi ghi? | Hệ quả |
|---|---|---|
| `EnrichVesselTypes` | ✅ có ([:67](../src/application/use-cases/EnrichVesselTypes.ts#L67)) | Bảo toàn toạ độ mp2 |
| `ScanArea.saveShips()` | ❌ **không** ([:74-82](../src/application/use-cases/ScanArea.ts#L74-L82)) | **Mọi field enrich bị mất** ở vòng scan kế tiếp |

Với `vessels` thì ngược lại, không mất dữ liệu: `ScanArea` chỉ `saveVessel` khi `findVesselByMmsi()` trả `null`. Nhưng `MongoVesselRepository.saveVessel()` dùng `$set: {...vessel}` với entity đã normalize mọi field thiếu thành `null` → khi W2/W3/W4 chạy, **mọi field entity đều được set**, kể cả `null`.

---

## 4. Đường đọc — `GET /positions`

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant A as createApp /positions
  participant R as IVesselRepository
  participant DB as MongoDB

  B->>A: GET /positions?bbox=minLon,minLat,maxLon,maxLat&limit=N
  Note over A: limit = min(floor(N), 5000), mặc định 3000<br/>freshSince = now − positionStaleAfterMs (24h)
  alt có bbox hợp lệ (4 số)
    A->>R: getLatestPositionsInBbox(box, limit, freshSince)
    R->>DB: find({receivedAt ≥ iso, loc: $geoWithin $box}).limit()
  else không bbox
    A->>R: getAllLatestPositions(freshSince)
    Note over A: .slice(0, limit) ở tầng HTTP
  end
  A->>R: getVesselsByMmsi(mmsi đang trả về)
  R->>DB: find({mmsi: {$in: [...]}})
  Note over A: join thủ công<br/>name/type/country/callsign/length/width/draught
  A-->>B: { count, positions: [...] }
```

### ⚠️ Ba quy ước toạ độ cùng tồn tại

```mermaid
flowchart LR
  ENV["SCAN_BBOX (.env)<br/><b>minLat,minLon,maxLat,maxLon</b>"] --> BOX["BoundingBox entity<br/>{minLat, minLon, maxLat, maxLon}"]
  QS["query string<br/><b>minLon,minLat,maxLon,maxLat</b>"] --> BOX
  BOX --> LOC["Mongo loc<br/><b>[lon, lat]</b>"]

  style QS fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
```

`.env` và query string **ngược thứ tự nhau**; Mongo `loc` lại là `[lon, lat]`. Đổi chỗ ngay tại [createApp.ts:102-106](../src/interfaces/http/createApp.ts#L102-L106).

`/positions` **không cần API key**; `/vessel/:id` và `/watchlist*` cần `X-API-Key`, so bằng `timingSafeEqual`.
Lọc "còn tươi" áp dụng **cả lúc đọc** (`freshSince`) lẫn lúc dọn (`CleanupStalePositions`) → hai lớp độc lập.

---

## 5. Vòng đời một bản ghi vị trí

```mermaid
stateDiagram-v2
  [*] --> Scanned: ScanArea<br/>mp2 → chỉ mmsi/name/lat/lon
  Scanned --> Enriched: EnrichVesselTypes<br/>vessel.type == null<br/>+ speed/course/navStatus
  Enriched --> Scanned: ⚠️ vòng scan kế tiếp ghi đè<br/>(mất speed/course)
  Scanned --> Stale: receivedAt < now − 24h
  Enriched --> Stale: receivedAt < now − 24h
  Stale --> Hidden: GET /positions lọc bỏ (freshSince)
  Hidden --> [*]: CleanupStalePositions xoá khỏi latestpositions

  note right of [*]
    vessels + vesselpositions KHÔNG bị xoá.
    Vessel ở lại vĩnh viễn, kể cả khi
    không còn vị trí nào.
  end note
```

Điều kiện để một tàu được enrich: `getVesselsMissingType(limit)` → `vessels` có `type` là `null` / không tồn tại / chuỗi rỗng.
→ **Tàu đã có `type` không bao giờ được enrich lại**, kể cả khi speed/course đã bị vòng scan xoá về `null`.

---

## 6. Luồng cache — chỉ một đường duy nhất

```mermaid
flowchart TD
  A["GET /vessel/:id"] --> B{"regex ^\d{7,9}$"}
  B -->|fail| E1["E-1003 → HTTP 400"]
  B -->|ok| C["cache.get('vessel:{id}')"]
  C -->|hit| D["trả { ...cached, fromCache: true }"]
  C -->|miss| F["detailsSource.getDetails(id)"]
  F --> G["repo.saveVessel + repo.savePosition"]
  G --> H["cache.set(key, details, cacheTtlMs)"]
  H --> I["trả { ...details, fromCache: false }"]
  F -->|lỗi| E2["errorStatus(): 404 / 502"]

  style E1 fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
  style E2 fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
```

- Key: `vessel:{id}` — **id nguyên văn người gọi truyền vào**. Cùng một tàu tra bằng IMO và bằng MMSI tạo **2 entry cache khác nhau**.
- TTL: `CACHE_TTL_MS` (60s mặc định).
- **Không có invalidate**: `ICache` không có `del`. Ghi DB ở W1–W3 không làm cache cũ hết hiệu lực.
- Redis lỗi → `catch` trả `null` = cache miss, request vẫn chạy.

---

## 7. Nguồn sự thật của từng trường (đường cũ)

| Field | Nguồn ghi cuối thường gặp | Ghi đè bởi | Ổn định? |
|---|---|---|---|
| `vessels.mmsi` | W1 (scan) | không (khoá) | ✅ |
| `vessels.name` | W1 rồi W2 | W2/W3/W4 | ✅ |
| `vessels.type/callsign/country/length/width/draught` | W2 (enrich) | W3/W4 | ✅ không bị scan đè |
| `vessels.imo` | W2 | W3/W4 | ✅ |
| `latestpositions.lat/lon` | W1 (mp2, chính xác) | W2 giữ nguyên | ✅ |
| `latestpositions.latLonApproximate` | W1 = `false` | W2 giữ nguyên | ✅ |
| `latestpositions.speedKn/courseDeg/navStatusText` | W2 (HTML) | ⚠️ **W1 xoá về null mỗi vòng scan** | ❌ |
| `latestpositions.destination/eta/headingDeg/navStatusCode` | không ai ghi | — | luôn `null` |
| `latestpositions.receivedAt` | mọi write, ISO string `now()` | — | ✅ |
| `vesselpositions.*` | chỉ W3/W4 | append-only | ✅ nhưng thưa |

---

## 8. Ba câu hỏi mà luồng cũ KHÔNG trả lời được

```mermaid
flowchart TD
  Q1["Field nào đến từ nguồn nào?"] --> A1["❌ `source` là MỘT chuỗi<br/>cho cả document, không per-field"]
  Q2["Hai nguồn bất đồng thì ai thắng?"] --> A2["❌ ai ghi sau thắng<br/>trừ 1 exception hardcode trong EnrichVesselTypes"]
  Q3["Làm sao biết nguồn đang xuống cấp?"] --> A3["❌ không metric nào<br/>parse fail bị nuốt, desync chỉ warn"]

  A1 & A2 & A3 --> FIX["→ Phase 1–5 dựng câu trả lời<br/>(§9)"]

  style A1 fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
  style A2 fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
  style A3 fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
  style FIX fill:#1e3a2f,stroke:#22c55e,color:#dbe7f2
```

Chi tiết technical debt: [CURRENT_ARCHITECTURE.md §6](./CURRENT_ARCHITECTURE.md).

---

## 9. Cập nhật sau giai đoạn 6/7 — đường observation

> §1–§8 vẫn **đúng nguyên** cho đường legacy. Phần này mô tả đường **song song** đã thêm.

### 9.1 Đường đi đầy đủ

```mermaid
flowchart TD
  ID["VesselIdentifier<br/>MMSI hoặc IMO"] --> UC["CollectVesselObservations"]
  UC --> REG["ProviderRegistry (P3)<br/>tra provider theo source"]
  REG --> EX["SourceRequestExecutor (P4)"]

  subgraph P4["Runtime P4 — mỗi nguồn một bộ"]
    G1["cổng cooldown"] --> G2["hàng đợi + nhịp jitter"]
    G2 --> G3["timeout"] --> G4["phân loại lỗi"] --> G5["retry?"] --> G6["cập nhật health"]
  end

  EX --> P4
  P4 --> PV["Provider: Client → Parser → Mapper"]
  PV --> PR["ProviderResult<br/>identity? particulars? position? voyage?"]
  PR --> REC["ObservationRecorder (P5)"]

  subgraph P5["Recorder P5"]
    V["validate"] --> FP["fingerprint"] --> DD["dedupe theo cửa sổ"]
  end

  REC --> P5 --> DB[("vessel_observations")]
  DB -.CHƯA CÓ.-> RES["Resolver / merge"]

  style RES fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
```

### 9.2 Khác biệt cốt lõi so với đường cũ

```mermaid
flowchart LR
  subgraph L["latestpositions — legacy"]
    LK["khoá: mmsi UNIQUE"] --> LW["replaceOne → last-write-wins"]
    LW --> LR["1 tàu = 1 dòng<br/>nguồn sau XOÁ nguồn trước"]
  end

  subgraph O["vessel_observations — mới"]
    OK["khoá: không unique"] --> OW["insert → append-only"]
    OW --> OR["1 tàu = n dòng<br/>mỗi nguồn/nhóm/lần một bản ghi"]
  end

  style L fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
  style O fill:#1e3a2f,stroke:#22c55e,color:#dbe7f2
```

| | legacy | observation |
|---|---|---|
| Ngữ nghĩa | "hệ thống tin là vậy" | "nguồn nói vậy" |
| Xung đột | bị xoá | **cùng tồn tại** |
| Provenance | `source` 1 chuỗi/document | `SourceMetadata` mỗi nhóm |
| Mốc thời gian | `receivedAt` chuỗi ISO | `fetchedAt` (bot) **tách khỏi** `sourceReceivedAt` (nguồn) |
| Ghi | ghi đè | bất biến |

### 9.3 Ba nguồn hiện có — đo thật

```mermaid
flowchart LR
  VF["VesselFinder<br/>legacy, chưa qua P4"] --> OLD[("vessels<br/>latestpositions<br/>vesselpositions")]
  SI["ShipInfo<br/>JSON nhúng<br/>vị trí ~14 GIỜ"] --> OBS[("vessel_observations")]
  SF["ShipFinder<br/>HTML server-render<br/>vị trí ~6 PHÚT"] --> OBS

  style VF fill:#1e3a2f,stroke:#22c55e,color:#dbe7f2
  style SI fill:#1e2a3a,stroke:#2fa8ff,color:#dbe7f2
  style SF fill:#1e2a3a,stroke:#2fa8ff,color:#dbe7f2
```

| | ShipInfo | ShipFinder |
|---|---|---|
| Tuổi vị trí (đo thật) | **~14 giờ** (khoá có chủ ý) | **~6 phút** |
| `heading` / `navStatus` / `draught` | ❌ | ✅ |
| `destination` | ❌ | ✅ |
| `length` / `beam` | ⛔ đảo không nhất quán → không map | ✅ đúng chiều |
| `builtYear` / `deadweight` | ✅ | ❌ (sau API ký chữ ký) |
| Lookup | MMSI + IMO | **chỉ MMSI** |
| Mốc thời gian | tự suy offset từ `updated_utc` | ⚠️ **giả định vận hành** phải khai qua env |

Chi tiết: [SHIPINFO_POC.md](./sources/SHIPINFO_POC.md) · [SHIPFINDER_POC.md](./sources/SHIPFINDER_POC.md)

### 9.4 Ba câu hỏi ở §8 — giờ trả lời được

```mermaid
flowchart LR
  Q1["Field nào từ nguồn nào?"] --> A1["✅ mỗi observation<br/>một nguồn, không trộn"]
  Q2["Hai nguồn bất đồng?"] --> A2["✅ cả hai còn nguyên<br/>trong vessel_observations"]
  Q3["Nguồn xuống cấp?"] --> A3["✅ SourceHealthSnapshot<br/>đếm theo từng loại lỗi"]

  A2 --> R["⚠️ nhưng CHƯA AI phân xử<br/>— resolver chưa tồn tại"]

  style A1 fill:#1e3a2f,stroke:#22c55e,color:#dbe7f2
  style A2 fill:#1e3a2f,stroke:#22c55e,color:#dbe7f2
  style A3 fill:#1e3a2f,stroke:#22c55e,color:#dbe7f2
  style R fill:#3a1e1e,stroke:#ef4444,color:#dbe7f2
```

### 9.5 Điều gì CHƯA thay đổi

- Legacy crawler VesselFinder **chạy y nguyên** — chưa migrate sang P4, `latestpositions` vẫn last-write-wins, `ScanArea` vẫn xoá field enrich mỗi vòng (§3).
- ShipInfo/ShipFinder **không ghi một byte nào** vào `vessels`/`latestpositions`/`vesselpositions` — đã kiểm sau POC live.
- `GET /positions` vẫn đọc **duy nhất** từ `latestpositions` legacy; observation chưa phục vụ API nào.
- **Không có resolver, không merge, không source scoring, không fallback.**
