// ============================================================================
//  INFRASTRUCTURE · ShipFinderMapper — RAW DTO -> canonical. Hàm THUẦN.
// ----------------------------------------------------------------------------
//  Ranh giới P7.2 giữ nguyên: parser vẫn trả "33-44.980 N", "10.6 kn",
//  "Unknown", "07-29 07:01", "2026-08-14 23:45:34". Mọi việc dọn dẹp ở ĐÂY.
//
//  Không mạng, không DB, không runtime, không observation, không resolver.
//  Đây KHÔNG phải bản sao của ShipInfoMapper: hai nguồn có định dạng khác hẳn
//  (DDM vs decimal, đơn vị trong chuỗi vs chuỗi số trần, sentinel khác nhau).
//
//  Nguyên tắc: THIẾU HOẶC KHÔNG CHẮC THÌ ĐỂ THIẾU. Không bịa toạ độ, không bịa
//  năm cho ETA, không bịa múi giờ.
// ============================================================================

import { VesselIdentity, VesselFlag } from "../../../domain/canonical/VesselIdentity";
import { VesselParticulars } from "../../../domain/canonical/VesselParticulars";
import {
  NavigationStatus,
  VesselPositionReport,
} from "../../../domain/canonical/VesselPositionReport";
import { VesselVoyage } from "../../../domain/canonical/VesselVoyage";
import { SourceMetadata, createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../../domain/value-objects/VesselSource";
import { isValidCoordinates } from "../../../domain/validators/geo";
import { isValidCourse, isValidHeading, isValidSpeed } from "../../../domain/validators/motion";
import { ShipFinderRawVessel } from "./ShipFinderTypes";

// ---------------------------------------------------------------------------
//  Sentinel & tiện ích chuỗi
// ---------------------------------------------------------------------------

/** Giá trị "không có" của ShipFinder, quan sát ở P7.1/P7.2. */
const SENTINELS: ReadonlySet<string> = new Set(["-", "--", "unknown", "n/a", ""]);

/**
 * Trim + gộp khoảng trắng + loại sentinel.
 * `"LONG BEACH,  US"` -> `"LONG BEACH, US"` (khoảng trắng kép là của nguồn,
 * raw layer giữ, canonical thì dọn).
 */
export function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return SENTINELS.has(cleaned.toLowerCase()) ? null : cleaned;
}

/**
 * Bóc số có đơn vị: `"179 m"` -> 179, `"10.6 kn"` -> 10.6, `"0.9 °"` -> 0.9.
 *
 * Đơn vị là TUỲ CHỌN nhưng chuỗi thừa thì bị từ chối — `"about 10 kn"` trả null
 * chứ không phải 10. `Number()` trần sẽ nuốt `""` thành 0 nên không dùng.
 */
