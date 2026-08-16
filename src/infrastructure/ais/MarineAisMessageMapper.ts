// ============================================================================
//  INFRASTRUCTURE · MarineAisMessageMapper — message Marine AIS -> canonical
// ----------------------------------------------------------------------------
//  HÀM THUẦN, không có ngoại lệ nào:
//      không WebSocket · không Mongo · không setInterval · không Date.now()
//      · không state toàn cục · không log.
//  Cần "bây giờ" thì NGƯỜI GỌI truyền vào (`receivedAt`). Đó là lý do file này
//  test được bằng vài dòng, và là lý do phase sau ghép coalescing/throttling
//  vào không phải sửa một dòng nào ở đây.
//
//  Đầu ra là `ProviderDetailsResult` — CHÍNH kiểu mà 3 provider pull đang dùng.
//  Không tạo AISRepository / AISCanonicalService / AISResolver: observation +
//  resolver hiện tại đã xử lý được, thêm đường ống song song chỉ tạo hai sự thật.
//
//  ⚠️ Nguồn canonical là `VesselSource.AISSTREAM`, KHÔNG phải Marine API.
//  Marine API chỉ là TRANSPORT. Xem docs/AIS_CANONICAL_INGESTION.md §1.
// ============================================================================

import { ProviderDetailsResult } from "../../application/providers/ProviderResults";
import { VesselIdentity } from "../../domain/canonical/VesselIdentity";
import {
  NavigationStatus,
  VesselPositionReport,
} from "../../domain/canonical/VesselPositionReport";
import { isValidCoordinates } from "../../domain/validators/geo";
import { isValidImo, isValidMmsi } from "../../domain/validators/identifiers";
import { isValidCourse, isValidSpeed } from "../../domain/validators/motion";
import { SourceMetadata, createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { NAV_STATUS } from "../mappers/navStatus";
import {
  MarineAisMessage,
  MarineAisMessageType,
  MarineAisPositionData,
  MarineAisStaticData,
} from "./MarineAisTypes";

/** Đổi hình dạng message của Marine API -> bump để phân biệt observation cũ/mới. */
export const MARINE_AIS_PARSER_VERSION = "marine-ais-v1";

// ---------------------------------------------------------------------------
//  Kết quả
// ---------------------------------------------------------------------------

/**
 * Vì sao một message KHÔNG sinh được nhóm canonical nào.
 *
 * Trả lý do thay vì ném lỗi: một frame rác giữa hàng nghìn frame/giây không
 * được phép làm chết vòng lặp đọc stream ở phase sau. Người gọi muốn đếm/log
 * thì đã có mã lý do sẵn.
 */
export const MarineAisRejectReason = {
  /** `type` không phải PositionReport/ShipStaticData. */
  UNKNOWN_MESSAGE_TYPE: "UNKNOWN_MESSAGE_TYPE",
  /** MMSI không đúng 9 chữ số / bắt đầu bằng 0 -> không gắn được vào tàu nào. */
  INVALID_MMSI: "INVALID_MMSI",
  /** lat/lng ngoài phạm vi (AIS dùng 91.0/181.0 làm sentinel "không có"). */
  INVALID_COORDINATES: "INVALID_COORDINATES",
  /** Không dựng được mốc thời gian THẬT của nguồn — xem §5 tài liệu. */
  INVALID_SOURCE_TIMESTAMP: "INVALID_SOURCE_TIMESTAMP",
  /** ShipStaticData chỉ còn mỗi MMSI: imo/name/type đều là sentinel. */
  EMPTY_IDENTITY: "EMPTY_IDENTITY",
} as const;

export type MarineAisRejectReason =
  (typeof MarineAisRejectReason)[keyof typeof MarineAisRejectReason];

export type MarineAisMappingResult =
  | { readonly ok: true; readonly result: ProviderDetailsResult }
  | { readonly ok: false; readonly reason: MarineAisRejectReason };

function reject(reason: MarineAisRejectReason): MarineAisMappingResult {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
//  Mốc thời gian — phần bắt buộc làm đúng
// ---------------------------------------------------------------------------

/** Lệch đồng hồ cho phép giữa nguồn AIS và bot, dùng chung ngưỡng với ShipFinder. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * `"2026-08-16 12:09:42.123456789 +0000 UTC"` -> `Date`.
 *
 * AISStream.io phát `MetaData.time_utc` theo định dạng in mặc định của Go, và
 * Marine API chuyển tiếp NGUYÊN VĂN chuỗi đó vào `timestamp`. Hàm này chấp nhận:
 *
 *     2026-08-16 12:09:42.123456789 +0000 UTC     (Go, dạng thật đang chạy)
 *     2026-08-16T12:09:42Z                         (ISO 8601)
 *     2026-08-16T12:09:42+07:00                    (ISO 8601 có offset)
 *     2026-08-16 12:09:42                          (trần -> coi là UTC, xem dưới)
 *
 * ⚠️ Vì sao dạng TRẦN được coi là UTC ở đây, trong khi ShipInfo/ShipFinder thì
 * KHÔNG: hai nguồn kia đọc mốc từ HTML không hề khai múi giờ. Ở đây bằng chứng
 * nằm trong code production — `_dataTransform` lấy đúng field tên `time_utc`,
 * và AISStream luôn kèm `+0000 UTC`. Suy luận có neo vào bằng chứng, không phải
 * đoán mò. Nhưng nếu ngày nào đó chuỗi mất hậu tố `+0000 UTC` thì đây là dòng
 * duy nhất cần xem lại.
 *
 * @param value  `timestamp` thô của message.
 * @param now    Đồng hồ BOT, dùng làm lưới chặn mốc rơi vào tương lai.
 * @returns null khi (a) là SỐ — không biết đơn vị giây hay mili-giây nên từ
 *          chối, (b) sai định dạng, hoặc (c) rơi vào tương lai quá `MAX_CLOCK_SKEW_MS`.
 */
export function parseAisSourceInstant(
  value: string | number | null | undefined,
  now: Date
): Date | null {
  // ⛔ Production khai `timestamp: number` nhưng gán một CHUỖI. Nhận số ở đây
  //    buộc phải đoán giây/mili-giây — đoán sai là lệch 1000 lần, và một mốc
  //    sai còn tệ hơn không có mốc.
  if (typeof value !== "string") return null;

  const text = value.trim().replace(/\s+UTC$/i, "").trim();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      text
    );
  if (match === null) return null;

  const [, y, mo, d, h, mi, s, fraction, zone] = match;
  // Cắt (không làm tròn) phần thập phân xuống mili-giây: Go in tới nano-giây.
  const ms = Number((fraction ?? "").padEnd(3, "0").slice(0, 3));

  const utcMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    ms
  );
  if (!Number.isFinite(utcMs)) return null;

  const offsetMs = parseZoneOffsetMs(zone);
  if (offsetMs === null) return null;

  const instantMs = utcMs - offsetMs;
  if (instantMs > now.getTime() + MAX_CLOCK_SKEW_MS) return null;
  return new Date(instantMs);
}

