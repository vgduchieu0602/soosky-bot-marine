// ============================================================================
//  CONFIG · Cấu hình tập trung, đọc từ file .env
// ----------------------------------------------------------------------------
//  "dotenv/config" phải nạp TRƯỚC khi đọc process.env -> đặt ở dòng đầu tiên.
//  `loadConfig(env)` nhận env tường minh để test được, không đụng process.env.
//  Số sai (không phải số hữu hạn / ngoài phạm vi) -> THROW ngay lúc khởi động,
//  thay vì lặng lẽ chạy với NaN.
// ============================================================================

import "dotenv/config";
import * as path from "path";
import { BoundingBox } from "../application/contracts/geo/Geo";

export interface AppConfig {
  dataDir: string;
  mongoUri: string;
  redisUrl: string;
  /** Địa chỉ bind của HTTP server. Mặc định loopback -> không lộ ra internet. */
  httpHost: string;
  httpPort: number;
  /** Khoá bắt buộc cho các route ghi/gọi upstream (header X-API-Key). */
  apiKey: string;
  cacheTtlMs: number;
  /** Vị trí mới nhất cũ hơn ngần này ms bị coi là hết hạn (không trả về nữa). */
  positionStaleAfterMs: number;
  /** Chu kỳ dọn vị trí mới nhất đã hết hạn. */
  positionCleanupEveryMs: number;
  crawlEveryMs: number;
  crawlDelayMs: number;
  scanMinMs: number;
  scanMaxMs: number;
  scanZoom: number;
  scanTileDelayMinMs: number; // nghỉ giữa 2 ô (chống ban)
  scanTileDelayMaxMs: number;
  scanSubdivideThreshold: number; // ô >= ngần này tàu -> chia 4
  scanMinTileDeg: number; // ngừng chia khi ô nhỏ hơn
  scanBlockCooldownMs: number; // bị chặn -> nghỉ dài
  enrichBatchSize: number;
  enrichDelayMs: number;
  enrichIntervalMs: number;
  watchlist: string[];
  scanBoundingBoxes: BoundingBox[];
  /**
   * Độ lệch múi giờ của mốc `Last update` trên ShipFinder, tính bằng PHÚT.
   *
   * ⚠️ KHÔNG CÓ MẶC ĐỊNH, và đó là chủ ý. ShipFinder KHÔNG khai báo múi giờ ở
   * bất kỳ đâu; audit P7.1 chỉ SUY LUẬN ra UTC+8 (=480) từ ba căn cứ gián tiếp.
   * Suy luận khác hợp đồng, nên đây là GIẢ ĐỊNH VẬN HÀNH mà người triển khai
   * phải khai tường minh qua `SHIPFINDER_SOURCE_UTC_OFFSET_MINUTES`.
   *
   * Không khai -> ShipFinder KHÔNG phát ra nhóm position (identity/particulars/
   * voyage vẫn ghi bình thường). Thà thiếu vị trí còn hơn gắn mốc sai hàng giờ.
   */
  shipFinderSourceUtcOffsetMinutes?: number;
  /**
   * WebSocket NỘI BỘ của Soosky-marine-api, dạng `ws://host:port/ais-stream`.
   *
   * ⛔ KHÔNG được trỏ tới `stream.aisstream.io`: production là chủ sở hữu duy
   * nhất của kết nối tới nhà cung cấp AIS. `MarineAisWebSocketClient` tự chặn
   * và ném ngay lúc dựng.
   *
   * Trống -> cầu AIS nằm im: không có gì tự kết nối. Ở phase AIS-2, chỉ POC gọi
   * tay (`npm run marine-ais:poc`) mới dùng tới nó.
   */
  marineAisWsUrl: string;
  /**
   * Chu kỳ gộp AIS, ms. Trong một cửa sổ, mỗi MMSI chỉ giữ vị trí MỚI NHẤT —
   * các điểm trung gian bị bỏ CÓ CHỦ Ý (buffer phục vụ map hiện tại, không
   * phải lịch sử hành trình).
   */
  aisCoalesceWindowMs: number;
  /**
   * Trần số tàu giữ trong RAM. Vượt -> đuổi tàu lâu nhất chưa đụng tới.
   * Đây là hàng rào bộ nhớ BẮT BUỘC, không phải tối ưu.
   */
  aisMaxBufferedVessels: number;
  /** Trần số tàu mỗi mẻ rút — để AIS-4 `bulkWrite` theo mẻ có kích thước biết trước. */
  aisFlushBatchSize: number;
  /** Số resolver canonical tối đa chạy đồng thời cho một mẻ AIS. */
  aisResolveConcurrency: number;
}

type Env = NodeJS.ProcessEnv;

export interface NumConstraints {
  min?: number;
  max?: number;
}

// --- tiện ích đọc biến môi trường có kiểu ---
function str(env: Env, name: string, fallback = ""): string {
  const v = env[name];
  return v !== undefined && v.trim() !== "" ? v : fallback;
}

