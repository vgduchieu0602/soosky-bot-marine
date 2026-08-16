// ============================================================================
//  APPLICATION · Phân loại lỗi nguồn — MỘT bảng cho mọi nguồn
// ----------------------------------------------------------------------------
//  Audit A0 (D-6) ghi nhận: `ScanArea` và `EnrichVesselTypes` đang so
//  `e.code === "E-2001"` bằng chuỗi thô. Nguồn mới phải "nhớ ném đúng chuỗi"
//  thì backoff mới chạy — đó là hợp đồng ngầm, không kiểm tra được.
//
//  Ở đây phân loại một lần, runtime chỉ làm việc với `SourceErrorCategory`.
//
//  ⚠️ GIỚI HẠN CÓ THẬT của mã lỗi cũ (AppError):
//    • E-2001 dùng cho CẢ 403 lẫn 429 -> không tách được BLOCKED / RATE_LIMITED
//    • E-2002 dùng cho CẢ lỗi mạng, HTTP non-ok, LẪN parse fail
//  Nên: provider MỚI hãy ném lỗi có `status` (số HTTP) hoặc dùng `parseError()` /
//  `networkError()` bên dưới. Đừng dựa vào AppError để phân loại chính xác.
// ============================================================================

import { VesselSource } from "../../../domain/enums/VesselSource";

export const SourceErrorCategory = {
  /** Nguồn trả lời rõ ràng "không có tàu này". KHÔNG phải nguồn hỏng. */
  NOT_FOUND: "NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  /** 403 — bị chặn. */
  BLOCKED: "BLOCKED",
  /** 429 — vượt hạn mức. */
  RATE_LIMITED: "RATE_LIMITED",
  /** 5xx — lỗi phía nguồn. */
  SERVER_ERROR: "SERVER_ERROR",
  /** DNS/TCP/TLS hỏng, không tới được nguồn. */
  NETWORK_ERROR: "NETWORK_ERROR",
  /** Tới được nguồn, tải được, nhưng bóc không ra (đổi form HTML/binary). */
  PARSE_ERROR: "PARSE_ERROR",
  UNKNOWN: "UNKNOWN",
} as const;

export type SourceErrorCategory =
  (typeof SourceErrorCategory)[keyof typeof SourceErrorCategory];

export const SOURCE_ERROR_CATEGORIES: readonly SourceErrorCategory[] = Object.freeze(
  Object.values(SourceErrorCategory) as SourceErrorCategory[]
);

/** Lỗi đã phân loại, kèm nguồn và số lần đã thử. */
export class SourceRequestError extends Error {
  readonly category: SourceErrorCategory;
  readonly source: VesselSource;
  /** Số lần THỰC SỰ đã gọi (1 = không retry lần nào). */
  readonly attempts: number;
  readonly cause?: unknown;

  constructor(props: {
    category: SourceErrorCategory;
    source: VesselSource;
    message: string;
    attempts?: number;
    cause?: unknown;
  }) {
    super(props.message);
    this.name = "SourceRequestError";
    this.category = props.category;
    this.source = props.source;
    this.attempts = props.attempts ?? 1;
    this.cause = props.cause;
  }
}

/**
 * Nguồn KHÔNG được phép gọi lúc này — cổng chặn phía ta, chưa hề chạm mạng.
 * Tách khỏi `SourceRequestError` vì đây không phải lỗi của nguồn: đếm nó vào
 * chuỗi hỏng sẽ làm cooldown tự kéo dài vô hạn.
 */
export class SourceUnavailableError extends Error {
  readonly code: "SOURCE_COOLDOWN" | "SOURCE_DISABLED";
  readonly source: VesselSource;
  /** Thời điểm sớm nhất được thử lại (chỉ có với SOURCE_COOLDOWN). */
  readonly retryAt?: Date;

