// ============================================================================
//  INFRASTRUCTURE · ShipFinderParser — HTML -> raw DTO. Hàm THUẦN, không mạng.
// ----------------------------------------------------------------------------
//  Khác hẳn ShipInfoParser: ShipInfo có JSON nhúng, ShipFinder KHÔNG có khối
//  dữ liệu nào — mọi thứ nằm trong DOM server-render. Hai parser độc lập, cố ý
//  không gom vào một "GenericMarineHtmlParser".
//
//  NEO CHÍNH LÀ `id`, KHÔNG PHẢI NHÃN:
//      <div class="info-label">MMSI</div>
//      <div class="info-value" id="ais-mmsi">636018086</div>
//  Mỗi ô có một id `ais-*` mà chính JS của site dùng để đổ dữ liệu (`fillAIS`),
//  nên đó là hợp đồng thật. Nhãn thì phụ thuộc NGÔN NGỮ — site có cookie
//  `culture`, đổi ngôn ngữ là parser bám nhãn mù ngay. Bám id thì không.
//
//  Nhãn vẫn được giữ làm ĐƯỜNG DỰ PHÒNG, và mỗi lần phải dùng tới nó thì ghi
//  vào `fallbackFields` — cảnh báo sớm rằng trang đang trôi.
//
//  BA KẾT CỤC (docs/sources/SHIPFINDER_AUDIT.md §"Lookup matrix"):
//    1. OK             — có dữ liệu tàu.
//    2. NO_VESSEL_DATA — trang hợp lệ nhưng không có tàu. ShipFinder trả
//                        HTTP 200 kèm mọi ô là "-" cho MMSI không tồn tại,
//                        nên status code vô dụng.
//    3. THROW          — trang TRÔNG như trang tàu nhưng mất neo bắt buộc.
//                        Đây là parser drift, KHÔNG được nuốt thành not-found.
// ============================================================================

import { ShipFinderParsedDocument, ShipFinderRawVessel } from "./ShipFinderTypes";

/** Phiên bản parser. Trang đổi cấu trúc -> bump. */
export const SHIPFINDER_PARSER_VERSION = "shipfinder-ssr-anchors-v1";

/** Giá trị "không có" của ShipFinder. Cả trang toàn dấu này = không tìm thấy. */
const EMPTY_VALUE = "-";

/** Dấu hiệu đây là trang chi tiết tàu (để phân biệt drift với trang khác). */
const VESSEL_PAGE_MARKERS = [/id=["']ais-/i, /class=["']info-grid["']/i, />\s*Ship Info\s*</i];

export const ShipFinderNoDataReason = {
  /** Có đủ cấu trúc nhưng mọi ô là "-": MMSI không tồn tại. */
  EMPTY_VESSEL_RECORD: "EMPTY_VESSEL_RECORD",
  /** Không phải trang chi tiết tàu (404, trang chủ, redirect...). */
  NOT_A_VESSEL_PAGE: "NOT_A_VESSEL_PAGE",
} as const;

export type ShipFinderNoDataReason =
  (typeof ShipFinderNoDataReason)[keyof typeof ShipFinderNoDataReason];

export type ShipFinderParseResult =
  | { status: "OK"; document: ShipFinderParsedDocument }
  | { status: "NO_VESSEL_DATA"; reason: ShipFinderNoDataReason; detail?: string };

/**
 * Trang là trang tàu nhưng mất neo bắt buộc -> cấu trúc đã đổi.
 * MỘT class lỗi là đủ.
 */
export class ShipFinderParseError extends Error {
  /** Neo đã mất, VD "ais-mmsi". */
  readonly anchor: string;

  constructor(anchor: string, message: string) {
    super(message);
    this.name = "ShipFinderParseError";
    this.anchor = anchor;
  }
}

// ---------------------------------------------------------------------------
//  Tiện ích
// ---------------------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
});

/** Giải mã entity. `&#176;` -> `°` (ký hiệu độ của Course/Heading). */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&[a-z]+;|&#39;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);
}

/**
 * CHỈ cắt hai đầu. KHÔNG gộp khoảng trắng bên trong: `"LONG BEACH,  US"` có
 * khoảng trắng kép là sự thật của nguồn, raw layer phải giữ. P7.3 mới dọn.
 */
function clean(value: string): string {
  return decodeEntities(value).replace(/^\s+|\s+$/g, "");
}

/** Text của phần tử mang `id`. Thẻ tự đóng (`<img ... />`) -> null. */
export function extractById(html: string, id: string): string | null {
  const pattern = new RegExp(
    `id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']([^>]*)>([^<]*)<`,
    "i"
  );
  const match = pattern.exec(html);
  if (match === null) return null;
  if (/\/\s*$/.test(match[1])) return null; // thẻ tự đóng, không có nội dung
  const value = clean(match[2]);
  return value === "" ? null : value;
}

/**
 * Đường DỰ PHÒNG: tìm ô nhãn rồi lấy ô giá trị ngay sau nó.
 * Chỉ dùng khi neo id biến mất.
 */
export function extractByLabel(html: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `>\\s*${escaped}\\s*<\\/[a-z]+>\\s*<[^>]*>([^<]*)<`,
    "i"
  );
  const match = pattern.exec(html);
  if (match === null) return null;
  const value = clean(match[1]);
  return value === "" ? null : value;
}

