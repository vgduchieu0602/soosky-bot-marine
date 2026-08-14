// ============================================================================
//  DOMAIN · Kiểm tra observation — HÀM THUẦN, dùng lại validator P1
// ----------------------------------------------------------------------------
//  Không viết lại một dòng logic kiểm tra nào: mmsi/imo lấy từ validators/
//  identifiers, lat/lng từ validators/geo, speed/course/heading từ
//  validators/motion. Trùng lặp logic kiểm tra là cách chắc chắn nhất để hai
//  chỗ dần dần bất đồng.
//
//  Nguyên tắc phân mức:
//    • Khoá không có định danh nào ĐÚNG ĐỊNH DẠNG -> INVALID (không gắn được
//      vào tàu nào).
//    • Lõi của nhóm hỏng -> INVALID (POSITION mất toạ độ, nhóm rỗng trơn).
//    • Field phụ hỏng -> PARTIAL.
// ============================================================================

import { isValidDate } from "../value-objects/SourceMetadata";
import { isValidImo, isValidMmsi } from "../validators/identifiers";
import { isValidCoordinates } from "../validators/geo";
import { isValidCourse, isValidHeading, isValidSpeed } from "../validators/motion";
import {
  ObservationIssueCode,
  ObservationValidation,
  ObservationValidationIssue,
  invalid,
  issue,
  partial,
} from "./ObservationValidation";
import {
  ParticularsObservation,
  PositionObservation,
  VesselObservationKey,
  VesselObservationType,
  VesselSourceObservation,
} from "./VesselObservation";

/**
 * Năm đóng tàu hợp lý. `MIN` là mốc lịch sử; cận trên phụ thuộc HÔM NAY nên
 * tính từ `now` được tiêm vào — KHÔNG hardcode năm hiện tại ở bất kỳ đâu.
 * Cộng biên 5 năm: tàu đặt đóng trước có thể khai năm giao trong tương lai.
 */
export const MIN_BUILT_YEAR = 1800;
export const BUILT_YEAR_FUTURE_TOLERANCE = 5;

export function maxBuiltYear(now: Date): number {
  return now.getUTCFullYear() + BUILT_YEAR_FUTURE_TOLERANCE;
}

export interface ValidateObservationOptions {
  /** Mốc "bây giờ" để chặn năm đóng ở tương lai. Mặc định đồng hồ hệ thống. */
  now?: Date;
}

/** Khoá: định danh nào CÓ MẶT thì phải ĐÚNG ĐỊNH DẠNG. */
function validateKey(key: VesselObservationKey): ObservationValidationIssue[] {
  const issues: ObservationValidationIssue[] = [];
  if (key.mmsi !== undefined && !isValidMmsi(key.mmsi)) {
    issues.push(
      issue(ObservationIssueCode.INVALID_MMSI, `MMSI không hợp lệ: "${key.mmsi}"`, "mmsi")
    );
  }
  if (key.imo !== undefined && !isValidImo(key.imo)) {
    issues.push(
      issue(ObservationIssueCode.INVALID_IMO, `IMO không hợp lệ: "${key.imo}"`, "imo")
    );
  }
  return issues;
}

function validatePosition(data: PositionObservation["data"]): {
  core: ObservationValidationIssue[];
  minor: ObservationValidationIssue[];
} {
  const core: ObservationValidationIssue[] = [];
  const minor: ObservationValidationIssue[] = [];

  // Toạ độ LÀ lõi: báo cáo vị trí không toạ độ thì không còn là báo cáo vị trí.
  if (!isValidCoordinates(data.lat, data.lng)) {
    core.push(
      issue(
        ObservationIssueCode.INVALID_COORDINATE,
        `Toạ độ không hợp lệ: lat=${String(data.lat)} lng=${String(data.lng)}`,
        "lat/lng"
      )
    );
  }
  if (!isValidDate(data.receivedAt)) {
    core.push(
      issue(ObservationIssueCode.INVALID_TIMESTAMP, "receivedAt không phải Date hợp lệ", "receivedAt")
    );
  }

  // Chuyển động là phụ: sai thì bỏ field đó, vẫn giữ được toạ độ.
  if (data.speed != null && !isValidSpeed(data.speed)) {
    minor.push(issue(ObservationIssueCode.INVALID_SPEED, `Tốc độ ngoài 0..102.2 kn: ${data.speed}`, "speed"));
  }
  if (data.course != null && !isValidCourse(data.course)) {
    minor.push(issue(ObservationIssueCode.INVALID_COURSE, `Hướng đi ngoài [0,360): ${data.course}`, "course"));
  }
  if (data.heading != null && !isValidHeading(data.heading)) {
    minor.push(
      issue(ObservationIssueCode.INVALID_HEADING, `Heading ngoài [0,359] nguyên: ${data.heading}`, "heading")
    );
  }
  return { core, minor };
}

