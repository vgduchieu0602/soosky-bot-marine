// ============================================================================
//  INFRASTRUCTURE · ShipInfoMapper — RAW DTO -> canonical. Hàm THUẦN.
// ----------------------------------------------------------------------------
//  Ranh giới P6.2 giữ nguyên: parser vẫn trả "12", "-1", "Bulk Carrier\n",
//  "2026-08-13 19:39:30". Mọi việc dọn dẹp xảy ra Ở ĐÂY, không đẩy ngược vào
//  parser.
//
//  Không mạng, không DB, không runtime, không observation, không resolver.
//  Không GenericMapper/MapperFactory/NormalizationEngine — vài hàm nhỏ là đủ.
//
//  Nguyên tắc xuyên suốt: THIẾU DỮ LIỆU THÌ ĐỂ THIẾU. Không bịa 0, không bịa
//  toạ độ, không suy diễn field này từ field khác.
// ============================================================================

import { VesselIdentity, VesselFlag } from "../../../domain/canonical/VesselIdentity";
import { VesselParticulars } from "../../../domain/canonical/VesselParticulars";
import { VesselPositionReport } from "../../../domain/canonical/VesselPositionReport";
import {
  MIN_BUILT_YEAR,
  maxBuiltYear,
} from "../../../domain/observations/observationValidators";
import { SourceMetadata, createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../../domain/value-objects/VesselSource";
import { isValidCoordinates } from "../../../domain/validators/geo";
import { isValidCourse, isValidHeading, isValidSpeed } from "../../../domain/validators/motion";
import {
  ShipInfoParsedDocument,
  ShipInfoRawPoint,
  ShipInfoRawVessel,
} from "./ShipInfoTypes";

// ---------------------------------------------------------------------------
//  Tiện ích nhỏ
// ---------------------------------------------------------------------------

/** Trim + gộp khoảng trắng. Rỗng -> null. Bỏ "\n" mà nguồn để lại ở `type`. */
export function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * Chuỗi -> số hữu hạn. `Number("")` là 0 và `Number("  ")` cũng là 0 — dùng
 * `Number()` trần sẽ biến "không có dữ liệu" thành số 0 thật.
 */
export function parseFiniteNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
//  Thời gian — phần khó nhất, xem docs/sources/SHIPINFO_AUDIT.md §5
// ---------------------------------------------------------------------------

/**
 * ShipInfo trả chuỗi TRẦN "YYYY-MM-DD HH:mm:ss", KHÔNG kèm offset.
 * `new Date("2026-08-13 19:39:30")` trong Node hiểu là giờ MÁY CHẠY BOT — sai
 * ở mọi máy có múi giờ khác. Nên tự tách và dựng bằng `Date.UTC`, cho ra một
 * mốc TẤT ĐỊNH: "coi như UTC". Đó chưa phải giờ thật, mới là điểm quy chiếu.
 */
export function parseNaiveTimestampMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (match === null) return null;

  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0"));
  return Number.isFinite(ms) ? ms : null;
}

/** Giới hạn tin cậy cho offset suy ra: quá ngưỡng này thì không phải múi giờ. */
export const SHIPINFO_MAX_OFFSET_MS = 14 * 60 * 60 * 1000;
const QUARTER_HOUR_MS = 15 * 60 * 1000;

/**
 * Suy ra offset múi giờ của `points[].updated`, KHÔNG hardcode.
 *
 * Bằng chứng P6.1 + smoke P6.2: `vesselSeoContext.updated_utc` là mốc UTC của
 * ĐÚNG điểm track cuối cùng. Đo trên 5 tàu đều lệch +2h — nhưng +2h nhiều khả
 * năng là giờ mùa hè châu Âu, mùa đông sẽ thành +1h. Nên phải TÍNH LẠI mỗi lần
 * parse thay vì đóng cứng con số.
 *
 *     offset = naive(points[cuối].updated) − naive(updated_utc)
 *     giờ thật (UTC) = naive(point.updated) − offset
 *
 * Cả hai vế parse cùng một kiểu nên phép trừ triệt tiêu quy ước, kết quả là
 * offset thật.
 *
 * @returns null khi không đủ dữ kiện, hoặc kết quả vô lý (không phải bội số 15
 *          phút, hoặc lệch quá 14 giờ) — thà không có mốc còn hơn mốc sai.
 */
export function resolveSourceOffsetMs(document: ShipInfoParsedDocument): number | null {
  const points = document.vessel.points ?? [];
  const lastUpdated = points.length > 0 ? points[points.length - 1]?.updated : null;

  const anchorLocal = parseNaiveTimestampMs(lastUpdated);
  const anchorUtc = parseNaiveTimestampMs(document.seoContext?.updated_utc);
  if (anchorLocal === null || anchorUtc === null) return null;

  const offset = anchorLocal - anchorUtc;
  if (Math.abs(offset) > SHIPINFO_MAX_OFFSET_MS) return null;
  if (offset % QUARTER_HOUR_MS !== 0) return null;
  return offset;
}

