// ============================================================================
//  DOMAIN · Cầu nối: entity ĐANG CHẠY -> canonical model
// ----------------------------------------------------------------------------
//  ⚠️ KHÔNG use case / repository / route nào gọi các hàm này. Chúng tồn tại để
//  (1) chứng minh canonical model biểu diễn được TOÀN BỘ dữ liệu hiện có,
//  (2) khoá lại bằng test cái mapping mà tài liệu mô tả — tài liệu lệch code
//      là đúng thứ audit A0 đã tìm thấy (CURRENT_ARCHITECTURE.md §6 D-7).
//
//  Chiều ngược lại (canonical -> entity) CỐ Ý không viết: A1 không đổi
//  persistence, không có ai cần ghi ngược.
//
//  Hàm thuần: không I/O, không đồng hồ hệ thống (fetchedAt do người gọi đưa).
// ============================================================================

import { Vessel } from "../entities/Vessel";
import { VesselPosition } from "../entities/VesselPosition";
import { SourceMetadata } from "../value-objects/SourceMetadata";
import { isValidCoordinates } from "../validators/geo";
import { VesselIdentity, VesselFlag } from "./VesselIdentity";
import { VesselParticulars } from "./VesselParticulars";
import { VesselPositionReport } from "./VesselPositionReport";
import { VesselVoyage } from "./VesselVoyage";

/**
 * Chuỗi -> Date UTC. Không parse được -> null.
 * Persistence hiện lưu receivedAt dạng chuỗi ISO; canonical dùng Date.
 */
export function parseTimestamp(value: string | null | undefined): Date | null {
  if (value == null || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** Nhóm A. `country` (nhãn "AIS Flag") -> flag.name; `flagCode` -> flag.code. */
export function toVesselIdentity(vessel: Vessel, metadata: SourceMetadata): VesselIdentity {
  const flag: VesselFlag | null =
    vessel.flagCode == null && vessel.country == null
      ? null
      : { code: vessel.flagCode, name: vessel.country };

  return {
    mmsi: vessel.mmsi,
    imo: vessel.imo,
    name: vessel.name,
    callsign: vessel.callsign,
    vesselType: vessel.type,
    // Entity cũ KHÔNG có mã loại tàu — mapper VesselFinder bỏ qua #djson.ship_type.
    vesselTypeCode: null,
    flag,
    metadata,
  };
}

/** Nhóm C. Đổi tên có hậu tố đơn vị -> tên canonical; giá trị giữ nguyên mét. */
export function toVesselParticulars(vessel: Vessel, metadata: SourceMetadata): VesselParticulars {
  return {
    mmsi: vessel.mmsi,
    imo: vessel.imo,
    grossTonnage: vessel.grossTonnage,
    deadweight: vessel.deadweight,
    builtYear: vessel.yearBuilt,
    length: vessel.lengthM,
    beam: vessel.widthM,
    draught: vessel.draughtM,
    metadata,
  };
}

/**
 * Nhóm B.
 * @returns null khi entity cũ thiếu khoá hoặc thiếu toạ độ — canonical bắt
 *          buộc mmsi + lat/lng, còn entity cũ cho phép cả ba là null.
 */
export function toVesselPositionReport(
  position: VesselPosition,
  metadata: SourceMetadata
): VesselPositionReport | null {
  if (position.mmsi === null) return null;
  if (!isValidCoordinates(position.lat, position.lon)) return null;

  const receivedAt = parseTimestamp(position.receivedAt);
  if (receivedAt === null) return null;

  const navStatus =
    position.navStatusCode == null && position.navStatusText === "Unknown"
      ? null
      : { code: position.navStatusCode, text: position.navStatusText };

  return {
    mmsi: position.mmsi,
    imo: position.imo,
    lat: position.lat as number,
    lng: position.lon as number,
    speed: position.speedKn,
    course: position.courseDeg,
    heading: position.headingDeg,
    navStatus,
    latLngApproximate: position.latLonApproximate,
    receivedAt,
    metadata,
  };
}

/**
 * Nhóm D.
 * `positionTime` của entity cũ (VD "0 min ago") KHÔNG được dùng làm mốc thời
 * gian: nó là chuỗi tương đối, parse ra sẽ sai. Cảng thì entity cũ không có.
 * @returns null khi thiếu khoá mmsi.
 */
export function toVesselVoyage(
  position: VesselPosition,
  metadata: SourceMetadata
): VesselVoyage | null {
  if (position.mmsi === null) return null;
  return {
    mmsi: position.mmsi,
    imo: position.imo,
    destination: position.destination,
    eta: parseTimestamp(position.eta),
    currentPort: null,
    currentPortArrivalAt: null,
    nextPort: null,
    nextPortEta: null,
    lastPort: null,
    lastPortDepartureAt: null,
    metadata,
  };
}
