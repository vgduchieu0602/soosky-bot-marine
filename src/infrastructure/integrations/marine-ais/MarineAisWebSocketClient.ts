// ============================================================================
//  INFRASTRUCTURE · MarineAisWebSocketClient — cầu nối tới WS NỘI BỘ của Marine
// ----------------------------------------------------------------------------
//      Soosky-marine-api  ws://<host>:<port>/ais-stream
//            ↓
//      MarineAisWebSocketClient   ← file này
//            ↓  JSON.parse → isMarineAisMessage → mapMarineAisMessage
//      emit("normalizedData", { result, receivedAt, mmsi, type })
//
//  ⛔ Bot KHÔNG mở connection tới wss://stream.aisstream.io. Production là chủ
//     sở hữu DUY NHẤT của kết nối đó; ở đây có cả cổng chặn URL (§ guardUrl).
//
//  Trách nhiệm CHỈ có: connect · receive · parse · validate · map · emit.
//  KHÔNG Mongo · KHÔNG ObservationRecorder · KHÔNG resolver · KHÔNG scheduler ·
//  KHÔNG coalescing · KHÔNG giữ lịch sử frame.
//
//  ⚠️ BACKPRESSURE: toàn bộ đường xử lý một frame là ĐỒNG BỘ và nhẹ. Listener
//     của `normalizedData` BẮT BUỘC cũng phải không chặn — stream AIS toàn cầu
//     là hàng nghìn frame/giây, một `await` chậm trong listener sẽ dồn ứ ngay ở
//     socket. Ghi DB có mẻ là việc của AIS-3, không phải của listener trực tiếp.
// ============================================================================

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { ProviderDetailsResult } from "../../../application/contracts/providers/ProviderResults";
import {
  MarineAisRejectReason,
  mapMarineAisMessage,
} from "./MarineAisMessageMapper";
import {
  MarineAisMessage,
  MarineAisMessageType,
  isMarineAisMessage,
} from "./MarineAisTypes";

// ---------------------------------------------------------------------------
//  Sự kiện
// ---------------------------------------------------------------------------

export const MarineAisClientEvent = {
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  /** Một message đã map được sang canonical. */
  NORMALIZED_DATA: "normalizedData",
  /** Một frame bị loại — KHÔNG phải lỗi kết nối. Stream vẫn chạy tiếp. */
  REJECTED_MESSAGE: "rejectedMessage",
  ERROR: "error",
} as const;

export type MarineAisClientEvent =
  (typeof MarineAisClientEvent)[keyof typeof MarineAisClientEvent];

export const MarineAisLifecycleState = {
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  RECONNECTING: "RECONNECTING",
  STOPPING: "STOPPING",
  STOPPED: "STOPPED",
} as const;

export type MarineAisLifecycleState =
  (typeof MarineAisLifecycleState)[keyof typeof MarineAisLifecycleState];

/**
 * Lý do loại ở mức FRAME — trước khi mapper được gọi.
 * Tách khỏi `MarineAisRejectReason` (mức nội dung) vì hai loại này chỉ ra hai
 * vấn đề khác hẳn nhau: hỏng ĐƯỜNG TRUYỀN/HỢP ĐỒNG vs. tàu phát dữ liệu rác.
 */
export const MarineAisFrameRejectReason = {
  /** Không phải JSON. */
  MALFORMED_JSON: "MALFORMED_JSON",
  /** JSON hợp lệ nhưng không đúng hình dạng `AisMessage` của production. */
  CONTRACT_MISMATCH: "CONTRACT_MISMATCH",
} as const;

export type MarineAisFrameRejectReason =
  (typeof MarineAisFrameRejectReason)[keyof typeof MarineAisFrameRejectReason];

export type MarineAisRejectionReason = MarineAisFrameRejectReason | MarineAisRejectReason;

export interface MarineAisRejection {
  readonly reason: MarineAisRejectionReason;
  /** Mô tả ngắn, ĐÃ cắt độ dài. Không mang cả frame. */
  readonly detail?: string;
}

/**
 * Payload của `normalizedData`.
 *
 * ⚠️ KHÔNG kèm frame thô. Giữ frame lại là cách nhanh nhất để một stream toàn
 * cầu ăn hết RAM (§19 của yêu cầu).
 */