/** `undefined`/`Z` -> 0. `"+07:00"`/`"-0530"` -> số ms. Sai dạng -> null. */
function parseZoneOffsetMs(zone: string | undefined): number | null {
  if (zone === undefined || zone.toUpperCase() === "Z") return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (match === null) return null;
  const [, sign, hours, minutes] = match;
  const magnitude = (Number(hours) * 60 + Number(minutes)) * 60_000;
  return sign === "-" ? -magnitude : magnitude;
}

// ---------------------------------------------------------------------------
//  Metadata
// ---------------------------------------------------------------------------

/**
 * `fetchedAt` = đồng hồ BOT lúc nhận frame. `sourceReceivedAt` = mốc AIS khai.
 *
 * ⚠️ KHÔNG BAO GIỜ gán `sourceReceivedAt = fetchedAt`. Bot nhận lúc 12:10 mà
 * AIS ghi 12:09:42 thì mốc nguồn là 12:09:42 — resolver so độ tươi bằng đúng
 * con số đó (PositionResolverPolicy). Mượn đồng hồ bot là bịa độ tươi.
 */
export function buildMarineAisMetadata(
  fetchedAt: Date,
  sourceReceivedAt: Date | null
): SourceMetadata {
  return createSourceMetadata({
    // Marine API là ĐƯỜNG TRUYỀN, không phải nguồn. Dữ liệu vẫn của AISStream.
    source: VesselSource.AISSTREAM,
    fetchedAt,
    sourceReceivedAt,
  });
}

// ---------------------------------------------------------------------------
//  Khoá tàu
// ---------------------------------------------------------------------------