/**
 * Mốc UTC thật của một điểm track.
 * @returns null khi không suy được offset — KHÔNG thay bằng giờ fetch. Vị trí
 *          ShipInfo trễ ~14 giờ; gán giờ fetch sẽ biến dữ liệu cũ thành dữ liệu
 *          "vừa mới", tức là làm hỏng chính thứ mà merge policy dựa vào.
 */
export function toSourceInstant(
  point: ShipInfoRawPoint,
  offsetMs: number | null
): Date | null {
  if (offsetMs === null) return null;
  const naive = parseNaiveTimestampMs(point.updated);
  if (naive === null) return null;
  return new Date(naive - offsetMs);
}

// ---------------------------------------------------------------------------
//  Khoá tàu
// ---------------------------------------------------------------------------

/**
 * Khoá canonical theo BR-01 (giống entity `Vessel`): MMSI là chính, IMO là dự
 * phòng cho tàu không có MMSI.
 * @returns null khi không có định danh nào -> không dựng được nhóm canonical.
 */
function canonicalKey(vessel: ShipInfoRawVessel): { mmsi: string; imo: string | null } | null {
  const mmsi = cleanText(vessel.mmsi);
  const imo = cleanText(vessel.imo);
  const key = mmsi ?? imo;
  if (key === null) return null;
  return { mmsi: key, imo };
}

// ---------------------------------------------------------------------------
//  Nhóm A · Identity
// ---------------------------------------------------------------------------

/**
 * ShipInfo cho CẢ mã cờ lẫn tên nước — điền được `VesselFlag.code`, thứ mà
 * VesselFinder không cho (mapper của nó luôn để code = null).
 */
function toFlag(vessel: ShipInfoRawVessel): VesselFlag | null {
  const code = cleanText(vessel.flag);
  const name = cleanText(vessel.country);
  if (code === null && name === null) return null;
  return { code, name };
}

export function toVesselIdentity(
  document: ShipInfoParsedDocument,
  metadata: SourceMetadata
): VesselIdentity | null {
  const key = canonicalKey(document.vessel);
  if (key === null) return null;

  return {
    mmsi: key.mmsi,
    imo: key.imo,
    name: cleanText(document.vessel.name),
    callsign: cleanText(document.vessel.callsign),
    // "Bulk Carrier\n" -> "Bulk Carrier"
    vesselType: cleanText(document.vessel.type),
    // ShipInfo chỉ có nhãn chữ, không có mã AIS số.
    vesselTypeCode: null,
    flag: toFlag(document.vessel),
    metadata,
  };
}

// ---------------------------------------------------------------------------
//  Nhóm C · Particulars — CỰC KỲ bảo thủ
// ---------------------------------------------------------------------------

/** Năm đóng hợp lý, dùng lại ngưỡng đã có ở validator observation (P5). */
function toBuiltYear(value: string | null | undefined, now: Date): number | null {
  const year = parseFiniteNumber(value);
  if (year === null || !Number.isInteger(year)) return null;
  return year >= MIN_BUILT_YEAR && year <= maxBuiltYear(now) ? year : null;
}

function toDeadweight(value: string | null | undefined): number | null {
  const dwt = parseFiniteNumber(value);
  if (dwt === null || dwt <= 0) return null;
  return dwt;
}

/**
 * CHỈ `builtYear` và `deadweight`.
 *
 * ⛔ `length` / `beam`: KHÔNG MAP. Bằng chứng P6.1 — cùng tên field, hai tàu
 *    hiểu ngược nhau:
 *        Agia Doxa     length=179 width=29   (đúng)
 *        Qi Xian Ling  length=29  width=180  (đảo)
 *    Không có quy tắc nào biết được lúc nào nguồn đảo. "Số lớn hơn là chiều
 *    dài" là ĐOÁN, và sai với sà lan/ụ nổi. `vesselSeoContext` cũng không cứu
 *    được vì nó lặp lại đúng giá trị sai. Dữ liệu sai tệ hơn không có dữ liệu.
 *    Raw DTO vẫn giữ nguyên hai field; nguồn đáng tin hơn sẽ điền sau.
 *
 * ⛔ `draught`: 0/1073 điểm có giá trị. Không map, không đổi null thành 0.
 * ⛔ `grossTonnage`: nguồn không có khoá nào.
 *
 * @returns null khi không có field nào -> không phát ra nhóm rỗng.
 */
export function toVesselParticulars(
  document: ShipInfoParsedDocument,
  metadata: SourceMetadata,
  now: Date
): VesselParticulars | null {
  const key = canonicalKey(document.vessel);
  if (key === null) return null;

  const builtYear = toBuiltYear(document.vessel.year, now);
  const deadweight = toDeadweight(document.vessel.dwt);
  if (builtYear === null && deadweight === null) return null;

  return {
    mmsi: key.mmsi,
    imo: key.imo,
    builtYear,
    deadweight,
    grossTonnage: null,
    length: null,
    beam: null,
    draught: null,
    metadata,
  };
}

// ---------------------------------------------------------------------------
//  Nhóm B · Position
// ---------------------------------------------------------------------------

