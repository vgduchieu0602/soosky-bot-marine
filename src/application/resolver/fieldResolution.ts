// ============================================================================
//  APPLICATION · Bộ khung nhỏ để phân xử MỘT field. Hàm thuần.
// ----------------------------------------------------------------------------
//  Vì sao tồn tại: Identity và Particulars làm y hệt nhau ở phần khung —
//  gom ứng viên non-null, kiểm "có thật sự khác nhau không", rồi áp một chuỗi
//  tiêu chí. Chỉ phần SO SÁNH và CHUỖI TIÊU CHÍ là khác. Viết hai lần thì hai
//  bản sẽ lệch nhau.
//
//  ⚠️ Đây KHÔNG phải "generic field resolution engine": không class, không kế
//  thừa, không đăng ký động, không chấm điểm. Ba hàm thuần và một danh sách
//  tiêu chí truyền vào. PositionResolver KHÔNG dùng file này và không bị đụng —
//  nhóm POSITION là nguyên khối, bài toán khác hẳn.
// ============================================================================

import { getSourceCapability, getFieldSupportStatus } from "../capabilities/capabilityQueries";
import { FieldSupportStatus } from "../capabilities/SourceCapability";
import { VesselField } from "../../domain/value-objects/VesselField";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { RejectedCandidate, RejectionReason, ResolutionReason, ResolvedField } from "./ResolverTypes";

/** Một giá trị ứng viên kèm nơi nó đến từ. */
export interface FieldCandidate<T> {
  value: T;
  source: VesselSource;
  observationId?: string;
  fetchedAt: Date;
  observedAt: Date | null;
}

/** Nhỏ hơn = tốt hơn. */
const QUALITY_RANK: Readonly<Record<FieldSupportStatus, number>> = Object.freeze({
  [FieldSupportStatus.CONFIRMED]: 0,
  [FieldSupportStatus.CANDIDATE]: 1,
  [FieldSupportStatus.UNSUPPORTED]: 2,
});

/**
 * Kết quả so hai giá trị.
 *  EQUAL        — bằng nhau sau chuẩn hoá/dung sai -> KHÔNG phải xung đột.
 *  DIFFERENT    — khác nhau thật.
 *  INCOMPARABLE — khác hệ biểu diễn, chưa chứng minh được bằng hay khác.
 */
export const ValueComparison = {
  EQUAL: "EQUAL",
  DIFFERENT: "DIFFERENT",
  INCOMPARABLE: "INCOMPARABLE",
} as const;

export type ValueComparison = (typeof ValueComparison)[keyof typeof ValueComparison];

/** Tiêu chí phân xử, áp theo đúng thứ tự khai báo. */
export const Tactic = {
  /** Hạng capability của nguồn cho ĐÚNG field này. */
  FIELD_QUALITY: "FIELD_QUALITY",
  /** Danh sách nguồn ưu tiên riêng cho field này. */
  SOURCE_PREFERENCE: "SOURCE_PREFERENCE",
  /** `fetchedAt` mới hơn. */
  NEWER_FETCH: "NEWER_FETCH",
} as const;

export type Tactic = (typeof Tactic)[keyof typeof Tactic];

export interface FieldResolutionSpec<T> {
  /** Field canonical, để tra capability matrix. */
  field: VesselField;
  /** So hai giá trị. Mặc định: so bằng `===`. */
  compare?: (a: T, b: T) => ValueComparison;
  /** Thứ tự tiêu chí. Sau khi hết tiêu chí: defaultPriority rồi tên nguồn. */
  tactics: readonly Tactic[];
  /** Nguồn ưu tiên cho field này (đứng trước = tốt hơn). */
  sourcePreference?: readonly VesselSource[];
}

const REASON_BY_TACTIC: Readonly<Record<Tactic, ResolutionReason>> = Object.freeze({
  [Tactic.FIELD_QUALITY]: ResolutionReason.HIGHER_FIELD_QUALITY,
  [Tactic.SOURCE_PREFERENCE]: ResolutionReason.SOURCE_FIELD_PREFERENCE,
  [Tactic.NEWER_FETCH]: ResolutionReason.NEWER_FETCH,
});

const REJECTION_BY_TACTIC: Readonly<Record<Tactic, RejectionReason>> = Object.freeze({
  [Tactic.FIELD_QUALITY]: RejectionReason.LOWER_FIELD_QUALITY,
  [Tactic.SOURCE_PREFERENCE]: RejectionReason.NOT_PREFERRED_SOURCE,
  [Tactic.NEWER_FETCH]: RejectionReason.OLDER_FETCH,
});

function qualityRank(source: VesselSource, field: VesselField): number {
  return QUALITY_RANK[getFieldSupportStatus(source, field)];
}

/** Không nằm trong danh sách ưu tiên -> xếp sau tất cả. */
function preferenceRank(source: VesselSource, preference?: readonly VesselSource[]): number {
  if (preference === undefined) return 0;
  const index = preference.indexOf(source);
  return index === -1 ? preference.length : index;
}

/** Điểm của một tiêu chí. Nhỏ hơn = tốt hơn. */
function tacticScore<T>(
  candidate: FieldCandidate<T>,
  tactic: Tactic,
  spec: FieldResolutionSpec<T>
): number {
  switch (tactic) {
    case Tactic.FIELD_QUALITY:
      return qualityRank(candidate.source, spec.field);
    case Tactic.SOURCE_PREFERENCE:
      return preferenceRank(candidate.source, spec.sourcePreference);
    case Tactic.NEWER_FETCH:
      // Mới hơn = tốt hơn -> đảo dấu để "nhỏ hơn là tốt hơn".
      return -candidate.fetchedAt.getTime();
  }
}