/**
 * MMSI số -> chuỗi canonical.
 * @returns null khi không phải MMSI của một CON TÀU (validator P1: đúng 9 chữ
 *          số, chữ số đầu khác 0 — đầu 0 là coast station/group call).
 */
function toMmsi(value: number): string | null {
  if (!Number.isInteger(value) || value <= 0) return null;
  const text = String(value);
  return isValidMmsi(text) ? text : null;
}

// ---------------------------------------------------------------------------
//  Nhóm B · Position (message 1/2/3)
// ---------------------------------------------------------------------------

function toSpeed(sog: number): number | null {
  // 102.3 = "không có" theo đặc tả AIS, và validator P1 đã chặn (trần 102.2) —
  // dùng chung validator chính là cách chặn, không cần luật riêng cho sentinel.
  return isValidSpeed(sog) ? sog : null;
}

function toCourse(cog: number): number | null {
  // 360.0 = "không có"; validator yêu cầu [0,360) nên tự loại.
  return isValidCourse(cog) ? cog : null;
}

/**
 * Mã AIS -> `NavigationStatus`.
 *
 * 15 là "undefined (default)" — transponder KHÔNG khai, không phải một trạng
 * thái. Trả null để nó không đếm vào độ đầy đủ chuyển động của resolver.
 * 9..13 là "reserved": giữ `code` (đó là dữ liệu thật) nhưng `text` = null,
 * KHÔNG bịa nhãn.
 */
function toNavStatus(code: number): NavigationStatus | null {
  if (!Number.isInteger(code) || code < 0 || code >= 15) return null;
  return { code, text: NAV_STATUS[code] ?? null };
}

/**
 * @returns null khi MMSI/toạ độ/mốc nguồn không dùng được. `receivedAt` của
 *          canonical LUÔN là mốc NGUỒN — không có mốc nguồn thì không phát ra
 *          báo cáo vị trí (cùng quy ước với ShipInfo/ShipFinder mapper).
 */
export function toVesselPositionReport(
  data: MarineAisPositionData,
  metadata: SourceMetadata
): VesselPositionReport | null {
  const mmsi = toMmsi(data.mmsi);
  if (mmsi === null) return null;

  const [lat, lng] = data.latlng;
  if (!isValidCoordinates(lat, lng)) return null;

  const sourceReceivedAt = metadata.sourceReceivedAt;
  if (!(sourceReceivedAt instanceof Date)) return null;

  return {
    mmsi,
    // PositionReport KHÔNG mang IMO. Để absent, không đi tìm ở message khác.
    imo: null,
    lat,
    lng,
    speed: toSpeed(data.sog),
    course: toCourse(data.cog),
    // ⛔ TUYỆT ĐỐI không `heading = course`. AIS message 1/2/3 CÓ `TrueHeading`
    //    nhưng Marine API không chuyển tiếp -> với bot, heading không tồn tại.
    //    Course là hướng đi trên mặt đất, heading là hướng mũi tàu; tàu bị dòng
    //    chảy ép ngang thì hai giá trị lệch hàng chục độ.
    heading: null,
    navStatus: toNavStatus(data.navigationalStatus),
    // AIS phát toạ độ đầy đủ 1/10000 phút, không bị làm tròn như HTML free.
    latLngApproximate: false,
    receivedAt: sourceReceivedAt,
    metadata,
  };
}

// ---------------------------------------------------------------------------
//  Nhóm A · Identity (message 5)
// ---------------------------------------------------------------------------

/** AIS đệm chuỗi bằng '@'. `"MAERSK@@@@"` -> `"MAERSK"`, `"@@@@"` -> null. */
export function cleanAisText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim().replace(/@+$/, "").trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * `imo: 0` là sentinel "không khai báo" của AIS, KHÔNG phải IMO số 0.
 * Checksum ISO 8713 được kiểm ở đây (validator P1) vì transponder cấu hình sai
 * là chuyện thường gặp — một IMO rác sẽ thành khoá observation rác.
 */
function toImo(value: number): string | null {
  if (!Number.isInteger(value) || value <= 0) return null;
  const text = String(value);
  return isValidImo(text) ? text : null;
}

/** Mã loại tàu AIS: 1..99. 0 = "không có"; >99 là giá trị không hợp lệ. */
function toVesselTypeCode(value: number): number | null {
  if (!Number.isInteger(value) || value < 1 || value > 99) return null;
  return value;
}