function validateParticulars(
  data: ParticularsObservation["data"],
  now: Date
): { core: ObservationValidationIssue[]; minor: ObservationValidationIssue[] } {
  const minor: ObservationValidationIssue[] = [];
  const numeric: Array<[keyof typeof data, number | null | undefined]> = [
    ["grossTonnage", data.grossTonnage],
    ["deadweight", data.deadweight],
    ["length", data.length],
    ["beam", data.beam],
    ["draught", data.draught],
  ];

  let present = 0;
  for (const [field, value] of numeric) {
    if (value == null) continue;
    present += 1;
    if (!Number.isFinite(value) || value < 0) {
      minor.push(
        issue(ObservationIssueCode.NEGATIVE_VALUE, `${String(field)} phải >= 0, nhận ${value}`, String(field))
      );
    }
  }

  if (data.builtYear != null) {
    present += 1;
    const max = maxBuiltYear(now);
    if (
      !Number.isInteger(data.builtYear) ||
      data.builtYear < MIN_BUILT_YEAR ||
      data.builtYear > max
    ) {
      minor.push(
        issue(
          ObservationIssueCode.UNREASONABLE_YEAR,
          `builtYear phải trong [${MIN_BUILT_YEAR}, ${max}], nhận ${data.builtYear}`,
          "builtYear"
        )
      );
    }
  }

  // Không field nào -> bản ghi rỗng, lưu cũng không dùng được vào việc gì.
  const core =
    present === 0
      ? [issue(ObservationIssueCode.NO_DATA, "PARTICULARS không có field nào")]
      : [];
  return { core, minor };
}

function validateVoyage(data: {
  eta?: Date | null;
  currentPortArrivalAt?: Date | null;
  nextPortEta?: Date | null;
  lastPortDepartureAt?: Date | null;
}): ObservationValidationIssue[] {
  const fields: Array<[string, Date | null | undefined]> = [
    ["eta", data.eta],
    ["currentPortArrivalAt", data.currentPortArrivalAt],
    ["nextPortEta", data.nextPortEta],
    ["lastPortDepartureAt", data.lastPortDepartureAt],
  ];
  const issues: ObservationValidationIssue[] = [];
  for (const [field, value] of fields) {
    if (value != null && !isValidDate(value)) {
      issues.push(
        issue(ObservationIssueCode.INVALID_TIMESTAMP, `${field} không phải Date hợp lệ`, field)
      );
    }
  }
  return issues;
}

/**
 * Kiểm tra một observation. KHÔNG ném lỗi — luôn trả về kết quả để bản ghi
 * hỏng vẫn lưu được làm bằng chứng debug parser.
 */
export function validateObservation(
  observation: VesselSourceObservation,
  options: ValidateObservationOptions = {}
): ObservationValidation {
  const now = options.now ?? new Date();
  const keyIssues = validateKey(observation.vesselKey);

  // Cả hai định danh đều sai/thiếu -> không gắn được vào tàu nào.
  const usableKey = isValidMmsi(observation.vesselKey.mmsi) || isValidImo(observation.vesselKey.imo);
  if (!usableKey) {
    return invalid([
      ...keyIssues,
      issue(
        ObservationIssueCode.NO_IDENTIFIER,
        "Không có MMSI hoặc IMO hợp lệ để gắn observation vào tàu"
      ),
    ]);
  }

  let core: ObservationValidationIssue[] = [];
  let minor: ObservationValidationIssue[] = [];

  switch (observation.type) {
    case VesselObservationType.POSITION: {
      const result = validatePosition(observation.data);
      core = result.core;
      minor = result.minor;
      break;
    }
    case VesselObservationType.PARTICULARS: {
      const result = validateParticulars(observation.data, now);
      core = result.core;
      minor = result.minor;
      break;
    }
    case VesselObservationType.VOYAGE: {
      minor = validateVoyage(observation.data);
      break;
    }
    case VesselObservationType.IDENTITY: {
      // Định danh sai đã bắt ở validateKey; data không có lõi nào khác bắt buộc.
      break;
    }
  }

  // Định danh phụ sai (VD imo hỏng nhưng mmsi đúng) chỉ là PARTIAL.
  const allMinor = [...keyIssues, ...minor];
  if (core.length > 0) return invalid([...core, ...allMinor]);
  return partial(allMinor);
}