/** Tên tàu trong `<title>`: "AGIA DOXA, Cargo ship - Current position…". */
function nameFromTitle(html: string): string | null {
  const match = /<title>([^<]*)<\/title>/i.exec(html);
  if (match === null) return null;
  const head = clean(match[1]).split(",")[0];
  return head === "" ? null : head;
}

/** Cờ chỉ có trong câu mô tả, không có ô id riêng. */
function extractFlag(html: string): string | null {
  const match = /flag of\s*<[^>]*>\s*([^<]{2,8})\s*</i.exec(html);
  if (match === null) return null;
  const value = clean(match[1]);
  return value === "" || value === EMPTY_VALUE ? null : value;
}

// ---------------------------------------------------------------------------
//  Bảng neo
// ---------------------------------------------------------------------------

/** (field raw, id neo, nhãn dự phòng). Nhãn theo `culture=en-US`. */
const FIELD_ANCHORS: ReadonlyArray<readonly [keyof ShipFinderRawVessel, string, string]> =
  Object.freeze([
    ["name", "ais-name", "Name"],
    ["imo", "ais-imo", "IMO"],
    ["mmsi", "ais-mmsi", "MMSI"],
    ["callsign", "ais-callsign", "Call Sign"],
    ["type", "ais-shipType", "Type"],
    ["length", "ais-_length", "Length"],
    ["width", "ais-_width", "Width"],
    ["lat", "ais-_lat", "Lat"],
    ["lon", "ais-_lon", "Lon"],
    ["course", "ais-course_f", "Course"],
    ["heading", "ais-heading_f", "Heading"],
    ["speed", "ais-_sog", "Speed"],
    ["draught", "ais-_draught", "Draught"],
    ["destination", "ais-dest", "Dest"],
    ["eta", "ais-_eta", "ETA"],
    ["status", "ais-shipStatus", "Status"],
    ["lastUpdate", "ais-lastTime", "Last update"],
  ] as const);

/** Neo BẮT BUỘC: mất nó thì trang không còn là trang tàu đọc được. */
const REQUIRED_ANCHOR = "ais-mmsi";

function looksLikeVesselPage(html: string): boolean {
  return VESSEL_PAGE_MARKERS.some((marker) => marker.test(html));
}

/**
 * Đọc trang chi tiết tàu công khai của ShipFinder.
 *
 * KHÔNG chuẩn hoá gì: DDM vẫn là DDM, `"10.6 kn"` vẫn còn đơn vị, `"Unknown"`
 * vẫn là `"Unknown"`, mốc thời gian vẫn không có múi giờ, ETA vẫn thiếu năm.
 *
 * @throws ShipFinderParseError khi trang trông như trang tàu nhưng mất neo
 *         bắt buộc — nguồn đổi cấu trúc, KHÁC hẳn "không có tàu này".
 */
export function parseShipFinderHtml(html: string): ShipFinderParseResult {
  if (typeof html !== "string" || html.trim() === "") {
    return {
      status: "NO_VESSEL_DATA",
      reason: ShipFinderNoDataReason.NOT_A_VESSEL_PAGE,
      detail: "HTML rỗng",
    };
  }

  if (!looksLikeVesselPage(html)) {
    return {
      status: "NO_VESSEL_DATA",
      reason: ShipFinderNoDataReason.NOT_A_VESSEL_PAGE,
      detail: "Không thấy dấu hiệu trang chi tiết tàu",
    };
  }

  const vessel: ShipFinderRawVessel = {};
  const fallbackFields: string[] = [];
  let anchorHits = 0;

  for (const [field, id, label] of FIELD_ANCHORS) {
    const byId = extractById(html, id);
    if (byId !== null) {
      anchorHits += 1;
      vessel[field] = byId;
      continue;
    }
    const byLabel = extractByLabel(html, label);
    if (byLabel !== null) {
      fallbackFields.push(field);
      vessel[field] = byLabel;
    }
  }

  // Trang tàu mà không đọc được ô nào theo neo -> cấu trúc đã đổi.
  if (anchorHits === 0 && fallbackFields.length === 0) {
    throw new ShipFinderParseError(
      REQUIRED_ANCHOR,
      "Trang ShipFinder trông như trang tàu nhưng không đọc được ô dữ liệu nào " +
        "(mất cả neo id lẫn nhãn) — nhiều khả năng cấu trúc trang đã đổi"
    );
  }
  if (vessel.mmsi === undefined) {
    throw new ShipFinderParseError(
      REQUIRED_ANCHOR,
      `Không tìm thấy ô MMSI (#${REQUIRED_ANCHOR}) trên trang chi tiết tàu`
    );
  }

  // ShipFinder điền "-" vào MỌI ô khi MMSI không tồn tại. HTTP vẫn 200.
  if (vessel.mmsi === EMPTY_VALUE) {
    return {
      status: "NO_VESSEL_DATA",
      reason: ShipFinderNoDataReason.EMPTY_VESSEL_RECORD,
      detail: "Mọi ô dữ liệu là \"-\" — ShipFinder không có MMSI này",
    };
  }

  if (vessel.name === undefined || vessel.name === EMPTY_VALUE) {
    const fromTitle = nameFromTitle(html);
    if (fromTitle !== null) {
      vessel.name = fromTitle;
      fallbackFields.push("name");
    }
  }

  const flag = extractFlag(html);
  if (flag !== null) vessel.flag = flag;

  return {
    status: "OK",
    document: { vessel, fallbackFields: Object.freeze(fallbackFields) },
  };
}
