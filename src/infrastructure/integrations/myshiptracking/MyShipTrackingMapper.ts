// ============================================================================
//  INFRASTRUCTURE · MyShipTrackingMapper — DTO trả tiền -> canonical. HÀM THUẦN.
// ----------------------------------------------------------------------------
//  Không mạng, không DB. Dùng lại NGUYÊN validator P1 — không có validator
//  riêng cho nguồn trả tiền, vì ranh giới của dữ liệu không đổi theo giá tiền.
//
//  Nguyên tắc như mọi mapper khác: THIẾU HOẶC KHÔNG CHẮC THÌ ĐỂ THIẾU.
// ============================================================================

import { ProviderDetailsResult } from "../../../application/contracts/providers/ProviderResults";
import { VesselIdentity } from "../../../domain/value-objects/VesselIdentity";
import {
  NavigationStatus,
  VesselPositionReport,
} from "../../../domain/value-objects/VesselPositionReport";
import { SourceMetadata, createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { isValidCoordinates } from "../../../domain/validators/geo";
import { isValidImo, isValidMmsi } from "../../../domain/validators/identifiers";
import { isValidCourse, isValidSpeed } from "../../../domain/validators/motion";
import { MyShipTrackingSimpleData } from "./MyShipTrackingTypes";

export const MYSHIPTRACKING_PARSER_VERSION = "myshiptracking-v2-simple";

/** MMSI số -> chuỗi canonical. Sai định dạng -> null. */
function toMmsi(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  const text = String(value);
  return isValidMmsi(text) ? text : null;
}

/** `imo: 0` là "không khai". Sai checksum ISO 8713 cũng bị loại. */
function toImo(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  const text = String(value);
  return isValidImo(text) ? text : null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Mã loại tàu AIS 1..99. `0`/ngoài dải -> null. */
function toVesselTypeCode(value: unknown): number | null {
  const code = toFiniteNumber(value);
  if (code === null || !Number.isInteger(code) || code < 1 || code > 99) return null;
  return code;
}

/**
 * `received` -> mốc NGUỒN.
 *
 * Tài liệu khai ISO-8601 kèm `Z` (`"2026-08-15T22:47:28Z"`) — khác hẳn ShipFinder
 * vốn không khai múi giờ ở đâu cả và phải bắt người vận hành ký tên vào một giả
 * định. Ở đây có `Z` nên đọc thẳng.
 *
 * ⚠️ Chuỗi hỏng -> `null`, TUYỆT ĐỐI không thay bằng `now`: biến dữ liệu không
 * rõ tuổi thành "vừa mới" là đúng thứ làm hỏng mọi so sánh độ tươi sau này.
 */
export function parseReceivedAt(value: unknown): Date | null {
  const text = cleanText(value);
  if (text === null) return null;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * ⚠️ `nav_status` của `simple` là **CHỮ**, không phải mã AIS số (khác AIS-1,
 * nơi Marine chuyển tiếp mã). Nên chỉ điền `text`, để `code = null` — không
 * dựng bảng tra chữ -> mã, vì so khớp chuỗi rất dễ vỡ khi nguồn đổi cách viết.
 */
function toNavStatus(value: unknown): NavigationStatus | null {
  const text = cleanText(value);
  if (text !== null) return { code: null, text };
  // The field table says text, but the official response example currently uses 0.
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 15) {
    return { code: value, text: null };
  }
  return null;
}

export function buildMyShipTrackingMetadata(
  fetchedAt: Date,
  sourceReceivedAt: Date | null
): SourceMetadata {
  return createSourceMetadata({
    source: VesselSource.MYSHIPTRACKING,
    fetchedAt,
    sourceReceivedAt,
  });
}

/**
 * `data` của `response=simple` -> `ProviderDetailsResult`.
 *
 * @returns nhóm nào dựng được thì có; `{}` khi không dựng được nhóm nào (VD
 *          MMSI rác). Người gọi coi `{}` là "không có dữ liệu dùng được".
 */
export function toProviderResult(
  data: MyShipTrackingSimpleData,
  fetchedAt: Date
): ProviderDetailsResult {
  const mmsi = toMmsi(data.mmsi);
  if (mmsi === null) return {};

  const imo = toImo(data.imo);
  const receivedAt = parseReceivedAt(data.received);
  const metadata = buildMyShipTrackingMetadata(fetchedAt, receivedAt);

  const result: { identity?: VesselIdentity; position?: VesselPositionReport } = {};

  const name = cleanText(data.vessel_name);
  const vesselTypeCode = toVesselTypeCode(data.vtype);
  // Không phát nhóm rỗng: identity chỉ có mỗi MMSI thì không nói thêm được gì.
  if (name !== null || imo !== null || vesselTypeCode !== null) {
    result.identity = {
      mmsi,
      imo,
      name,
      callsign: null,
      // API cho MÃ, không cho nhãn chữ ở `simple`. Không bịa nhãn.
      vesselType: null,
      vesselTypeCode,
      flag: null,
      metadata,
    };
  }

  const lat = toFiniteNumber(data.lat);
  const lng = toFiniteNumber(data.lng);
  // Canonical bắt buộc `receivedAt` là Date. Không có mốc nguồn -> KHÔNG phát
  // nhóm vị trí (cùng quy ước ShipInfo/ShipFinder/AIS mapper).
  if (isValidCoordinates(lat, lng) && receivedAt !== null) {
    const speed = toFiniteNumber(data.speed);
    const course = toFiniteNumber(data.course);
    result.position = {
      mmsi,
      imo,
      lat: lat as number,
      lng: lng as number,
      speed: speed !== null && isValidSpeed(speed) ? speed : null,
      course: course !== null && isValidCourse(course) ? course : null,
      // ⚠️ Response KHÔNG có `heading` — cả simple lẫn extended. ShipFinder
      //    (miễn phí) thì có. Nguồn trả tiền thua nguồn free đúng ở field này.
      heading: null,
      navStatus: toNavStatus(data.nav_status),
      latLngApproximate: false,
      receivedAt,
      metadata,
    };
  }

  return result;
}
