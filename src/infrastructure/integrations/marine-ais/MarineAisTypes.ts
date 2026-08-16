// ============================================================================
//  INFRASTRUCTURE · DTO của message mà Soosky-marine-api ĐANG broadcast
// ----------------------------------------------------------------------------
//  Đây là INTEGRATION BOUNDARY, KHÔNG phải canonical entity. Mỗi field dưới đây
//  là một field THẬT trong payload production, sao chép theo HÌNH DẠNG chứ không
//  import code:
//
//      soosky-marine-api/src/domain/service/AisDataService.ts   (type AisMessage)
//      soosky-marine-api/src/adapter/ais-stream/AisWebSocketManager.ts
//                                                        (_dataTransform)
//
//  Hai repository phải biên dịch ĐỘC LẬP -> tuyệt đối không `import` chéo. Đổi
//  lại, mọi sai lệch giữa hai bên phải bị bắt bằng audit + test, không bằng
//  compiler. Xem docs/AIS_CANONICAL_INGESTION.md §2.
//
//  ⛔ File này KHÔNG mở WebSocket, không biết Marine API tồn tại ở URL nào.
// ============================================================================

/**
 * Nhãn loại message. Giá trị TRÙNG KHỚP `AisMessageType` của production
 * ("PositionReport" / "ShipStaticData") — đây là dây nối duy nhất giữa hai repo
 * nên phải viết đúng từng ký tự.
 */
export const MarineAisMessageType = {
  POSITION_REPORT: "PositionReport",
  SHIP_STATIC_DATA: "ShipStaticData",
} as const;

export type MarineAisMessageType =
  (typeof MarineAisMessageType)[keyof typeof MarineAisMessageType];

/**
 * Payload `PositionReport` — sinh từ AIS message 1/2/3 sau khi Marine API rút
 * gọn. Nguyên văn production:
 *
 *     mmsi:               data.MetaData.MMSI
 *     latlng:             [Message.PositionReport.Latitude, ....Longitude]
 *     sog:                Message.PositionReport.Sog
 *     cog:                Message.PositionReport.Cog
 *     timestamp:          data.MetaData.time_utc
 *     navigationalStatus: Message.PositionReport.NavigationalStatus
 */
export interface MarineAisPositionData {
  /** AIS phát MMSI dạng SỐ. Canonical dùng chuỗi -> mapper quy đổi. */
  mmsi: number;
  /** `[lat, lng]` — thứ tự do production quy định, KHÔNG được hoán đổi. */
  latlng: [number, number];
  /** SOG, knots. 102.3 = "không có" theo đặc tả AIS. */
  sog: number;
  /** COG, degrees. 360.0 = "không có" theo đặc tả AIS. */
  cog: number;
  /**
   * ⚠️ TYPE THẬT KHÔNG KHỚP KHAI BÁO CỦA PRODUCTION.
   *
   * `AisDataService.ts` khai `timestamp: number`, nhưng `_dataTransform` gán
   * `data.MetaData.time_utc` — và AISStream.io phát field đó dạng CHUỖI giờ Go:
   * `"2026-08-16 12:09:42.123456789 +0000 UTC"`.
   *
   * Nên ở ranh giới này ta khai `string | number` để phản ánh CẢ hợp đồng khai
   * báo lẫn giá trị chạy thật. Mapper xử lý chuỗi; số bị TỪ CHỐI vì không có
   * cách nào biết đơn vị là giây hay mili-giây (sai 1000 lần).
   * Xem docs/AIS_CANONICAL_INGESTION.md §5.
   */
  timestamp: string | number;
  /** Mã trạng thái hành hải AIS 0..15. 15 = undefined (mặc định của transponder). */
  navigationalStatus: number;
}

/**
 * Payload `ShipStaticData` — AIS message 5 sau khi Marine API rút gọn xuống
 * ĐÚNG BỐN field. Nguyên văn production:
 *
 *     mmsi: data.MetaData.MMSI
 *     imo:  Message.ShipStaticData.ImoNumber
 *     type: Message.ShipStaticData.Type
 *     name: data.MetaData.ShipName
 *
 * ⚠️ `callsign`, `Dimension` (length/beam), `MaximumStaticDraught`,
 * `Destination`, `Eta` CÓ trong message 5 gốc của AISStream nhưng production
 * KHÔNG chuyển tiếp. Với bot, chúng không tồn tại.
 */
export interface MarineAisStaticData {
  mmsi: number;
  /** 0 = "không khai báo". KHÔNG phải IMO số 0. */
  imo: number;
  /** Mã loại tàu AIS 0..99. 0 = "không có". */
  type: number;
  /** AIS đệm tên bằng ký tự '@'. Chuỗi rỗng = "không khai báo". */
  name: string;
}

export interface MarineAisPositionMessage {
  type: typeof MarineAisMessageType.POSITION_REPORT;
  data: MarineAisPositionData;
}

export interface MarineAisStaticMessage {
  type: typeof MarineAisMessageType.SHIP_STATIC_DATA;
  data: MarineAisStaticData;
}

/** Union có discriminant `type`, khớp `AisMessage` của production. */
export type MarineAisMessage = MarineAisPositionMessage | MarineAisStaticMessage;

// ---------------------------------------------------------------------------
//  Type guard — frame đến từ `JSON.parse`, không có gì bảo đảm hình dạng
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLatLngPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
}

/**
 * Nhận diện frame ĐÚNG HÌNH DẠNG.
 *
 * ⚠️ CHỈ kiểm tra hình dạng, KHÔNG kiểm tra ý nghĩa: MMSI 0, toạ độ 91.0, IMO
 * sai checksum đều lọt qua đây. Phân biệt "sai cấu trúc" (nguồn đổi contract)
 * với "giá trị không dùng được" (tàu phát dữ liệu rác) là hai việc khác nhau —
 * việc thứ hai thuộc mapper + validator canonical.
 */
export function isMarineAisMessage(value: unknown): value is MarineAisMessage {
  if (!isRecord(value) || !isRecord(value.data)) return false;

  if (value.type === MarineAisMessageType.POSITION_REPORT) {
    const data = value.data;
    return (
      isFiniteNumber(data.mmsi) &&
      isLatLngPair(data.latlng) &&
      isFiniteNumber(data.sog) &&
      isFiniteNumber(data.cog) &&
      isFiniteNumber(data.navigationalStatus) &&
      (typeof data.timestamp === "string" || isFiniteNumber(data.timestamp))
    );
  }

  if (value.type === MarineAisMessageType.SHIP_STATIC_DATA) {
    const data = value.data;
    return (
      isFiniteNumber(data.mmsi) &&
      isFiniteNumber(data.imo) &&
      isFiniteNumber(data.type) &&
      typeof data.name === "string"
    );
  }

  return false;
}