/**
 * Phân xử một field.
 *
 * @param candidates Chỉ những ứng viên có giá trị THẬT. Người gọi đã loại null —
 *        `null` từ một nguồn mới hơn KHÔNG được xoá giá trị tốt của nguồn khác.
 * @returns null khi không còn ứng viên nào.
 */
export function resolveField<T>(
  candidates: readonly FieldCandidate<T>[],
  spec: FieldResolutionSpec<T>
): ResolvedField<T> | null {
  if (candidates.length === 0) return null;

  const compare = spec.compare ?? ((a: T, b: T) => (a === b ? ValueComparison.EQUAL : ValueComparison.DIFFERENT));

  const sorted = [...candidates].sort((a, b) => {
    for (const tactic of spec.tactics) {
      const diff = tacticScore(a, tactic, spec) - tacticScore(b, tactic, spec);
      if (diff !== 0) return diff;
    }
    const priorityDiff =
      getSourceCapability(a.source).defaultPriority - getSourceCapability(b.source).defaultPriority;
    if (priorityDiff !== 0) return priorityDiff;
    // Chốt bằng tên nguồn -> kết quả tất định, không phụ thuộc thứ tự đầu vào.
    return a.source.localeCompare(b.source);
  });

  const [winner, ...losers] = sorted;
  if (losers.length === 0) {
    return {
      ...winner,
      reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
      rejected: Object.freeze([]),
    };
  }

  const rejected: RejectedCandidate[] = losers.map((loser) => ({
    source: loser.source,
    observationId: loser.observationId,
    reason: rejectionFor(winner, loser, spec, compare),
  }));

  // MỌI kẻ thua đều nói cùng giá trị -> đây không phải xung đột.
  const allAgree = losers.every((loser) => compare(winner.value, loser.value) === ValueComparison.EQUAL);

  return {
    ...winner,
    reason: allAgree
      ? ResolutionReason.SOURCES_AGREE
      : winnerReason(winner, losers[0], spec, compare),
    rejected: Object.freeze(rejected),
  };
}

function winnerReason<T>(
  winner: FieldCandidate<T>,
  runnerUp: FieldCandidate<T>,
  spec: FieldResolutionSpec<T>,
  compare: (a: T, b: T) => ValueComparison
): ResolutionReason {
  if (compare(winner.value, runnerUp.value) === ValueComparison.EQUAL) {
    return ResolutionReason.SOURCES_AGREE;
  }
  for (const tactic of spec.tactics) {
    if (tacticScore(winner, tactic, spec) !== tacticScore(runnerUp, tactic, spec)) {
      return REASON_BY_TACTIC[tactic];
    }
  }
  return ResolutionReason.TIE_BREAK_PRIORITY;
}

function rejectionFor<T>(
  winner: FieldCandidate<T>,
  loser: FieldCandidate<T>,
  spec: FieldResolutionSpec<T>,
  compare: (a: T, b: T) => ValueComparison
): RejectionReason {
  const comparison = compare(winner.value, loser.value);
  if (comparison === ValueComparison.INCOMPARABLE) {
    return RejectionReason.INCOMPARABLE_REPRESENTATION;
  }
  for (const tactic of spec.tactics) {
    if (tacticScore(winner, tactic, spec) !== tacticScore(loser, tactic, spec)) {
      return REJECTION_BY_TACTIC[tactic];
    }
  }
  return RejectionReason.TIE_BREAK_PRIORITY;
}

// ---------------------------------------------------------------------------
//  So sánh dùng chung
// ---------------------------------------------------------------------------

/**
 * So chuỗi để xác định BẰNG NHAU, không phải để đổi cách hiển thị.
 * `"AGIA DOXA"` và `"Agia Doxa"` là **một**; `"Passenger ship"` và
 * `"Passenger Ship"` cũng vậy. Giá trị trả ra vẫn giữ nguyên dạng của nguồn thắng.
 */
export function compareText(a: string, b: string): ValueComparison {
  const norm = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b) ? ValueComparison.EQUAL : ValueComparison.DIFFERENT;
}

/**
 * So hai mốc thời gian canonical. `Date` là object nên `===` là so THAM CHIẾU —
 * hai `Date` cùng thời điểm vẫn khác nhau. Phải so theo giá trị.
 * Mốc không hợp lệ -> DIFFERENT (người gọi đã lọc trước, đây chỉ là lưới an toàn).
 */
export function compareDate(a: Date, b: Date): ValueComparison {
  if (!(a instanceof Date) || !(b instanceof Date)) return ValueComparison.DIFFERENT;
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) {
    return ValueComparison.DIFFERENT;
  }
  return a.getTime() === b.getTime() ? ValueComparison.EQUAL : ValueComparison.DIFFERENT;
}

/**
 * So số có dung sai. `179` vs `180` chênh 0.56 % — làm tròn khác nhau hoặc
 * LOA vs LBP, KHÔNG phải xung đột nghiêm trọng.
 *
 * ⚠️ Dung sai chỉ để PHÂN LOẠI. Không bao giờ lấy trung bình: `(179+180)/2`
 * là con số chưa nguồn nào từng nói.
 */
export function compareNumber(
  a: number,
  b: number,
  tolerance: { absolute?: number; relative?: number } = {}
): ValueComparison {
  if (a === b) return ValueComparison.EQUAL;
  const delta = Math.abs(a - b);
  if (tolerance.absolute !== undefined && delta <= tolerance.absolute) return ValueComparison.EQUAL;
  if (tolerance.relative !== undefined) {
    const scale = Math.max(Math.abs(a), Math.abs(b));
    if (scale > 0 && delta / scale <= tolerance.relative) return ValueComparison.EQUAL;
  }
  return ValueComparison.DIFFERENT;
}
