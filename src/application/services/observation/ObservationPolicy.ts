// ============================================================================
//  APPLICATION · Chính sách lưu observation: dedupe window + raw payload
// ----------------------------------------------------------------------------
//  Mọi con số ở một chỗ. Rải magic number khắp repository là cách chắc chắn để
//  không ai biết vì sao dedupe lại 5 phút.
// ============================================================================

import { VesselObservationType } from "../../../domain/entities/VesselObservation";

/**
 * Cửa sổ dedupe theo nhóm. Trong cửa sổ, observation có VÂN TAY TRÙNG bị bỏ qua.
 *
 * ⚠️ Đây KHÔNG phải TTL retention. Nó không xoá gì cả — chỉ quyết định có ghi
 * thêm bản giống hệt hay không.
 *
 * Chọn theo tốc độ dữ liệu ĐỔI:
 *   • POSITION đổi liên tục -> cửa sổ ngắn, đừng bỏ sót chuyển động.
 *   • IDENTITY / PARTICULARS gần như bất biến -> cửa sổ dài.
 *   • VOYAGE đổi theo chuyến -> ở giữa.
 */
export interface ObservationDedupeConfig {
  readonly windowMsByType: Readonly<Record<VesselObservationType, number>>;
}

export const DEFAULT_OBSERVATION_DEDUPE_CONFIG: ObservationDedupeConfig = Object.freeze({
  windowMsByType: Object.freeze({
    [VesselObservationType.POSITION]: 5 * 60 * 1000,
    [VesselObservationType.IDENTITY]: 24 * 60 * 60 * 1000,
    [VesselObservationType.PARTICULARS]: 24 * 60 * 60 * 1000,
    [VesselObservationType.VOYAGE]: 30 * 60 * 1000,
  }),
});

export function dedupeWindowMs(
  type: VesselObservationType,
  config: ObservationDedupeConfig = DEFAULT_OBSERVATION_DEDUPE_CONFIG
): number {
  return config.windowMsByType[type];
}

/** Mốc sớm nhất còn được coi là "trùng". Cũ hơn mốc này -> ghi bản mới. */
export function dedupeCutoff(
  type: VesselObservationType,
  now: Date,
  config: ObservationDedupeConfig = DEFAULT_OBSERVATION_DEDUPE_CONFIG
): Date {
  return new Date(now.getTime() - dedupeWindowMs(type, config));
}

/**
 * Khi nào giữ payload thô.
 *   NONE     — không bao giờ. Nhẹ nhất.
 *   ON_ERROR — chỉ khi observation KHÔNG hợp lệ hoàn toàn (PARTIAL/INVALID).
 *              Mặc định: bản ghi sạch thì payload thô chẳng nói thêm gì, còn
 *              bản ghi hỏng thì đó là bằng chứng DUY NHẤT để biết nguồn đã đổi
 *              HTML hay parser sai.
 *   ALWAYS   — mọi observation. Chỉ dùng khi đang soi một nguồn cụ thể.
 */
export const RawPayloadPolicy = {
  NONE: "NONE",
  ON_ERROR: "ON_ERROR",
  ALWAYS: "ALWAYS",
} as const;

export type RawPayloadPolicy = (typeof RawPayloadPolicy)[keyof typeof RawPayloadPolicy];

export const DEFAULT_RAW_PAYLOAD_POLICY: RawPayloadPolicy = RawPayloadPolicy.ON_ERROR;

/** Một trang HTML có thể vài MB. 64 KiB đủ để nhìn ra vấn đề. */
export const DEFAULT_MAX_RAW_PAYLOAD_BYTES = 64 * 1024;

/**
 * Khoá có thể chứa bí mật. Khớp là XOÁ, không phải che một phần — che một phần
 * vẫn rò độ dài và tiền tố.
 */
const SENSITIVE_KEY_PATTERN =
  /(cookie|authorization|auth|api[-_]?key|apikey|token|secret|password|passwd|credential|session|x-api-key)/i;

export const REDACTED = "[REDACTED]";

/**
 * Xoá field nhạy cảm trong payload thô. Không phải security framework — chỉ là
 * cái chặn để header xác thực không rơi vào MongoDB.
 */
export function sanitizeRawPayload(payload: unknown, depth = 0): unknown {
  if (depth > 6) return "[DEPTH_LIMIT]";
  if (payload === null || payload === undefined) return payload;
  if (Array.isArray(payload)) return payload.map((item) => sanitizeRawPayload(item, depth + 1));
  if (payload instanceof Date) return payload;
  if (typeof payload !== "object") return payload;

  const source = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeRawPayload(value, depth + 1);
  }
  return out;
}

export interface PreparedRawPayload {
  payload?: unknown;
  truncated: boolean;
}

/**
 * Sanitize + cắt theo `maxBytes`. Vượt hạn -> giữ phần đầu dạng chuỗi và bật
 * cờ `truncated` (mất dữ liệu im lặng còn tệ hơn mất dữ liệu có ghi chú).
 */
export function prepareRawPayload(
  payload: unknown,
  maxBytes: number = DEFAULT_MAX_RAW_PAYLOAD_BYTES
): PreparedRawPayload {
  if (payload === undefined || payload === null) return { truncated: false };

  const sanitized = sanitizeRawPayload(payload);
  if (typeof sanitized === "string") {
    return sanitized.length <= maxBytes
      ? { payload: sanitized, truncated: false }
      : { payload: sanitized.slice(0, maxBytes), truncated: true };
  }

  const serialized = JSON.stringify(sanitized) ?? "";
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
    return { payload: sanitized, truncated: false };
  }
  return { payload: serialized.slice(0, maxBytes), truncated: true };
}

/** Chính sách có yêu cầu giữ payload cho observation ở trạng thái này không. */
export function shouldKeepRawPayload(policy: RawPayloadPolicy, isFullyValid: boolean): boolean {
  if (policy === RawPayloadPolicy.ALWAYS) return true;
  if (policy === RawPayloadPolicy.NONE) return false;
  return !isFullyValid;
}
