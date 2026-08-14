// ============================================================================
//  INFRASTRUCTURE · ShipInfoParser — HTML -> raw DTO. Hàm THUẦN, không mạng.
// ----------------------------------------------------------------------------
//  P6.1 chứng minh dữ liệu tàu nằm TRỌN trong hai khối JS nhúng, KHÔNG có trong
//  DOM (không một <td> nào chứa IMO/MMSI/Callsign). Nên parser đọc thẳng khối
//  nhúng — không DOM, không cheerio, không trình duyệt.
//
//  Tách khối bằng QUÉT CẶP NGOẶC, không bằng regex tham lam: regex kiểu
//  `\{[\s\S]*?\};[\r\n]` phụ thuộc vào ký tự xuống dòng ngay sau dấu chấm phẩy
//  và sẽ vỡ khi nguồn đổi cách xuống dòng — thay đổi hoàn toàn vô hại.
//  Cách này chịu được `var IMOs={...};`, `var IMOs = {...} ;`, nhiều dòng.
//
//  BA KẾT CỤC, phân biệt rạch ròi (docs/sources/SHIPINFO_AUDIT.md §2):
//    1. OK             — có khối, parse được.
//    2. NO_VESSEL_DATA — trang không mang dữ liệu tàu. Đây là KẾT QUẢ, không
//                        phải lỗi: ShipInfo trả HTTP 200 kèm PHP fatal error
//                        cho tàu không tồn tại, nên status code vô dụng.
//    3. THROW          — có khối nhưng JSON hỏng. Đây là lỗi parser THẬT
//                        (nguồn đổi định dạng) và KHÔNG được nuốt thành
//                        "không có tàu" — nuốt là mất tín hiệu drift.
// ============================================================================

import {
  ShipInfoParsedDocument,
  ShipInfoRawVessel,
  ShipInfoRawVesselMap,
  ShipInfoSeoContext,
} from "./ShipInfoTypes";

/** Khối chứa dữ liệu tàu. */
const VESSELS_MARKER = /var\s+IMOs\s*=\s*/;
/** Khối phụ, chứa mốc UTC duy nhất của trang. */
const SEO_MARKER = /var\s+vesselSeoContext\s*=\s*/;
/** Body lỗi PHP đã quan sát ở P6.1 (kèm HTTP 200). */
const PHP_FATAL = /Fatal error\s*(?:<\/b>)?\s*:/i;

export const ShipInfoNoDataReason = {
  /** Không thấy `var IMOs` — trang không phải trang tàu, hoặc trang lỗi. */
  MISSING_VESSEL_STATE: "MISSING_VESSEL_STATE",
  /** Không thấy `var IMOs` VÀ body là PHP fatal error (HTTP vẫn 200). */
  PHP_FATAL_ERROR: "PHP_FATAL_ERROR",
  /** Có `var IMOs` nhưng object rỗng. */
  EMPTY_VESSEL_STATE: "EMPTY_VESSEL_STATE",
} as const;

export type ShipInfoNoDataReason =
  (typeof ShipInfoNoDataReason)[keyof typeof ShipInfoNoDataReason];

export type ShipInfoParseResult =
  | { status: "OK"; document: ShipInfoParsedDocument }
  | { status: "NO_VESSEL_DATA"; reason: ShipInfoNoDataReason; detail?: string };

/**
 * Khối nhúng tồn tại nhưng nội dung không dùng được.
 * MỘT class lỗi là đủ — không dựng cây phân cấp lỗi.
 */
export class ShipInfoParseError extends Error {
  /** Tên biến JS đã hỏng, VD "IMOs". */
  readonly marker: string;
  readonly cause?: unknown;

  constructor(marker: string, message: string, cause?: unknown) {
    super(message);
    this.name = "ShipInfoParseError";
    this.marker = marker;
    this.cause = cause;
  }
}

/**
 * Cắt ra literal object bắt đầu ở `openIndex`, đếm cặp ngoặc và BỎ QUA ngoặc
 * nằm trong chuỗi (kể cả ký tự escape) — nếu không, một tên tàu chứa "}" sẽ
 * cắt cụt cả khối.
 * @returns text của object, hoặc null nếu ngoặc không đóng.
 */
