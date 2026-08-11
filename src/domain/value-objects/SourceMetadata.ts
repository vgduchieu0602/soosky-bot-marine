// ============================================================================
//  DOMAIN · Value Object: SourceMetadata — provenance của MỘT bản ghi
// ----------------------------------------------------------------------------
//  Multi-source cần trả lời "dữ liệu này của nguồn nào, lấy lúc nào". Hiện tại
//  VesselPosition chỉ có 1 field `source` dạng chuỗi cho cả document và KHÔNG
//  có thời điểm fetch (xem CURRENT_DATA_FLOW.md §8).
//
//  Phân biệt 2 mốc thời gian — đây là lý do tồn tại của value object này:
//    • fetchedAt        : lúc BOT lấy được dữ liệu (luôn có, đồng hồ của ta)
//    • sourceReceivedAt : lúc NGUỒN nói rằng nó nhận được tín hiệu (có thể
//                         thiếu, đồng hồ của nguồn) -> dùng để so độ tươi
//                         giữa các nguồn, không dùng fetchedAt.
//
//  Mọi timestamp là Date UTC (canonical), KHÔNG phải chuỗi ISO như persistence
//  hiện tại. A1 không migrate DB — xem CANONICAL_VESSEL_MODEL.md §6.
// ============================================================================

import { VesselSource } from "./VesselSource";

export interface SourceMetadata {
  /** Nguồn đã cung cấp bản ghi này. */
  readonly source: VesselSource;
  /** Thời điểm bot lấy được dữ liệu (UTC). */
  readonly fetchedAt: Date;
  /** Thời điểm nguồn khai báo đã nhận tín hiệu (UTC). Nguồn không cho -> null. */
  readonly sourceReceivedAt?: Date | null;
  /** Độ tin cậy 0..1 do policy phía sau gán. Chưa có -> null. */
  readonly confidence?: number | null;
}

export interface SourceMetadataProps {
  source: VesselSource;
  fetchedAt: Date;
  sourceReceivedAt?: Date | null;
  confidence?: number | null;
}

/** Date hợp lệ (không phải Invalid Date). */
export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Độ tin cậy: số hữu hạn trong [0, 1]. */
export function isValidConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Dựng SourceMetadata có kiểm tra invariant. Ném lỗi ngay khi dựng thay vì để
 * Invalid Date / confidence rác lan xuống tầng dưới.
 */
export function createSourceMetadata(props: SourceMetadataProps): SourceMetadata {
  if (!isValidDate(props.fetchedAt)) {
    throw new Error("SourceMetadata.fetchedAt phải là Date hợp lệ");
  }
  if (props.sourceReceivedAt != null && !isValidDate(props.sourceReceivedAt)) {
    throw new Error("SourceMetadata.sourceReceivedAt phải là Date hợp lệ hoặc null");
  }
  if (props.confidence != null && !isValidConfidence(props.confidence)) {
    throw new Error("SourceMetadata.confidence phải nằm trong [0, 1]");
  }
  return {
    source: props.source,
    fetchedAt: props.fetchedAt,
    sourceReceivedAt: props.sourceReceivedAt ?? null,
    confidence: props.confidence ?? null,
  };
}