/** Số hữu hạn trong phạm vi cho phép; sai -> throw kèm tên biến. */
function num(env: Env, name: string, fallback: number, constraints: NumConstraints = {}): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Config ${name} phải là số hữu hạn, nhận "${raw}".`);
  }
  const { min, max } = constraints;
  if (min !== undefined && value < min) {
    throw new Error(`Config ${name} phải >= ${min}, nhận ${value}.`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`Config ${name} phải <= ${max}, nhận ${value}.`);
  }
  return value;
}

/** Bắt buộc > 0 (khoảng thời gian, TTL, chu kỳ...). */
function positiveNum(env: Env, name: string, fallback: number): number {
  return num(env, name, fallback, { min: 1 });
}

function positiveInteger(env: Env, name: string, fallback: number): number {
  const value = positiveNum(env, name, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`Config ${name} phải là số nguyên dương, nhận ${value}.`);
  }
  return value;
}

/** Cho phép 0 (delay/batch có thể tắt bằng 0). */
function nonNegativeNum(env: Env, name: string, fallback: number): number {
  return num(env, name, fallback, { min: 0 });
}

/**
 * Số KHÔNG có mặc định: không đặt biến -> `undefined`, không phải 0.
 * Dùng cho giá trị mà "chưa khai" và "khai bằng 0" mang ý nghĩa KHÁC NHAU.
 */
function optionalNum(env: Env, name: string, constraints: NumConstraints = {}): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return num(env, name, Number.NaN, constraints);
}

// Đọc "WATCHLIST=9811983,305803000" -> ["9811983","305803000"]
function parseWatchlist(env: Env): string[] {
  return str(env, "WATCHLIST")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Đọc "SCAN_BBOX=1.0,103.0,1.6,104.5" -> 1 bounding box, hoặc nhiều vùng cách
// nhau bằng ";". ScanArea sẽ quét tuần tự từng vùng.
function parseBBox(env: Env): BoundingBox[] {
  return str(env, "SCAN_BBOX")
    .split(";")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.split(",").map((s) => Number(s.trim())))
    .filter((parts) => parts.length === 4 && parts.every((n) => !Number.isNaN(n)))
    .map(([minLat, minLon, maxLat, maxLon]) => ({ minLat, minLon, maxLat, maxLon }));
}

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    dataDir: path.join(__dirname, "..", "..", "data"),
    mongoUri: str(env, "MONGODB_URI"),
    redisUrl: str(env, "REDIS_URL"),
    // Mặc định chỉ nghe loopback: muốn public thì đặt reverse proxy phía trước.
    httpHost: str(env, "HTTP_HOST", "127.0.0.1"),
    httpPort: num(env, "PORT", 3000, { min: 1, max: 65535 }),
    // Không có mặc định: server HTTP tự từ chối khởi động nếu để trống.
    apiKey: str(env, "API_KEY"),
    cacheTtlMs: positiveNum(env, "CACHE_TTL_MS", 60_000),
    // Vị trí map cũ hơn ngần này -> ẩn khỏi API và bị dọn khỏi latest_positions.
    positionStaleAfterMs: positiveNum(env, "POSITION_STALE_AFTER_MS", 24 * 60 * 60 * 1000),
    positionCleanupEveryMs: positiveNum(env, "POSITION_CLEANUP_EVERY_MS", 60 * 60 * 1000),
    crawlEveryMs: positiveNum(env, "CRAWL_EVERY_MS", 2 * 60 * 60 * 1000),
    crawlDelayMs: nonNegativeNum(env, "CRAWL_DELAY_MS", 1500),
    // Scanner refreshes at a fixed, low operational frequency. It is not an
    // access-control bypass and must remain disabled if the source forbids use.
    scanMinMs: positiveNum(env, "SCAN_INTERVAL_MS", 6 * 60 * 60 * 1000),
    scanMaxMs: positiveNum(env, "SCAN_INTERVAL_MS", 6 * 60 * 60 * 1000),
    scanZoom: num(env, "SCAN_ZOOM", 9, { min: 0, max: 22 }),
    scanTileDelayMinMs: nonNegativeNum(env, "SCAN_TILE_DELAY_MS", 15_000),
    scanTileDelayMaxMs: nonNegativeNum(env, "SCAN_TILE_DELAY_MS", 15_000),
    scanSubdivideThreshold: positiveNum(env, "SCAN_SUBDIVIDE_THRESHOLD", 400),
    scanMinTileDeg: num(env, "SCAN_MIN_TILE_DEG", 1, { min: 0.01, max: 180 }),
    scanBlockCooldownMs: positiveNum(env, "SCAN_BLOCK_COOLDOWN_MS", 15 * 60 * 1000),
    // Bổ sung type/flag cho tàu quét từ mp2 (chỉ có mmsi) — tra chậm, batch nhỏ.
    // 0 = tắt enrich.
    enrichBatchSize: nonNegativeNum(env, "ENRICH_BATCH_SIZE", 15),
    enrichDelayMs: nonNegativeNum(env, "ENRICH_DELAY_MS", 2000),
    enrichIntervalMs: positiveNum(env, "ENRICH_INTERVAL_MS", 5 * 60 * 1000),
    watchlist: parseWatchlist(env),
    scanBoundingBoxes: parseBBox(env),
    // Giả định vận hành, không phải hợp đồng của nguồn. Phạm vi múi giờ thật:
    // -12h..+14h.
    shipFinderSourceUtcOffsetMinutes: optionalNum(env, "SHIPFINDER_SOURCE_UTC_OFFSET_MINUTES", {
      min: -12 * 60,
      max: 14 * 60,
    }),
    // Không có mặc định, và KHÔNG hardcode hostname production ở bất kỳ đâu.
    marineAisWsUrl: str(env, "MARINE_AIS_WS_URL"),
    aisCoalesceWindowMs: positiveNum(env, "AIS_COALESCE_WINDOW_MS", 10_000),
    aisMaxBufferedVessels: positiveNum(env, "AIS_MAX_BUFFERED_VESSELS", 50_000),
    aisFlushBatchSize: positiveNum(env, "AIS_FLUSH_BATCH_SIZE", 500),
    aisResolveConcurrency: positiveInteger(env, "AIS_RESOLVE_CONCURRENCY", 10),
  };
}

export const config: AppConfig = loadConfig();