  constructor(props: {
    code: "SOURCE_COOLDOWN" | "SOURCE_DISABLED";
    source: VesselSource;
    retryAt?: Date;
  }) {
    super(
      props.code === "SOURCE_COOLDOWN"
        ? `Nguồn "${props.source}" đang hạ nhiệt${
            props.retryAt ? ` tới ${props.retryAt.toISOString()}` : ""
          }`
        : `Nguồn "${props.source}" đang bị tắt`
    );
    this.name = "SourceUnavailableError";
    this.code = props.code;
    this.source = props.source;
    this.retryAt = props.retryAt;
  }
}

/** Mã lỗi nghiệp vụ cũ (domain/errors/AppError.ts) -> category. */
const APP_ERROR_CODE_MAP: Readonly<Record<string, SourceErrorCategory>> = Object.freeze({
  "E-1001": SourceErrorCategory.NOT_FOUND,
  "E-2001": SourceErrorCategory.BLOCKED, // gộp cả 429 — xem ghi chú đầu file
  "E-2003": SourceErrorCategory.TIMEOUT,
});

/** Status HTTP -> category. Đây là đường phân loại CHÍNH XÁC nhất. */
export function classifyHttpStatus(status: number): SourceErrorCategory {
  if (status === 404) return SourceErrorCategory.NOT_FOUND;
  if (status === 403) return SourceErrorCategory.BLOCKED;
  if (status === 429) return SourceErrorCategory.RATE_LIMITED;
  if (status >= 500) return SourceErrorCategory.SERVER_ERROR;
  return SourceErrorCategory.UNKNOWN;
}

function readStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { status?: unknown; statusCode?: unknown; response?: unknown };
  for (const value of [candidate.status, candidate.statusCode]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const response = candidate.response as { status?: unknown } | undefined;
  if (response && typeof response.status === "number") return response.status;
  return null;
}

/**
 * Phân loại theo thứ tự ĐỘ TIN CẬY GIẢM DẦN:
 *   1. đã là SourceRequestError -> giữ nguyên
 *   2. status HTTP tường minh
 *   3. mã AppError cũ
 *   4. tên lỗi runtime (TimeoutError/AbortError/fetch failed)
 * Không nhận ra -> UNKNOWN (và UNKNOWN mặc định KHÔNG retry).
 */
export function classifyError(err: unknown): SourceErrorCategory {
  if (err instanceof SourceRequestError) return err.category;

  const status = readStatus(err);
  if (status !== null) return classifyHttpStatus(status);

  if (typeof err === "object" && err !== null) {
    const candidate = err as { code?: unknown; name?: unknown; message?: unknown };

    if (typeof candidate.code === "string" && APP_ERROR_CODE_MAP[candidate.code]) {
      return APP_ERROR_CODE_MAP[candidate.code];
    }

    const name = typeof candidate.name === "string" ? candidate.name : "";
    if (name === "TimeoutError" || name === "AbortError") return SourceErrorCategory.TIMEOUT;

    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (name === "TypeError" && /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message)) {
      return SourceErrorCategory.NETWORK_ERROR;
    }
  }

  return SourceErrorCategory.UNKNOWN;
}

/** Bóc dữ liệu không ra -> provider mới NÊN ném cái này. */
export function parseError(source: VesselSource, message: string, cause?: unknown): SourceRequestError {
  return new SourceRequestError({
    category: SourceErrorCategory.PARSE_ERROR,
    source,
    message,
    cause,
  });
}

/** Không tới được nguồn. */
export function networkError(source: VesselSource, message: string, cause?: unknown): SourceRequestError {
  return new SourceRequestError({
    category: SourceErrorCategory.NETWORK_ERROR,
    source,
    message,
    cause,
  });
}

/** Nguồn nói rõ "không có tàu này". */
export function notFoundError(source: VesselSource, message: string): SourceRequestError {
  return new SourceRequestError({
    category: SourceErrorCategory.NOT_FOUND,
    source,
    message,
  });
}