/**
 * @returns null khi MMSI không dùng được, hoặc khi message KHÔNG còn thông tin
 *          nào ngoài MMSI (imo/name/type đều là sentinel). Nhóm chỉ có mỗi khoá
 *          là nhóm RỖNG — cùng quy ước "không phát nhóm rỗng" của các mapper
 *          khác, và tránh làm phình `vessel_observations` ở phase sau.
 */
export function toVesselIdentity(
  data: MarineAisStaticData,
  metadata: SourceMetadata
): VesselIdentity | null {
  const mmsi = toMmsi(data.mmsi);
  if (mmsi === null) return null;

  const imo = toImo(data.imo);
  const name = cleanAisText(data.name);
  const vesselTypeCode = toVesselTypeCode(data.type);
  if (imo === null && name === null && vesselTypeCode === null) return null;

  return {
    mmsi,
    imo,
    name,
    // AIS cho MÃ, không cho nhãn chữ. Dựng bảng tra mã -> nhãn là việc riêng,
    // và bịa nhãn ở đây sẽ khiến `vesselType` của AIS chọi với nhãn thật của
    // ShipInfo/ShipFinder trong resolver.
    vesselType: null,
    vesselTypeCode,
    // Marine API không chuyển tiếp callsign (message 5 gốc có).
    callsign: null,
    // Suy cờ từ MID (3 số đầu MMSI) cần bảng tra — chưa có, không đoán.
    flag: null,
    metadata,
  };
}

// ---------------------------------------------------------------------------
//  Điểm vào
// ---------------------------------------------------------------------------

/**
 * Message Marine AIS -> nhóm canonical tương ứng.
 *
 * POSITION và IDENTITY hoàn toàn ĐỘC LẬP, đúng như bản chất AIS: tàu phát
 * `PositionReport` mỗi 2–10 giây nhưng `ShipStaticData` mỗi ~6 phút, nên rất
 * nhiều tàu có vị trí mà chưa từng có tên. Một `PositionReport` chỉ cần MMSI +
 * toạ độ + mốc là ra được observation hợp lệ; không đòi IMO/name/type.
 *
 * @param message    Frame đã qua `isMarineAisMessage`.
 * @param receivedAt Đồng hồ BOT lúc nhận frame -> `metadata.fetchedAt`.
 */
export function mapMarineAisMessage(
  message: MarineAisMessage,
  receivedAt: Date
): MarineAisMappingResult {
  switch (message.type) {
    // Cùng một khuôn: dựng nhóm TRƯỚC, chỉ khi hỏng mới đi tìm lý do. Nhờ vậy
    // đường thành công chạy đúng một lượt kiểm tra, và không có nhánh "không
    // bao giờ tới" nào phải bịa lý do cho đủ kiểu.
    case MarineAisMessageType.POSITION_REPORT: {
      const data = message.data;
      const sourceReceivedAt = parseAisSourceInstant(data.timestamp, receivedAt);
      const position =
        sourceReceivedAt === null
          ? null
          : toVesselPositionReport(data, buildMarineAisMetadata(receivedAt, sourceReceivedAt));
      if (position !== null) return { ok: true, result: { position } };

      if (toMmsi(data.mmsi) === null) return reject(MarineAisRejectReason.INVALID_MMSI);
      if (!isValidCoordinates(data.latlng[0], data.latlng[1])) {
        return reject(MarineAisRejectReason.INVALID_COORDINATES);
      }
      return reject(MarineAisRejectReason.INVALID_SOURCE_TIMESTAMP);
    }

    case MarineAisMessageType.SHIP_STATIC_DATA: {
      const data = message.data;
      // ⚠️ ShipStaticData KHÔNG mang mốc thời gian nào. `sourceReceivedAt` phải
      //    là null — mượn `receivedAt` sẽ biến đồng hồ bot thành mốc của nguồn.
      //    Identity gần như bất biến nên thiếu mốc không ảnh hưởng phân xử.
      const identity = toVesselIdentity(data, buildMarineAisMetadata(receivedAt, null));
      if (identity !== null) return { ok: true, result: { identity } };

      return toMmsi(data.mmsi) === null
        ? reject(MarineAisRejectReason.INVALID_MMSI)
        : reject(MarineAisRejectReason.EMPTY_IDENTITY);
    }

    default:
      return reject(MarineAisRejectReason.UNKNOWN_MESSAGE_TYPE);
  }
}
