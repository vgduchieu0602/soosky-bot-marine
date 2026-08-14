// ============================================================================
//  DOMAIN · Value Object: VesselIdentifier — "tra tàu này BẰNG GÌ"
// ----------------------------------------------------------------------------
//  Code hiện tại truyền `id: string` cho mọi thứ (`getDetails(id)`), rồi để
//  VesselFinder tự đoán đó là IMO hay MMSI qua redirect. Nguồn khác KHÔNG có
//  redirect đó — nguồn nào cũng cần biết rõ đang tra theo trục nào.
//
//  Union có discriminant -> provider `switch (identifier.type)` là đủ, không
//  phải đoán theo độ dài chuỗi.
//
//  KHÔNG có biến thể NAME: tìm theo tên là OPERATION riêng (searchByName), trả
//  về nhiều ứng viên, khác hẳn tra theo định danh duy nhất.
//
//  ⚠️ Không thay đổi API hiện tại. `GetVesselDetails` vẫn nhận string và vẫn
//  validate bằng `^\d{7,9}$` như cũ — value object này chỉ dùng ở tầng provider
//  mới (P3), xem PROVIDER_ARCHITECTURE.md §6.
// ============================================================================

import { isValidImo, isValidMmsi } from "../validators/identifiers";

export interface MmsiIdentifier {
  readonly type: "MMSI";
  readonly value: string;
}

export interface ImoIdentifier {
  readonly type: "IMO";
  readonly value: string;
}

export type VesselIdentifier = MmsiIdentifier | ImoIdentifier;

export type VesselIdentifierType = VesselIdentifier["type"];

function normalizeDigits(value: string | number): string {
  return typeof value === "number" ? String(value) : value.trim();
}

/**
 * MMSI 9 chữ số, chữ số đầu khác 0 (validator A1).
 * @throws Error khi không hợp lệ — định danh rác không được phép đi tiếp tới
 *         provider rồi mới hỏng ở tầng HTTP.
 */
export function mmsiIdentifier(value: string | number): MmsiIdentifier {
  const digits = normalizeDigits(value);
  if (!isValidMmsi(digits)) {
    throw new Error(`MMSI không hợp lệ: "${digits}" (cần 9 chữ số, không bắt đầu bằng 0)`);
  }
  return Object.freeze({ type: "MMSI", value: digits });
}

/**
 * IMO 7 chữ số VÀ đúng chữ số kiểm tra ISO 8713 (validator A1).
 * @throws Error khi sai số chữ số hoặc sai checksum.
 */
export function imoIdentifier(value: string | number): ImoIdentifier {
  const digits = normalizeDigits(value);
  if (!isValidImo(digits)) {
    throw new Error(`IMO không hợp lệ: "${digits}" (cần 7 chữ số đúng checksum ISO 8713)`);
  }
  return Object.freeze({ type: "IMO", value: digits });
}

/**
 * Đoán trục từ một chuỗi id kiểu cũ (watchlist, `/vessel/:id`) — MMSI trước,
 * IMO sau. Dùng khi migrate call site cũ; không dùng khi đã biết rõ trục.
 * @returns null nếu không khớp trục nào (KHÔNG ném: dữ liệu cũ trong DB không
 *          được phép làm sập tiến trình).
 */
export function parseVesselIdentifier(raw: unknown): VesselIdentifier | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const digits = normalizeDigits(raw);
  if (isValidMmsi(digits)) return Object.freeze({ type: "MMSI", value: digits });
  if (isValidImo(digits)) return Object.freeze({ type: "IMO", value: digits });
  return null;
}

export function isVesselIdentifier(value: unknown): value is VesselIdentifier {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; value?: unknown };
  if (typeof candidate.value !== "string") return false;
  if (candidate.type === "MMSI") return isValidMmsi(candidate.value);
  if (candidate.type === "IMO") return isValidImo(candidate.value);
  return false;
}

/** Hiển thị/log: `MMSI:305803000`. */
export function formatVesselIdentifier(identifier: VesselIdentifier): string {
  return `${identifier.type}:${identifier.value}`;
}