/** Điểm dùng được = có toạ độ hợp lệ. Không có toạ độ thì không phải báo cáo vị trí. */
export function isUsablePoint(point: ShipInfoRawPoint): boolean {
  return isValidCoordinates(parseFiniteNumber(point.lat), parseFiniteNumber(point.lng));
}

/**
 * Điểm dùng được MỚI NHẤT.
 *
 * Giả định: `points[]` đã xếp theo thời gian TĂNG DẦN. Bằng chứng P6.1 — 268
 * điểm của Qi Xian Ling chạy từ 2026-07-31 11:41 tới 2026-08-13 20:07, và
 * `vesselSeoContext.updated_utc` khớp đúng phần tử CUỐI. Nên quét NGƯỢC từ cuối
 * là đủ; không cần sắp xếp lại.
 *
 * Điểm cuối hỏng toạ độ thì lùi tiếp về điểm hợp lệ gần nhất, thay vì bỏ luôn
 * cả tàu.
 *
 * @returns null khi mảng rỗng hoặc mọi điểm đều không có toạ độ hợp lệ.
 */
export function selectLatestUsablePoint(points: readonly ShipInfoRawPoint[]): ShipInfoRawPoint | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const point = points[i];
    if (point !== undefined && isUsablePoint(point)) return point;
  }
  return null;
}

/**
 * `course = "-1"` là sentinel "không rõ hướng" (gặp ở 2/4 tàu, và gặp lại trong
 * smoke test P6.2). Validator P1 loại nó vì ngoài [0,360) — dùng chung validator
 * chính là cách chặn, không cần luật riêng cho `-1`.
 */
function toCourse(value: string | null | undefined): number | null {
  const course = parseFiniteNumber(value);
  return course !== null && isValidCourse(course) ? course : null;
}

function toSpeed(value: string | null | undefined): number | null {
  const speed = parseFiniteNumber(value);
  return speed !== null && isValidSpeed(speed) ? speed : null;
}

/**
 * ⚠️ Heading: 0/1073 điểm có giá trị. KHÔNG suy từ course — course là hướng đi
 * thực tế trên mặt đất, heading là hướng mũi tàu; tàu trôi ngang thì hai cái
 * khác hẳn nhau. Nếu ngày nào đó nguồn có heading thật thì validator P1 nhận.
 */
function toHeading(value: string | null | undefined): number | null {
  const heading = parseFiniteNumber(value);
  return heading !== null && isValidHeading(heading) ? heading : null;
}

/**
 * Báo cáo vị trí canonical từ điểm dùng được mới nhất.
 *
 * @returns null khi (a) không có điểm nào dùng được, hoặc (b) không suy được
 *          mốc thời gian thật của nguồn. Trường hợp (b) là lựa chọn có chủ ý:
 *          canonical bắt buộc `receivedAt`, mà điền giờ fetch vào đó sẽ khiến
 *          một vị trí cũ 14 giờ trông như vừa mới nhận.
 */
export function toVesselPositionReport(
  document: ShipInfoParsedDocument,
  metadata: SourceMetadata
): VesselPositionReport | null {
  const key = canonicalKey(document.vessel);
  if (key === null) return null;

  const point = selectLatestUsablePoint(document.vessel.points ?? []);
  if (point === null) return null;

  const sourceInstant = toSourceInstant(point, resolveSourceOffsetMs(document));
  if (sourceInstant === null) return null;

  return {
    mmsi: key.mmsi,
    imo: key.imo,
    lat: parseFiniteNumber(point.lat) as number,
    lng: parseFiniteNumber(point.lng) as number,
    speed: toSpeed(point.speed),
    course: toCourse(point.course),
    heading: toHeading(point.heading),
    // ShipInfo không cung cấp trạng thái hành hải. KHÔNG suy từ speed=0.
    navStatus: null,
    // Toạ độ đầy đủ 5 chữ số thập phân, không bị làm tròn như trang free của
    // VesselFinder.
    latLngApproximate: false,
    receivedAt: sourceInstant,
    metadata,
  };
}

// ---------------------------------------------------------------------------
//  Metadata
// ---------------------------------------------------------------------------

/**
 * `fetchedAt` là đồng hồ của BOT; `sourceReceivedAt` là mốc NGUỒN khai.
 * Chỉ đặt `sourceReceivedAt` khi thật sự suy được — không suy được thì null,
 * không mượn `fetchedAt`.
 */
export function buildShipInfoMetadata(fetchedAt: Date, sourceReceivedAt: Date | null): SourceMetadata {
  return createSourceMetadata({
    source: VesselSource.SHIPINFO,
    fetchedAt,
    sourceReceivedAt,
  });
}

/** Mốc nguồn của vị trí mới nhất, hoặc null. Dùng để dựng metadata nhóm Position. */
export function resolveLatestSourceInstant(document: ShipInfoParsedDocument): Date | null {
  const point = selectLatestUsablePoint(document.vessel.points ?? []);
  if (point === null) return null;
  return toSourceInstant(point, resolveSourceOffsetMs(document));
}
