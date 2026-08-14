// ============================================================================
//  DOMAIN · VesselSourceObservation — "nguồn X đã NÓI GÌ, lúc nào"
// ----------------------------------------------------------------------------
//  Đây KHÔNG phải trạng thái hiện tại của con tàu. Đây là lời khai của một
//  nguồn tại một thời điểm.
//
//  ShipInfo bảo speed=12, VesselFinder bảo speed=13 -> LƯU CẢ HAI, mỗi cái một
//  observation. P5 không hỏi ai đúng. Việc phân xử là của resolver (chưa có).
//
//  Đối lập trực tiếp với `latestpositions` hiện tại: ở đó `replaceOne` theo mmsi
//  khiến nguồn ghi sau XOÁ SẠCH nguồn ghi trước, không truy vết được
//  (CURRENT_DATA_FLOW.md §3). Observation là append-only, không ai đè ai.
//
//  BẤT BIẾN: đã ghi thì không sửa. Nguồn nói khác đi -> observation MỚI.
// ============================================================================

import { VesselIdentity } from "../canonical/VesselIdentity";
import { VesselParticulars } from "../canonical/VesselParticulars";
import { VesselPositionReport } from "../canonical/VesselPositionReport";
import { VesselVoyage } from "../canonical/VesselVoyage";
import { isValidImo, isValidMmsi } from "../validators/identifiers";
import { VesselSource } from "../value-objects/VesselSource";
import { ObservationValidation } from "./ObservationValidation";

/** Observation đại diện cho nhóm canonical nào. */
export const VesselObservationType = {
  IDENTITY: "IDENTITY",
  POSITION: "POSITION",
  PARTICULARS: "PARTICULARS",
  VOYAGE: "VOYAGE",
} as const;

export type VesselObservationType =
  (typeof VesselObservationType)[keyof typeof VesselObservationType];

export const VESSEL_OBSERVATION_TYPES: readonly VesselObservationType[] = Object.freeze(
  Object.values(VesselObservationType) as VesselObservationType[]
);

/**
 * Định danh tàu Ở MỨC OBSERVATION.
 *
 * CHỈ CẦN MỘT trong hai. Cố ý không bắt buộc MMSI: nguồn tra cứu lý lịch
 * (ShipInfo, ShipTraffic) tìm theo IMO và có thể chưa biết MMSI. Bắt buộc MMSI
 * ở đây sẽ khiến những nguồn đó không lưu được gì.
 */
export interface VesselObservationKey {
  readonly mmsi?: string;
  readonly imo?: string;
}

interface BaseObservation {
  /** Do storage gán khi đọc lại. Chưa lưu -> undefined. */
  readonly id?: string;
  readonly source: VesselSource;
  readonly vesselKey: VesselObservationKey;
  /** Lúc BOT lấy được dữ liệu. Luôn có (đồng hồ của ta). */
  readonly fetchedAt: Date;
  /**
   * Lúc NGUỒN nói nó nhận được tín hiệu. Nguồn không cho -> null.
   * TUYỆT ĐỐI không gán bằng fetchedAt: đó là bịa độ tươi.
   */
  readonly sourceReceivedAt?: Date | null;
  readonly validation: ObservationValidation;
  /** VD "vesselfinder-html-v1". Nguồn đổi HTML -> bump version, phân biệt được. */
  readonly parserVersion?: string;
  /** Giữ theo RawPayloadPolicy, đã sanitize + cắt bớt. */
  readonly rawPayload?: unknown;
  readonly rawPayloadTruncated?: boolean;
}

export interface IdentityObservation extends BaseObservation {
  readonly type: typeof VesselObservationType.IDENTITY;
  readonly data: VesselIdentity;
}

export interface PositionObservation extends BaseObservation {
  readonly type: typeof VesselObservationType.POSITION;
  readonly data: VesselPositionReport;
}

export interface ParticularsObservation extends BaseObservation {
  readonly type: typeof VesselObservationType.PARTICULARS;
  readonly data: VesselParticulars;
}

export interface VoyageObservation extends BaseObservation {
  readonly type: typeof VesselObservationType.VOYAGE;
  readonly data: VesselVoyage;
}

/**
 * Union có discriminant `type` -> POSITION observation KHÔNG THỂ vô tình mang
 * VesselVoyage. TypeScript chặn ngay lúc biên dịch.
 */
export type VesselSourceObservation =
  | IdentityObservation
  | PositionObservation
  | ParticularsObservation
  | VoyageObservation;

/** Bỏ chuỗi rỗng/khoảng trắng -> undefined. */
function normalizeId(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Dựng khoá đã chuẩn hoá.
 * @throws Error khi KHÔNG có cả mmsi lẫn imo — observation không gắn được vào
 *         con tàu nào thì lưu cũng vô nghĩa.
 *
 * ⚠️ Ở ĐÂY chỉ kiểm tra CÓ MẶT, không kiểm tra hợp lệ. Định danh sai định dạng
 * vẫn được lưu kèm issue để debug parser — xem `validateObservation`.
 */
export function createObservationKey(props: {
  mmsi?: string | null;
  imo?: string | null;
}): VesselObservationKey {
  const mmsi = normalizeId(props.mmsi);
  const imo = normalizeId(props.imo);
  if (mmsi === undefined && imo === undefined) {
    throw new Error("VesselObservationKey phải có ít nhất một trong MMSI hoặc IMO");
  }
  return Object.freeze({ mmsi, imo });
}

/** Khoá có ÍT NHẤT một định danh ĐÚNG ĐỊNH DẠNG. */
export function hasUsableIdentifier(key: VesselObservationKey): boolean {
  return isValidMmsi(key.mmsi) || isValidImo(key.imo);
}

/** Nhãn ngắn cho log: `mmsi=305803000` / `imo=9074729`. */
export function formatObservationKey(key: VesselObservationKey): string {
  const parts: string[] = [];
  if (key.mmsi !== undefined) parts.push(`mmsi=${key.mmsi}`);
  if (key.imo !== undefined) parts.push(`imo=${key.imo}`);
  return parts.join(" ");
}