function sliceObjectLiteral(source: string, openIndex: number): string | null {
  let depth = 0;
  let quote: string | null = null;

  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];

    if (quote !== null) {
      if (char === "\\") {
        i += 1; // bỏ qua ký tự được escape
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return null;
}

/**
 * Lấy text của object gán cho một biến JS. Không phụ thuộc khoảng trắng, dấu
 * chấm phẩy hay ký tự xuống dòng phía sau.
 * @returns null khi không tìm thấy biến.
 */
export function extractEmbeddedObject(html: string, marker: RegExp): string | null {
  const match = marker.exec(html);
  if (match === null) return null;

  const openIndex = html.indexOf("{", match.index + match[0].length);
  if (openIndex === -1) return null;

  return sliceObjectLiteral(html, openIndex);
}

function parseJsonOrThrow<T>(text: string, marker: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new ShipInfoParseError(
      marker,
      `Khối nhúng "${marker}" của ShipInfo không parse được JSON: ${
        (err as Error).message
      }`,
      err
    );
  }
}

/**
 * Đọc `var vesselSeoContext`. Không có -> undefined (khối này là tuỳ chọn).
 * Có nhưng hỏng -> NÉM: khối nhúng hỏng luôn là tín hiệu nguồn đổi định dạng,
 * kể cả khi nó chỉ là khối phụ.
 */
export function parseSeoContext(html: string): ShipInfoSeoContext | undefined {
  const raw = extractEmbeddedObject(html, SEO_MARKER);
  if (raw === null) return undefined;
  return parseJsonOrThrow<ShipInfoSeoContext>(raw, "vesselSeoContext");
}

/**
 * Đọc trang chi tiết tàu của ShipInfo.
 *
 * KHÔNG chuẩn hoá gì: chuỗi số vẫn là chuỗi, `course` vẫn là "-1", `type` vẫn
 * còn "\n", `length`/`width` giữ đúng tên và giá trị của nguồn.
 *
 * @throws ShipInfoParseError khi khối nhúng tồn tại nhưng JSON hỏng.
 */
export function parseShipInfoHtml(html: string): ShipInfoParseResult {
  if (typeof html !== "string" || html.trim() === "") {
    return {
      status: "NO_VESSEL_DATA",
      reason: ShipInfoNoDataReason.MISSING_VESSEL_STATE,
      detail: "HTML rỗng",
    };
  }

  const rawVessels = extractEmbeddedObject(html, VESSELS_MARKER);
  if (rawVessels === null) {
    // Kiểm PHP fatal SAU khi chắc chắn không có dữ liệu tàu -> không thể báo
    // động nhầm trên một trang tàu bình thường.
    if (PHP_FATAL.test(html)) {
      return {
        status: "NO_VESSEL_DATA",
        reason: ShipInfoNoDataReason.PHP_FATAL_ERROR,
        detail: "ShipInfo trả HTTP 200 kèm PHP fatal error — tàu không tồn tại",
      };
    }
    return {
      status: "NO_VESSEL_DATA",
      reason: ShipInfoNoDataReason.MISSING_VESSEL_STATE,
      detail: "Không tìm thấy khối `var IMOs`",
    };
  }

  const vessels = parseJsonOrThrow<ShipInfoRawVesselMap>(rawVessels, "IMOs");
  const keys = Object.keys(vessels);
  if (keys.length === 0) {
    return {
      status: "NO_VESSEL_DATA",
      reason: ShipInfoNoDataReason.EMPTY_VESSEL_STATE,
      detail: "`var IMOs` là object rỗng",
    };
  }

  const [vesselKey, ...otherVesselKeys] = keys;
  const vessel = vessels[vesselKey] as ShipInfoRawVessel;

  return {
    status: "OK",
    document: {
      vesselKey,
      vessel,
      seoContext: parseSeoContext(html),
      otherVesselKeys: Object.freeze(otherVesselKeys),
    },
  };
}
