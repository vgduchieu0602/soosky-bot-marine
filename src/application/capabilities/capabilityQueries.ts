// ============================================================================
//  APPLICATION · Truy vấn capability matrix — HÀM THUẦN, không I/O
// ----------------------------------------------------------------------------
//  ⚠️ Đây KHÔNG phải resolver. Các hàm này chỉ trả lời "nguồn nào ĐỦ ĐIỀU KIỆN",
//  không chọn nguồn, không gọi nguồn, không fallback, không retry. Việc chọn
//  thuộc phase sau.
//
//  MẶC ĐỊNH AN TOÀN: chỉ trả nguồn enabled + CONFIRMED + không tốn tiền.
//  Muốn rộng hơn thì người gọi phải nói rõ ý định qua options.
// ============================================================================

import { VesselField } from "../../domain/value-objects/VesselField";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { FieldSupportStatus, SourceCapability, SourceCostType } from "./SourceCapability";
import { SOURCE_CAPABILITY_MATRIX } from "./sourceCapabilityMatrix";

export interface SourceQueryOptions {
  /** Cho phép nguồn đang tắt. Mặc định false. */
  includeDisabled?: boolean;
  /** Cho phép field mới ở mức CANDIDATE. Mặc định false. */
  includeCandidate?: boolean;
  /** Cho phép nguồn PAID. Mặc định false. */
  includePaid?: boolean;
}

const DEFAULTS: Required<SourceQueryOptions> = {
  includeDisabled: false,
  includeCandidate: false,
  includePaid: false,
};

function withDefaults(options: SourceQueryOptions = {}): Required<SourceQueryOptions> {
  return { ...DEFAULTS, ...options };
}

/** Capability của 1 nguồn. Matrix luôn đủ key nên không bao giờ undefined. */
export function getSourceCapability(source: VesselSource): Readonly<SourceCapability> {
  return SOURCE_CAPABILITY_MATRIX[source];
}

/** Trạng thái thô của (nguồn, field) — không áp luật lọc nào. */
export function getFieldSupportStatus(
  source: VesselSource,
  field: VesselField
): FieldSupportStatus {
  return getSourceCapability(source).fields[field];
}

/**
 * Nguồn có cấp được field không.
 * Mặc định CHỈ chấp nhận CONFIRMED; `includeCandidate: true` mới tính CANDIDATE.
 * KHÔNG xét enabled/costType — đó là việc của getSourcesForField.
 */
export function providerSupportsField(
  source: VesselSource,
  field: VesselField,
  options: Pick<SourceQueryOptions, "includeCandidate"> = {}
): boolean {
  const status = getFieldSupportStatus(source, field);
  if (status === FieldSupportStatus.CONFIRMED) return true;
  return status === FieldSupportStatus.CANDIDATE && options.includeCandidate === true;
}

function fieldsWithStatus(
  source: VesselSource,
  status: FieldSupportStatus
): readonly VesselField[] {
  const { fields } = getSourceCapability(source);
  return Object.freeze(
    (Object.keys(fields) as VesselField[]).filter((field) => fields[field] === status)
  );
}

/** Field nguồn ĐÃ CHỨNG MINH cấp được. */
export function getConfirmedFields(source: VesselSource): readonly VesselField[] {
  return fieldsWithStatus(source, FieldSupportStatus.CONFIRMED);
}

/** Field nguồn CÓ THỂ cấp nhưng chưa audit/POC. */
export function getCandidateFields(source: VesselSource): readonly VesselField[] {
  return fieldsWithStatus(source, FieldSupportStatus.CANDIDATE);
}

/** Nguồn qua được bộ lọc enabled/costType. */
function isSourceEligible(
  capability: SourceCapability,
  options: Required<SourceQueryOptions>
): boolean {
  if (!options.includeDisabled && !capability.enabled) return false;
  if (!options.includePaid && capability.costType === SourceCostType.PAID) return false;
  return true;
}

/** Ưu tiên thấp hơn đứng trước; số bằng nhau thì theo tên nguồn cho ổn định. */
function byPriority(a: VesselSource, b: VesselSource): number {
  const left = getSourceCapability(a);
  const right = getSourceCapability(b);
  if (left.defaultPriority !== right.defaultPriority) {
    return left.defaultPriority - right.defaultPriority;
  }
  return left.source.localeCompare(right.source);
}

/**
 * Nguồn cấp được `field`, ĐÃ SẮP theo defaultPriority (nguồn trả tiền luôn ở
 * cuối vì priority lớn nhất).
 */
export function getSourcesForField(
  field: VesselField,
  options: SourceQueryOptions = {}
): readonly VesselSource[] {
  const resolved = withDefaults(options);
  const matched = (Object.keys(SOURCE_CAPABILITY_MATRIX) as VesselSource[]).filter((source) => {
    const capability = getSourceCapability(source);
    if (!isSourceEligible(capability, resolved)) return false;
    return providerSupportsField(source, field, { includeCandidate: resolved.includeCandidate });
  });
  return Object.freeze(matched.sort(byPriority));
}

/**
 * Nguồn cấp được **TẤT CẢ** `fields` (giao, không phải hợp). Danh sách rỗng ->
 * trả rỗng: "không yêu cầu field nào" không có nghĩa là "mọi nguồn đều hợp".
 */
export function getSourcesForFields(
  fields: readonly VesselField[],
  options: SourceQueryOptions = {}
): readonly VesselSource[] {
  if (fields.length === 0) return Object.freeze([]);
  const resolved = withDefaults(options);
  const matched = (Object.keys(SOURCE_CAPABILITY_MATRIX) as VesselSource[]).filter((source) => {
    const capability = getSourceCapability(source);
    if (!isSourceEligible(capability, resolved)) return false;
    return fields.every((field) =>
      providerSupportsField(source, field, { includeCandidate: resolved.includeCandidate })
    );
  });
  return Object.freeze(matched.sort(byPriority));
}

/**
 * Field còn thiếu = required \ available. Giữ thứ tự của `requiredFields`,
 * bỏ trùng lặp.
 */
export function getMissingFields(
  requiredFields: readonly VesselField[],
  availableFields: readonly VesselField[]
): readonly VesselField[] {
  const available = new Set(availableFields);
  const seen = new Set<VesselField>();
  const missing: VesselField[] = [];
  for (const field of requiredFields) {
    if (available.has(field) || seen.has(field)) continue;
    seen.add(field);
    missing.push(field);
  }
  return Object.freeze(missing);
}
