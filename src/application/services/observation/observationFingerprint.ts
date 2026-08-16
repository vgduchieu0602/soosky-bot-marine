// ============================================================================
//  APPLICATION · Vân tay observation — để không lưu 4 lần cùng một sự thật
// ----------------------------------------------------------------------------
//  Crawler chạy 4 vòng trong 4 phút, tàu đang neo, nguồn trả y hệt nhau -> 4
//  bản ghi giống nhau, không thêm một chút thông tin nào.
//
//  Vân tay gồm: source + type + khoá tàu + dữ liệu đã chuẩn hoá + sourceReceivedAt.
//
//  KHÔNG gồm:
//    • fetchedAt          — mỗi lần lấy một khác, đưa vào là dedupe chết hẳn.
//    • data.metadata      — bên trong CÓ fetchedAt (SourceMetadata) -> phải bóc
//                           ra, nếu không mọi vân tay đều khác nhau.
//    • data.receivedAt    — CÙNG LÝ DO. Nguồn không kèm mốc thời gian (mp2 của
//                           VesselFinder chẳng hạn) thì `receivedAt` chính là
//                           đồng hồ của bot lúc quét. Giữ nó lại thì mỗi vòng
//                           quét sinh một vân tay mới và dedupe vô tác dụng.
//                           Mốc thời gian THẬT của nguồn nằm ở `sourceReceivedAt`,
//                           và nó CÓ trong vân tay.
//    • validation, rawPayload, parserVersion, id — không phải điều nguồn nói.
//
//  Dùng node:crypto có sẵn. Không thêm package chỉ để băm.
// ============================================================================

import { createHash } from "node:crypto";
import { VesselObservationType, VesselSourceObservation } from "../../../domain/entities/VesselObservation";
import { VesselSource } from "../../../domain/enums/VesselSource";

/**
 * Chuẩn hoá ổn định: khoá object được SẮP XẾP, Date -> ISO, giá trị rỗng bị
 * LOẠI BỎ. Nhờ vậy `{a:1,b:2}` và `{b:2,a:1}` cho cùng chuỗi, và `{speed:null}`
 * bằng `{}` — cả hai đều nghĩa là "không có tốc độ".
 */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const normalized = normalize(source[key]);
      // Bỏ hẳn khoá rỗng -> thiếu field và field=null là một.
      if (normalized === null) continue;
      out[key] = normalized;
    }
    return out;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return value;
}

/**
 * Bỏ hai thứ mang ĐỒNG HỒ CỦA TA khỏi payload: `metadata` (chứa fetchedAt) và
 * `receivedAt` (bằng fetchedAt khi nguồn không tự cấp mốc thời gian).
 */
function payloadOf(observation: VesselSourceObservation): Record<string, unknown> {
  const {
    metadata: _metadata,
    receivedAt: _receivedAt,
    ...rest
  } = observation.data as unknown as Record<string, unknown>;
  return rest;
}

export interface FingerprintInput {
  source: VesselSource;
  type: VesselObservationType;
  vesselKey: { mmsi?: string; imo?: string };
  sourceReceivedAt?: Date | null;
  payload: unknown;
}

export function fingerprintOf(input: FingerprintInput): string {
  const canonical = stableSerialize({
    source: input.source,
    type: input.type,
    mmsi: input.vesselKey.mmsi ?? null,
    imo: input.vesselKey.imo ?? null,
    sourceReceivedAt: input.sourceReceivedAt ?? null,
    payload: input.payload,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Vân tay của một observation.
 *
 * ⚠️ KHÔNG làm tròn toạ độ trước khi băm. lat 10 và lat 10.001 là HAI quan sát
 * khác nhau — tàu đã đi. Dedupe theo vùng gần đúng là bài toán khác, không làm
 * ở P5. Chỉ so khớp CHÍNH XÁC sau chuẩn hoá.
 */
export function observationFingerprint(observation: VesselSourceObservation): string {
  return fingerprintOf({
    source: observation.source,
    type: observation.type,
    vesselKey: observation.vesselKey,
    sourceReceivedAt: observation.sourceReceivedAt,
    payload: payloadOf(observation),
  });
}