export interface MarineAisNormalizedEvent {
  /** Đúng kiểu 3 provider pull đang dùng -> vào thẳng pipeline observation. */
  readonly result: ProviderDetailsResult;
  /** Đồng hồ BOT lúc frame tới. Đã được truyền vào mapper. */
  readonly receivedAt: Date;
  /** Khoá tàu, rút sẵn để listener AIS-3 gom nhóm mà không phải mở `result`. */
  readonly mmsi: string;
  readonly type: MarineAisMessageType;
}

// ---------------------------------------------------------------------------
//  Đếm
// ---------------------------------------------------------------------------

export interface MarineAisClientStats {
  /** Mọi frame nhận được, kể cả rác. */
  readonly receivedFrames: number;
  /** Frame qua được `isMarineAisMessage`. */
  readonly validMessages: number;
  readonly mappingSuccess: number;
  readonly mappingRejected: number;
  readonly malformedJson: number;
  readonly contractMismatch: number;
  /**
   * Frame chào của server (`{"message":"Connected to ..."}`) — production gửi
   * ĐÚNG MỘT cái ngay sau mỗi lần connect. Đếm riêng, KHÔNG tính vào
   * `contractMismatch`, nếu không mỗi lần reconnect lại báo động giả.
   */
  readonly serverNotices: number;
  /** Số lần LÊN LỊCH kết nối lại (không phải số lần kết nối thành công). */
  readonly reconnects: number;
  readonly connections: number;
  readonly rejectionsByReason: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
//  Cấu hình
// ---------------------------------------------------------------------------

export interface MarineAisWebSocketClientLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface MarineAisWebSocketClientOptions {
  /** `ws://host:port/ais-stream`. Không hardcode ở đâu khác. */
  url: string;
  /** Đồng hồ tiêm được — mapper cần mốc `receivedAt` tất định khi test. */
  now?: () => Date;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconnectBackoffFactor?: number;
  reconnectJitterRatio?: number;
  random?: () => number;
  /** Trần chờ close handshake trước khi `terminate()`. */
  closeTimeoutMs?: number;
  /**
   * Không nhận được frame nào trong ngần này ms -> coi connection đã chết, tự
   * `terminate()` để kích hoạt reconnect.
   *
   * ⚠️ MẶC ĐỊNH TẮT (`undefined`), và đó là chủ ý. Audit cho thấy WS nội bộ của
   * Marine **không hề ping** client (`Server._initInternalWss` chỉ có
   * connection/close/error), nên một socket half-open sẽ im lặng vĩnh viễn mà
   * `close` không bao giờ tới. Người vận hành muốn lưới đó thì bật tường minh —
   * đặt ngưỡng sai sẽ tự ngắt một connection đang khoẻ.
   */
  staleConnectionTimeoutMs?: number;
  logger?: MarineAisWebSocketClientLogger;
}

interface ResolvedOptions {
  url: string;
  now: () => Date;
  initialReconnectDelayMs: number;
  maxReconnectDelayMs: number;
  reconnectBackoffFactor: number;
  reconnectJitterRatio: number;
  random: () => number;
  closeTimeoutMs: number;
  staleConnectionTimeoutMs?: number;
  logger: MarineAisWebSocketClientLogger;
}

const DEFAULTS = {
  initialReconnectDelayMs: 1_000,
  maxReconnectDelayMs: 30_000,
  reconnectBackoffFactor: 2,
  closeTimeoutMs: 5_000,
} as const;

/** Cắt chuỗi mô tả để log/sự kiện không bao giờ mang cả frame. */
const MAX_DETAIL_LENGTH = 120;

// ---------------------------------------------------------------------------
//  Cổng chặn URL
// ---------------------------------------------------------------------------

/**
 * Host của nhà cung cấp AIS. Bot **không được** nối thẳng: production là chủ sở
 * hữu duy nhất của connection đó, mở cái thứ hai là tiêu thêm hạn mức của gói
 * và phá đúng ranh giới mà cả phase AIS-1/AIS-2 dựng lên.
 */
const FORBIDDEN_HOST_SUFFIX = "aisstream.io";

/**
 * @throws Error khi URL không phải ws/wss, hoặc trỏ thẳng tới nhà cung cấp AIS.
 *         Fail fast lúc DỰNG object — không để tới lúc `start()` mới lộ.
 */
export function assertMarineAisUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`MARINE_AIS_WS_URL không phải URL hợp lệ: "${url}"`);
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `MARINE_AIS_WS_URL phải dùng ws:// hoặc wss://, nhận "${parsed.protocol}"`
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === FORBIDDEN_HOST_SUFFIX || hostname.endsWith(`.${FORBIDDEN_HOST_SUFFIX}`)) {
    throw new Error(
      `MARINE_AIS_WS_URL trỏ thẳng tới nhà cung cấp AIS ("${hostname}"). ` +
        "Bot chỉ được đọc WebSocket nội bộ của Soosky-marine-api; " +
        "production là chủ sở hữu duy nhất của kết nối AISStream."
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
//  Client
// ---------------------------------------------------------------------------

export class MarineAisWebSocketClient extends EventEmitter {
  private readonly options: ResolvedOptions;

  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs: number;
  private lifecycleState: MarineAisLifecycleState = MarineAisLifecycleState.STOPPED;
  private lastMessageAt: Date | null = null;
  /** `stop()` đã được gọi -> tuyệt đối không tự kết nối lại nữa. */
  private stopped = true;

  private stats = {
    receivedFrames: 0,
    validMessages: 0,
    mappingSuccess: 0,
    mappingRejected: 0,
    malformedJson: 0,
    contractMismatch: 0,
    serverNotices: 0,
    reconnects: 0,
    connections: 0,
  };
  private readonly rejectionsByReason = new Map<string, number>();
  /** Lý do đã log rồi -> không log lại. Log mỗi frame là tự sát với AIS toàn cầu. */
  private readonly loggedReasons = new Set<string>();

  constructor(options: MarineAisWebSocketClientOptions) {
    super();
    assertMarineAisUrl(options.url);

    this.options = {
      url: options.url,
      now: options.now ?? (() => new Date()),
      initialReconnectDelayMs:
        options.initialReconnectDelayMs ?? DEFAULTS.initialReconnectDelayMs,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? DEFAULTS.maxReconnectDelayMs,
      reconnectBackoffFactor:
        options.reconnectBackoffFactor ?? DEFAULTS.reconnectBackoffFactor,
      reconnectJitterRatio: options.reconnectJitterRatio ?? 0,
      random: options.random ?? Math.random,
      closeTimeoutMs: options.closeTimeoutMs ?? DEFAULTS.closeTimeoutMs,
      staleConnectionTimeoutMs: options.staleConnectionTimeoutMs,
      logger: options.logger ?? {
        info: (message) => console.log(message),
        warn: (message) => console.warn(message),
      },
    };
    this.reconnectDelayMs = this.options.initialReconnectDelayMs;
  }

  // ---- vòng đời -------------------------------------------------------------

  /**
   * Mở connection. Gọi nhiều lần là VÔ HẠI: đang CONNECTING/OPEN thì không mở
   * socket thứ hai — bot chỉ được có ĐÚNG MỘT connection tới Marine (§11).
   */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.openSocket();
  }

  /**
   * Đóng có chủ đích. Sau lệnh này KHÔNG có reconnect nào nữa, kể cả khi timer
   * đã được lên lịch từ trước.
   */
  async stop(): Promise<void> {
    if (this.stopped && this.socket === null) return;
    this.lifecycleState = MarineAisLifecycleState.STOPPING;
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearStaleTimer();

    const socket = this.socket;
    this.socket = null;
    if (socket === null) {
      this.lifecycleState = MarineAisLifecycleState.STOPPED;
      return;
    }

    // Gỡ listener TRƯỚC khi close: nếu không, handler `close` sẽ lại xếp lịch
    // reconnect cho một client vừa bị dừng.
    socket.removeAllListeners();

    if (socket.readyState === WebSocket.CLOSED) {
      this.emitSafe(MarineAisClientEvent.DISCONNECTED, { intentional: true });
      this.lifecycleState = MarineAisLifecycleState.STOPPED;
      return;
    }

    await new Promise<void>((resolve) => {
      // Lưới an toàn: server không đáp close handshake thì cắt thẳng.
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, this.options.closeTimeoutMs);
      timer.unref?.();

      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });

    this.options.logger.info("[marine-ais] đã dừng theo yêu cầu, không reconnect nữa.");
    this.lifecycleState = MarineAisLifecycleState.STOPPED;
    this.emitSafe(MarineAisClientEvent.DISCONNECTED, { intentional: true });
  }

  /** Đang có socket sống (CONNECTING hoặc OPEN). */
  isActive(): boolean {
    return (
      this.socket !== null &&
      (this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN)
    );
  }

  getStats(): MarineAisClientStats {
    return {
      ...this.stats,
      rejectionsByReason: Object.freeze(Object.fromEntries(this.rejectionsByReason)),
    };
  }

  getLifecycleState(): MarineAisLifecycleState {
    return this.lifecycleState;
  }

  getLastMessageAt(): Date | null {
    return this.lastMessageAt;
  }

  // ---- socket ---------------------------------------------------------------

  private openSocket(): void {
    if (this.stopped) return;
    // §11 — cổng chặn connection thứ hai.
    if (this.isActive()) return;

    this.clearReconnectTimer();

    this.lifecycleState = MarineAisLifecycleState.CONNECTING;

    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.stats.connections += 1;
      // Kết nối lại được -> trả backoff về mốc đầu, nếu không lần rớt sau sẽ
      // phải chờ 30s dù mạng đã ổn.
      this.reconnectDelayMs = this.options.initialReconnectDelayMs;
      this.lifecycleState = MarineAisLifecycleState.CONNECTED;
      this.armStaleTimer();
      this.options.logger.info(`[marine-ais] connected ${this.options.url}`);
      this.emitSafe(MarineAisClientEvent.CONNECTED, { url: this.options.url });
    });

    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (this.socket !== socket) return;
      this.handleFrame(data, isBinary);
    });

    socket.on("error", (error: Error) => {
      if (this.socket !== socket) return;
      // `ws` luôn phát `close` NGAY SAU `error`, nên lịch reconnect chỉ đặt ở
      // handler `close` — đặt cả hai chỗ sẽ nhân đôi timer.
      this.options.logger.warn(`[marine-ais] socket error: ${error.message}`);
      this.emitSafe(MarineAisClientEvent.ERROR, error);
    });

    socket.on("close", (code: number, reason: Buffer) => {
      if (this.socket !== socket) return;
      this.clearStaleTimer();
      this.socket = null;
      this.emitSafe(MarineAisClientEvent.DISCONNECTED, {
        intentional: false,
        code,
        reason: reason.toString().slice(0, MAX_DETAIL_LENGTH),
      });
      this.scheduleReconnect(`close code=${code}`);
    });
  }

  private scheduleReconnect(cause: string): void {
    if (this.stopped) return;
    // Single-flight: đã có timer thì không xếp thêm.
    if (this.reconnectTimer !== null) return;

    const delay = this.reconnectDelayMs;
    this.lifecycleState = MarineAisLifecycleState.RECONNECTING;
    this.stats.reconnects += 1;
    this.options.logger.info(`[marine-ais] ${cause} -> reconnect sau ${delay}ms`);

    const jitter = this.options.reconnectJitterRatio;
    const actualDelay = Math.max(1, Math.round(delay * (1 + ((this.options.random() * 2 - 1) * jitter))));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, actualDelay);
    this.reconnectTimer.unref?.();

    // Backoff có TRẦN: mạng hỏng lâu cũng không đẩy khoảng chờ lên vô hạn, mà
    // cũng không quay tight loop nện vào production.
    this.reconnectDelayMs = Math.min(
      this.options.maxReconnectDelayMs,
      Math.max(1, Math.round(delay * this.options.reconnectBackoffFactor))
    );
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // ---- lưới phát hiện connection chết ---------------------------------------

  private armStaleTimer(): void {
    const timeout = this.options.staleConnectionTimeoutMs;
    this.clearStaleTimer();
    if (timeout === undefined) return;

    this.staleTimer = setTimeout(() => {
      this.options.logger.warn(
        `[marine-ais] không có frame nào trong ${timeout}ms -> cắt để nối lại`
      );
      // `terminate()` (không phải `close()`) vì phía kia có thể đã chết hẳn và
      // sẽ không bao giờ đáp close handshake.
      this.socket?.terminate();
    }, timeout);
    this.staleTimer.unref?.();
  }

  private clearStaleTimer(): void {
    if (this.staleTimer === null) return;
    clearTimeout(this.staleTimer);
    this.staleTimer = null;
  }

  // ---- xử lý frame ----------------------------------------------------------

  /**
   * ⚠️ ĐỒNG BỘ từ đầu tới cuối, và phải giữ như vậy. Không `await`, không I/O.
   * Một frame rác KHÔNG bao giờ được làm chết socket — mọi nhánh hỏng đều kết
   * thúc bằng `recordRejection` rồi trả về.
   */
  private handleFrame(data: WebSocket.RawData, isBinary: boolean): void {
    this.stats.receivedFrames += 1;
    this.lastMessageAt = this.options.now();
    this.armStaleTimer();

    if (isBinary) {
      this.recordRejection(MarineAisFrameRejectReason.CONTRACT_MISMATCH, "binary frame", true);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch (error) {
      this.recordRejection(
        MarineAisFrameRejectReason.MALFORMED_JSON,
        (error as Error).message.slice(0, MAX_DETAIL_LENGTH),
        true
      );
      return;
    }

    // Frame chào của server — production gửi ngay sau mỗi lần connect. Đây là
    // hành vi ĐÃ BIẾT, không phải lệch hợp đồng.
    if (MarineAisWebSocketClient.isServerNotice(parsed)) {
      this.stats.serverNotices += 1;
      return;
    }

    if (!isMarineAisMessage(parsed)) {
      this.recordRejection(
        MarineAisFrameRejectReason.CONTRACT_MISMATCH,
        MarineAisWebSocketClient.describeShape(parsed),
        true
      );
      return;
    }

    this.stats.validMessages += 1;
    this.dispatch(parsed);
  }

  private dispatch(message: MarineAisMessage): void {
    const receivedAt = this.options.now();
    const mapped = mapMarineAisMessage(message, receivedAt);

    if (!mapped.ok) {
      this.stats.mappingRejected += 1;
      this.recordRejection(mapped.reason, undefined, false);
      return;
    }

    this.stats.mappingSuccess += 1;
    const group = mapped.result.position ?? mapped.result.identity;
    this.emitSafe(MarineAisClientEvent.NORMALIZED_DATA, {
      result: mapped.result,
      receivedAt,
      // `group` luôn tồn tại: mapper `ok` nghĩa là đã dựng được đúng một nhóm.
      mmsi: group?.mmsi ?? "",
      type: message.type,
    } satisfies MarineAisNormalizedEvent);
  }

  /**
   * `{"message":"Connected to Soosky Marine WebSocket Server!"}` —
   * `Server._initInternalWss` gửi frame này cho MỌI client vừa kết nối.
   * Nhận diện hẹp: có `message` dạng chuỗi, KHÔNG có `type`/`data`.
   */
  private static isServerNotice(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
      typeof record.message === "string" &&
      record.type === undefined &&
      record.data === undefined
    );
  }

  /** Mô tả hình dạng, KHÔNG phải nội dung — frame không được lọt vào log. */
  private static describeShape(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return `array(${value.length})`;
    if (typeof value !== "object") return typeof value;
    const keys = Object.keys(value as object).slice(0, 5).join(",");
    return `object{${keys}}`;
  }

  private recordRejection(
    reason: MarineAisRejectionReason,
    detail: string | undefined,
    countFrameLevel: boolean
  ): void {
    if (countFrameLevel) {
      if (reason === MarineAisFrameRejectReason.MALFORMED_JSON) this.stats.malformedJson += 1;
      if (reason === MarineAisFrameRejectReason.CONTRACT_MISMATCH) {
        this.stats.contractMismatch += 1;
      }
    }
    this.rejectionsByReason.set(reason, (this.rejectionsByReason.get(reason) ?? 0) + 1);

    // Log LẦN ĐẦU của mỗi lý do, không log lần sau. Số lần thật nằm ở getStats().
    if (!this.loggedReasons.has(reason)) {
      this.loggedReasons.add(reason);
      this.options.logger.warn(
        `[marine-ais] frame bị loại lần đầu: ${reason}${detail === undefined ? "" : ` (${detail})`}` +
          " — các lần sau chỉ đếm, xem getStats()."
      );
    }

    this.emitSafe(MarineAisClientEvent.REJECTED_MESSAGE, { reason, detail } satisfies MarineAisRejection);
  }

  /**
   * `EventEmitter` NÉM khi phát `error` mà không ai nghe. Với một client phải
   * sống sót qua mọi frame rác, đó là cách chết ngớ ngẩn nhất — nên bọc lại.
   */
  private emitSafe(event: MarineAisClientEvent, payload: unknown): void {
    if (event === MarineAisClientEvent.ERROR && this.listenerCount(event) === 0) return;
    this.emit(event, payload);
  }
}
