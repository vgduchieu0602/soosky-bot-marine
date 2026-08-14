// ============================================================================
//  DOMAIN · Kết quả kiểm tra một observation
// ----------------------------------------------------------------------------
//  Ba mức, và ranh giới giữa chúng là điều quan trọng nhất:
//
//    VALID   — không phát hiện vấn đề nào.
//    PARTIAL — LÕI dùng được, vài field phụ hỏng. VD toạ độ đúng nhưng speed
//              = 999 knots. Vẫn có giá trị, resolver sau này dùng được phần tốt.
//    INVALID — LÕI hỏng, cả bản ghi vô dụng. VD POSITION không có toạ độ hợp lệ.
//
//  Không ném lỗi chỉ vì một field phụ sai. Ném = mất luôn phần dữ liệu tốt, và
//  mất luôn bằng chứng để debug parser.
//
//  Không framework validation. Ba interface và vài hàm thuần.
// ============================================================================

export const ObservationValidationStatus = {
  VALID: "VALID",
  PARTIAL: "PARTIAL",
  INVALID: "INVALID",
} as const;

export type ObservationValidationStatus =
  (typeof ObservationValidationStatus)[keyof typeof ObservationValidationStatus];

export interface ObservationValidationIssue {
  /** Field canonical gây lỗi. Lỗi mức bản ghi -> bỏ trống. */
  readonly field?: string;
  /** Mã ổn định để đếm/lọc, VD "INVALID_MMSI". */
  readonly code: string;
  readonly message: string;
}

export interface ObservationValidation {
  readonly status: ObservationValidationStatus;
  readonly errors: readonly ObservationValidationIssue[];
}

/** Mã lỗi dùng chung — tránh gõ chuỗi tự do rải rác. */
export const ObservationIssueCode = {
  NO_IDENTIFIER: "NO_IDENTIFIER",
  INVALID_MMSI: "INVALID_MMSI",
  INVALID_IMO: "INVALID_IMO",
  INVALID_COORDINATE: "INVALID_COORDINATE",
  INVALID_SPEED: "INVALID_SPEED",
  INVALID_COURSE: "INVALID_COURSE",
  INVALID_HEADING: "INVALID_HEADING",
  NEGATIVE_VALUE: "NEGATIVE_VALUE",
  UNREASONABLE_YEAR: "UNREASONABLE_YEAR",
  INVALID_TIMESTAMP: "INVALID_TIMESTAMP",
  NO_DATA: "NO_DATA",
} as const;

export type ObservationIssueCode =
  (typeof ObservationIssueCode)[keyof typeof ObservationIssueCode];

export function issue(
  code: ObservationIssueCode,
  message: string,
  field?: string
): ObservationValidationIssue {
  return Object.freeze({ code, message, field });
}

export function validationResult(
  status: ObservationValidationStatus,
  errors: readonly ObservationValidationIssue[] = []
): ObservationValidation {
  return Object.freeze({ status, errors: Object.freeze([...errors]) });
}

/** Không vấn đề gì. */
export const VALID_OBSERVATION: ObservationValidation = validationResult(
  ObservationValidationStatus.VALID
);

/** Có issue nhưng lõi còn dùng được. Danh sách rỗng -> VALID. */
export function partial(
  errors: readonly ObservationValidationIssue[]
): ObservationValidation {
  if (errors.length === 0) return VALID_OBSERVATION;
  return validationResult(ObservationValidationStatus.PARTIAL, errors);
}

/** Lõi hỏng. */
export function invalid(
  errors: readonly ObservationValidationIssue[]
): ObservationValidation {
  return validationResult(ObservationValidationStatus.INVALID, errors);
}

/** Dùng được cho resolver sau này (VALID hoặc PARTIAL). */
export function isUsable(validation: ObservationValidation): boolean {
  return validation.status !== ObservationValidationStatus.INVALID;
}
