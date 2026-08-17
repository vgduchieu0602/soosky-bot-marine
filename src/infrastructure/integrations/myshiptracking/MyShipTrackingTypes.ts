// ============================================================================
//  INFRASTRUCTURE · DTO của MyShipTracking Vessel Current-Position API
// ----------------------------------------------------------------------------
//  Nguồn: https://api.myshiptracking.com/docs/vessel-current-position-api
//  Audit đầy đủ: docs/sources/MYSHIPTRACKING_AUDIT.md · docs/MYSHIPTRACKING_PAID_POSITION.md
//
//  ⚠️ NGUỒN TRẢ TIỀN. Mỗi response có kết quả tốn credit thật. File này chỉ mô
//     tả hình dạng — không dòng nào chạm mạng.
//
//  ⛔ CHỈ endpoint vị trí hiện tại. Không bulk, không history, không zone/port.
// ============================================================================

export const MYSHIPTRACKING_DEFAULT_BASE_URL = "https://api.myshiptracking.com";
export const MYSHIPTRACKING_VESSEL_PATH = "/api/v2/vessel";

/**
 * ⚠️ TRACK-1 CHỈ dùng `simple` (1 credit). `extended` tốn **3 credit** và chỉ
 * thêm nhóm tĩnh/cảng — thứ mà đường free đã lo. Trả gấp ba tiền cho dữ liệu
 * đang có miễn phí là đúng thứ `PaidFallbackGate` tồn tại để ngăn.
 */
export const MyShipTrackingResponseType = {
  SIMPLE: "simple",
  EXTENDED: "extended",
} as const;

export type MyShipTrackingResponseType =
  (typeof MyShipTrackingResponseType)[keyof typeof MyShipTrackingResponseType];

/** Chi phí công bố, tính bằng credit. */
export const MYSHIPTRACKING_CREDIT_COST: Readonly<Record<MyShipTrackingResponseType, number>> =
  Object.freeze({
    [MyShipTrackingResponseType.SIMPLE]: 1,
    [MyShipTrackingResponseType.EXTENDED]: 3,
  });

/** Header nguồn trả về khi có tính phí. Vắng mặt -> KHÔNG được bịa ra con số. */
export const CREDIT_CHARGED_HEADER = "x-credit-charged";

/**
 * `data` của `response=simple` — đúng mười field tài liệu liệt kê.
 *
 * ⚠️ Kiểu ở đây là kiểu TÀI LIỆU KHAI, không phải bảo đảm. Response đi qua
 * `JSON.parse` nên mọi field đều phải kiểm trước khi map (xem mapper).
 * ⚠️ `nav_status` khai là **text**, không phải mã AIS số.
 * ⚠️ Không có `heading` — cả simple lẫn extended. ShipFinder (miễn phí) thì có.
 */
export interface MyShipTrackingSimpleData {
  vessel_name?: string;
  mmsi?: number;
  imo?: number;
  /** Mã loại tàu (int). */
  vtype?: number;
  lat?: number;
  lng?: number;
  course?: number;
  /** SOG, knots. */
  speed?: number;
  nav_status?: string;
  /** ISO-8601 UTC, VD `2026-08-15T22:47:28Z`. Mốc NGUỒN khai. */
  received?: string;
}

export interface MyShipTrackingSuccessEnvelope {
  status: "success";
  duration?: string;
  timestamp?: string;
  data?: MyShipTrackingSimpleData;
}

export interface MyShipTrackingErrorEnvelope {
  status: "error";
  duration?: string;
  timestamp?: string;
  /** VD `ERR_NO_CREDITS`, `ERR_VESSEL_NOT_FOUND`, `ERR_RATE_LIMIT`. */
  code?: string;
  message?: string;
}

export type MyShipTrackingEnvelope =
  | MyShipTrackingSuccessEnvelope
  | MyShipTrackingErrorEnvelope;

/** Mã lỗi tài liệu công bố. Dùng để phân loại, không phải để hiển thị. */
export const MyShipTrackingErrorCode = {
  VALIDATOR: "MST_ERR_VALIDATOR",
  INVALID_IDENTIFIER: "ERR_INVALID_IDENTIFIER",
  NO_KEY: "ERR_NO_KEY",
  INVALID_KEY: "ERR_INVALID_KEY",
  NO_ACCESS: "ERR_NOACCESS",
  NO_CREDITS: "ERR_NO_CREDITS",
  VESSEL_NOT_FOUND: "ERR_VESSEL_NOT_FOUND",
  RATE_LIMIT: "ERR_RATE_LIMIT",
  INTERNAL: "ERR_INTERNAL",
} as const;

export type MyShipTrackingErrorCode =
  (typeof MyShipTrackingErrorCode)[keyof typeof MyShipTrackingErrorCode];