export function parseMeasurement(
  value: string | null | undefined,
  unit?: string
): number | null {
  const text = cleanText(value);
  if (text === null) return null;

  const unitPattern = unit === undefined ? "" : `(?:\\s*${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})?`;
  const match = new RegExp(`^(-?\\d+(?:\\.\\d+)?)${unitPattern}$`, "i").exec(text);
  if (match === null) return null;

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
//  Toạ độ DDM
// ---------------------------------------------------------------------------

/** Phút phải < 60; 60 trở lên là dữ liệu hỏng, không phải "làm tròn lên độ". */
const MAX_MINUTES = 60;

/**
 * `"33-44.980 N"` -> `33.749667` · `"118-12.537 W"` -> `-118.20895`.
 *
 * ShipFinder dùng độ + phút thập phân (DDM). Đọc thẳng `33-44.980` thành số sẽ
 * ra rác, nên phép đổi này là BẮT BUỘC:
 *      decimal = độ + phút / 60,   S/W thì âm.
 *
 * @returns null khi sai định dạng, phút >= 60, hoặc độ ngoài phạm vi của trục.
 */
export function parseDdmCoordinate(value: string | null | undefined): number | null {
  const text = cleanText(value);
  if (text === null) return null;

  const match = /^(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([NSEW])$/i.exec(text);
  if (match === null) return null;

  const degrees = Number(match[1]);
  const minutes = Number(match[2]);
  const hemisphere = match[3].toUpperCase();
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return null;
  if (minutes >= MAX_MINUTES) return null;

  // Giới hạn độ khác nhau theo trục — bắt lỗi ngay ở đây thay vì để lọt xuống.
  const isLatitude = hemisphere === "N" || hemisphere === "S";
  if (degrees > (isLatitude ? 90 : 180)) return null;

  const decimal = degrees + minutes / 60;
  const signed = hemisphere === "S" || hemisphere === "W" ? -decimal : decimal;
  // Chặn biên: 90-30.000 N sẽ vượt 90 sau khi cộng phút.
  if (isLatitude ? Math.abs(signed) > 90 : Math.abs(signed) > 180) return null;
  return signed;
}

// ---------------------------------------------------------------------------
//  Mốc thời gian — phần bảo thủ nhất
// ---------------------------------------------------------------------------

/**
 * `"2026-08-14 23:45:34"` -> số ms, coi NHƯ LÀ UTC.
 *
 * `new Date("2026-08-14 23:45:34")` trong Node hiểu là giờ MÁY CHẠY BOT — sai
 * ở mọi máy có múi giờ khác. Tự tách và dựng bằng `Date.UTC` cho ra mốc TẤT
 * ĐỊNH; đó mới là điểm quy chiếu, chưa phải giờ thật.
 */
export function parseNaiveTimestampMs(value: string | null | undefined): number | null {
  const text = cleanText(value);
  if (text === null) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (match === null) return null;

  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0"));
  return Number.isFinite(ms) ? ms : null;
}

/** Cho phép lệch nhỏ giữa đồng hồ nguồn và đồng hồ bot. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface ShipFinderMappingOptions {
  /**
   * Độ lệch múi giờ của `Last update`, tính bằng PHÚT so với UTC.
   *
   * ⚠️ KHÔNG CÓ MẶC ĐỊNH, và đó là chủ ý.
   *
   * Trang ShipFinder KHÔNG khai báo múi giờ ở bất kỳ đâu, và KHÔNG có mỏ neo
   * tự khai như `vesselSeoContext.updated_utc` của ShipInfo để suy ra offset
   * mỗi lần parse. Audit P7.1 *suy luận* ra UTC+8 (=480) bằng ba căn cứ:
   *   1. Lập luận bất khả thi: trang ghi 23:47:00 trong khi đồng hồ audit là
   *      15:47:25Z — nếu là UTC thì "cập nhật lần cuối" nằm 8 giờ ở TƯƠNG LAI.
   *   2. Hai lần tải cách 2m28s làm mốc trang tiến đúng 3m00s -> cùng nhịp
   *      đồng hồ, chỉ khác một hằng số.
   *   3. Shipxy là nhà vận hành Trung Quốc; CST = UTC+8, không có giờ mùa hè.
   *
   * Nhưng suy luận KHÁC hợp đồng. Nên mapper KHÔNG tự đoán: không truyền
   * offset thì **không phát ra vị trí**. Muốn dùng thì người vận hành phải
   * khai tường minh (`480`) — tức là ký tên vào giả định đó.
   * Xem docs/sources/SHIPFINDER_AUDIT.md §"Timestamp semantics".
   */
  sourceUtcOffsetMinutes?: number;
  /** Mốc "bây giờ" để kiểm mốc nguồn không rơi vào tương lai. */
  now?: Date;
}

/**
 * Mốc UTC thật của `Last update`.
 *
 * @returns null khi (a) không khai offset — mặc định bảo thủ, (b) chuỗi sai
 *          định dạng, hoặc (c) kết quả rơi vào TƯƠNG LAI quá mức lệch đồng hồ
 *          cho phép. (c) là lưới an toàn: offset khai sai sẽ lộ ra ngay thay vì
 *          âm thầm sinh mốc lệch hàng giờ.
 */
export function resolveSourceInstant(
  raw: ShipFinderRawVessel,
  options: ShipFinderMappingOptions
): Date | null {
  const offsetMinutes = options.sourceUtcOffsetMinutes;
  if (offsetMinutes === undefined || !Number.isFinite(offsetMinutes)) return null;

  const naive = parseNaiveTimestampMs(raw.lastUpdate);
  if (naive === null) return null;

  const instantMs = naive - offsetMinutes * 60_000;
  const now = (options.now ?? new Date()).getTime();
  if (instantMs > now + MAX_CLOCK_SKEW_MS) return null;

  return new Date(instantMs);
}

// ---------------------------------------------------------------------------
//  Khoá tàu
// ---------------------------------------------------------------------------

/** BR-01: MMSI là khoá; ShipFinder chỉ tra được bằng MMSI nên luôn có. */
function canonicalKey(raw: ShipFinderRawVessel): { mmsi: string; imo: string | null } | null {
  const mmsi = cleanText(raw.mmsi);
  const imo = cleanText(raw.imo);
  const key = mmsi ?? imo;
  if (key === null) return null;
  return { mmsi: key, imo };
}

// ---------------------------------------------------------------------------
//  Nhóm A · Identity
// ---------------------------------------------------------------------------

/**
 * ⚠️ `code` ở đây là **ISO 3166-1 alpha-3** ("LBR", "CHN", "USA") — ShipFinder
 * chỉ cho mã 3 ký tự, không cho tên nước. ShipInfo thì cho alpha-2 ("LR") kèm
 * tên. Canonical `VesselFlag.code` KHÔNG ràng buộc độ dài nên giữ nguyên ISO3;
 * quy đổi ISO3 <-> ISO2 là việc của resolver khi so hai nguồn, và KHÔNG thêm
 * dependency chỉ để làm việc đó ở P7.3.
 */
function toFlag(raw: ShipFinderRawVessel): VesselFlag | null {
  const code = cleanText(raw.flag);
  if (code === null) return null;
  return { code, name: null };
}

export function toVesselIdentity(
  raw: ShipFinderRawVessel,
  metadata: SourceMetadata
): VesselIdentity | null {
  const key = canonicalKey(raw);
  if (key === null) return null;

  return {
    mmsi: key.mmsi,
    imo: key.imo,
    name: cleanText(raw.name),
    callsign: cleanText(raw.callsign),
    // Nhãn thô của nguồn ("Cargo ship"), KHÔNG map sang từ vựng của nguồn khác.
    vesselType: cleanText(raw.type),
    // ShipFinder không cho mã AIS số. Không suy từ nhãn chữ.
    vesselTypeCode: null,
    flag: toFlag(raw),
    metadata,
  };
}

// ---------------------------------------------------------------------------
//  Nhóm C · Particulars
// ---------------------------------------------------------------------------

/** Kích thước phải là số dương hữu hạn. */
function toPositiveMetres(value: string | null | undefined): number | null {
  const parsed = parseMeasurement(value, "m");
  return parsed !== null && parsed > 0 ? parsed : null;
}

/**
 * `length` và `width` -> `length` và `beam`.
 *
 * ⚠️ KHÔNG hoán đổi theo bất kỳ heuristic nào. ShipInfo có lỗi đảo kích thước
 * nên phải bỏ hẳn hai field; ShipFinder thì P7.1 kiểm 3/3 tàu đều ĐÚNG CHIỀU,
 * kể cả con tàu mà ShipInfo bị đảo. Nên ở đây map thẳng, không đoán.
 *
 * KHÔNG map `grossTonnage` / `deadweight` / `builtYear`: trang công khai không
 * có (chúng nằm sau API ký chữ ký mà P7.1 cố ý không đụng).
 *
 * @returns null khi không có field nào -> không phát ra nhóm rỗng.
 */
export function toVesselParticulars(
  raw: ShipFinderRawVessel,
  metadata: SourceMetadata
): VesselParticulars | null {
  const key = canonicalKey(raw);
  if (key === null) return null;

  const length = toPositiveMetres(raw.length);
  const beam = toPositiveMetres(raw.width);
  const draught = toPositiveMetres(raw.draught);
  if (length === null && beam === null && draught === null) return null;

  return {
    mmsi: key.mmsi,
    imo: key.imo,
    length,
    beam,
    draught,
    grossTonnage: null,
    deadweight: null,
    builtYear: null,
    metadata,
  };
}

// ---------------------------------------------------------------------------
//  Nhóm B · Position
// ---------------------------------------------------------------------------

function toSpeed(value: string | null | undefined): number | null {
  const speed = parseMeasurement(value, "kn");
  return speed !== null && isValidSpeed(speed) ? speed : null;
}

function toCourse(value: string | null | undefined): number | null {
  const course = parseMeasurement(value, "°");
  return course !== null && isValidCourse(course) ? course : null;
}

/**
 * `"58.0 °"` -> 58. Sentinel `"Unknown"`/`"-"` -> null (đã lọc ở `cleanText`).
 *
 * ⚠️ KHÔNG suy heading từ course. Course là hướng đi trên mặt đất, heading là
 * hướng mũi tàu; tàu trôi ngang thì hai cái khác hẳn nhau.
 * Validator P1 yêu cầu số NGUYÊN [0,359] nên `"58.0 °"` phải làm tròn trước.
 */
function toHeading(value: string | null | undefined): number | null {
  const heading = parseMeasurement(value, "°");
  if (heading === null) return null;
  const rounded = Math.round(heading);
  return isValidHeading(rounded) ? rounded : null;
}

/**
 * ShipFinder cho trạng thái dạng CHỮ đúng từ vựng AIS ("Moored", "Under way
 * using engine"). Canonical `NavigationStatus` nhận cả `code` lẫn `text`, và ở
 * đây chỉ điền `text`.
 *
 * ⚠️ KHÔNG dựng bảng tra chữ -> mã AIS: so khớp chuỗi chính xác rất dễ vỡ khi
 * nguồn đổi cách viết, mà `code` cũng chưa ai cần. Và tuyệt đối KHÔNG suy trạng
 * thái từ speed (speed = 0 không có nghĩa là đang neo).
 */
function toNavStatus(value: string | null | undefined): NavigationStatus | null {
  const text = cleanText(value);
  if (text === null) return null;
  return { code: null, text };
}

/**
 * Báo cáo vị trí canonical.
 *
 * @returns null khi (a) toạ độ DDM hỏng, hoặc (b) KHÔNG xác định được mốc thời
 *          gian thật của nguồn. (b) là lựa chọn có chủ ý: canonical bắt buộc
 *          `receivedAt`, mà điền `fetchedAt` vào đó là biến đồng hồ của bot
 *          thành mốc của nguồn — đúng thứ làm hỏng mọi so sánh độ tươi sau này.
 */
export function toVesselPositionReport(
  raw: ShipFinderRawVessel,
  metadata: SourceMetadata,
  options: ShipFinderMappingOptions
): VesselPositionReport | null {
  const key = canonicalKey(raw);
  if (key === null) return null;

  const lat = parseDdmCoordinate(raw.lat);
  const lng = parseDdmCoordinate(raw.lon);
  if (!isValidCoordinates(lat, lng)) return null;

  const receivedAt = resolveSourceInstant(raw, options);
  if (receivedAt === null) return null;

  return {
    mmsi: key.mmsi,
    imo: key.imo,
    lat: lat as number,
    lng: lng as number,
    speed: toSpeed(raw.speed),
    course: toCourse(raw.course),
    heading: toHeading(raw.heading),
    navStatus: toNavStatus(raw.status),
    // DDM đầy đủ tới phần nghìn phút (~1.8 m) — không phải toạ độ làm tròn.
    latLngApproximate: false,
    receivedAt,
    metadata,
  };
}

// ---------------------------------------------------------------------------
//  Nhóm D · Voyage
// ---------------------------------------------------------------------------

/**
 * Chỉ `destination`.
 *
 * ⛔ ETA KHÔNG được map. Nguồn cho `"07-29 07:01"` — **thiếu năm**. Canonical
 * `eta` là `Date`, nên map buộc phải bịa một năm. Lấy năm hiện tại thì sai ngay
 * ở ranh giới năm mới, và luật "tháng nhỏ hơn thì sang năm sau" cũng chỉ là
 * đoán. Một mốc thời gian SAI tệ hơn không có mốc.
 *
 * ⛔ currentPort / nextPort / lastPort: mục Port Call đòi đăng nhập, Ship Event
 * là tính năng trả tiền -> không có dữ liệu, không bịa.
 *
 * @returns null khi không có destination -> không phát nhóm toàn null.
 */
export function toVesselVoyage(
  raw: ShipFinderRawVessel,
  metadata: SourceMetadata
): VesselVoyage | null {
  const key = canonicalKey(raw);
  if (key === null) return null;

  const destination = cleanText(raw.destination);
  if (destination === null) return null;

  return {
    mmsi: key.mmsi,
    imo: key.imo,
    destination,
    eta: null,
    currentPort: null,
    currentPortArrivalAt: null,
    nextPort: null,
    nextPortEta: null,
    lastPort: null,
    lastPortDepartureAt: null,
    metadata,
  };
}

// ---------------------------------------------------------------------------
//  Metadata
// ---------------------------------------------------------------------------

/**
 * `fetchedAt` là đồng hồ của BOT; `sourceReceivedAt` là mốc NGUỒN khai.
 * Không xác định được mốc nguồn -> null, KHÔNG mượn `fetchedAt`.
 */
export function buildShipFinderMetadata(
  fetchedAt: Date,
  sourceReceivedAt: Date | null
): SourceMetadata {
  return createSourceMetadata({
    source: VesselSource.SHIPFINDER,
    fetchedAt,
    sourceReceivedAt,
  });
}
