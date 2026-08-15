// ============================================================================
//  APPLICATION · LocalDataSufficiencyChecker — HÀM THUẦN
// ----------------------------------------------------------------------------
//      (ResolvedCurrentVessel | null, DataNeed, now)  ->  SufficiencyResult
//
//  Trả lời ĐÚNG MỘT câu: "dữ liệu canonical đang có đã đủ cho nhu cầu này chưa?"
//
//  ⛔ KHÔNG trả lời "nên gọi nguồn nào" — đó là P9.3. Vì vậy file này KHÔNG
//  import capability matrix, KHÔNG import runtime/health, KHÔNG import provider,
//  KHÔNG chạm repository, KHÔNG chạm mạng, KHÔNG đọc đồng hồ (nhận `now`).
//
//  Ranh giới đó là thật, không phải hình thức: nếu checker biết "hiện không
//  nguồn free nào cấp được `eta`", nó sẽ bị cám dỗ trả `satisfied: true` cho một
//  field đang THIẾU — biến "không lấy được" thành "không cần". Checker chỉ báo
//  THIẾU; ai lấy được và có đáng lấy không là câu hỏi khác.
//
//  Luật đầy đủ: ACQUISITION_POLICY.md §D.
// ============================================================================

import { VesselPositionReport } from "../../domain/canonical/VesselPositionReport";
import {
  VesselField,
  VesselFieldGroup,
  getFieldGroup,
} from "../../domain/value-objects/VesselField";
import { ResolvedCurrentVessel } from "../resolver/ResolvedCurrentVessel";
import { ResolvedParticulars } from "../resolver/ParticularsResolver";
import { ResolvedVoyage } from "../resolver/VoyageResolver";
import { ResolvedIdentity } from "../resolver/IdentityResolver";
import { ResolvedField } from "../resolver/ResolverTypes";
import { DataNeed, DataNeedType, getGroupsForNeed, validateDataNeed } from "./DataNeed";
import {
  DEFAULT_SUFFICIENCY_POLICY,
  SufficiencyPolicy,
  ageMs,
} from "./SufficiencyPolicy";
import {
  MissingReason,
  MissingRequirement,
  SufficiencyResult,
} from "./SufficiencyTypes";

export interface LocalDataSufficiencyCheckerDeps {
  policy?: SufficiencyPolicy;
}

/**
 * Một field đã tra xong: có giá trị chưa, và nếu có thì lấy về lúc nào.
 * `fetchedAt` vắng mặt với field không mang provenance riêng (VD `mmsi` là khoá
 * tra, `lat`/`lng` đi liền khối vị trí).
 */
interface FieldAvailability {
  readonly available: boolean;
  readonly fetchedAt?: Date;
}

const UNAVAILABLE: FieldAvailability = Object.freeze({ available: false });

/** `ResolvedField` có mặt = field có giá trị. Không soi vào `value`. */
function fromResolvedField<T>(field: ResolvedField<T> | null | undefined): FieldAvailability {
  if (field === null || field === undefined) return UNAVAILABLE;
  return { available: true, fetchedAt: field.fetchedAt };
}

export class LocalDataSufficiencyChecker {
  private readonly policy: SufficiencyPolicy;

  constructor(deps: LocalDataSufficiencyCheckerDeps = {}) {
    this.policy = deps.policy ?? DEFAULT_SUFFICIENCY_POLICY;
  }

  /**
   * @param now Tiêm vào, không đọc đồng hồ ngầm — cùng đầu vào phải cho cùng
   *        đầu ra, kể cả chạy lại sau một tiếng.
   * @throws InvalidDataNeedError khi `requiredFields` chứa field không thuộc
   *         nhóm của need (VD `POSITION + builtYear`).
   */
  check(
    vessel: ResolvedCurrentVessel | null,
    need: DataNeed,
    now: Date
  ): SufficiencyResult {
    // Kiểm hình dạng TRƯỚC khi nhìn dữ liệu: need sai là lỗi người gọi, không
    // phải "dữ liệu chưa đủ". Hai chuyện đó không được lẫn vào nhau.
    validateDataNeed(need);

    if (vessel === null) {
      return LocalDataSufficiencyChecker.result(need, [
        { reason: MissingReason.NO_CURRENT_VESSEL },
      ]);
    }

    const missing: MissingRequirement[] = [];
    // Nhóm đã thiếu nguyên khối -> không báo lại từng field của nó nữa. Một
    // nguyên nhân, một dòng.
    const missingGroups = new Set<VesselFieldGroup>();

    for (const group of getGroupsForNeed(need.type)) {
      this.checkGroupDefaults(vessel, group, need.type, now, missing, missingGroups);
    }

    for (const field of need.requiredFields ?? []) {
      const group = getFieldGroup(field);
      if (missingGroups.has(group)) continue;
      this.checkRequiredField(vessel, field, group, now, missing);
    }

    return LocalDataSufficiencyChecker.result(need, missing);
  }

  // ---- mặc định theo nhóm ---------------------------------------------------

  private checkGroupDefaults(
    vessel: ResolvedCurrentVessel,
    group: VesselFieldGroup,
    needType: DataNeedType,
    now: Date,
    missing: MissingRequirement[],
    missingGroups: Set<VesselFieldGroup>
  ): void {
    switch (group) {
      case VesselFieldGroup.IDENTITY:
        this.checkIdentityDefaults(vessel.identity, missing, missingGroups);
        return;
      case VesselFieldGroup.POSITION:
        this.checkPositionDefaults(vessel, needType, missing, missingGroups);
        return;
      case VesselFieldGroup.PARTICULARS:
        this.checkParticularsDefaults(vessel.particulars, missing, missingGroups);
        return;
      case VesselFieldGroup.VOYAGE:
        this.checkVoyageDefaults(vessel.voyage, now, missing, missingGroups);
        return;
    }
  }

  /** Mặc định: chỉ `name`. Callsign/vesselType/flag là enrichment (§D.2). */
  private checkIdentityDefaults(
    identity: ResolvedIdentity | null,
    missing: MissingRequirement[],
    missingGroups: Set<VesselFieldGroup>
  ): void {
    if (identity === null) {
      missing.push({ group: VesselFieldGroup.IDENTITY, reason: MissingReason.MISSING_GROUP });
      missingGroups.add(VesselFieldGroup.IDENTITY);
      return;
    }
    if (identity.name === null) {
      missing.push({
        group: VesselFieldGroup.IDENTITY,
        field: VesselField.NAME,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      });
    }
  }

  /**
   * Bậc độ tươi lấy THẲNG từ `ResolvedPosition.freshness` — không tính lại từ
   * `observedAt`. Resolver đã tính nó tại thời điểm phân xử; tính lại ở đây
   * cho ra con số khác và không ai biết con số nào đúng.
   *
   * ⚠️ `FULL` dùng danh sách bậc NỚI hơn `POSITION`. Đây là luật lõi
   * (ACQUISITION_POLICY.md §D.5), không phải trường hợp đặc biệt.
   */
  private checkPositionDefaults(
    vessel: ResolvedCurrentVessel,
    needType: DataNeedType,
    missing: MissingRequirement[],
    missingGroups: Set<VesselFieldGroup>
  ): void {
    if (vessel.position === null) {
      missing.push({ group: VesselFieldGroup.POSITION, reason: MissingReason.MISSING_GROUP });
      missingGroups.add(VesselFieldGroup.POSITION);
      return;
    }

    const accepted =
      needType === DataNeedType.FULL
        ? this.policy.positionFreshnessForFull
        : this.policy.positionFreshnessForPosition;

    if (!accepted.includes(vessel.position.freshness)) {
      missing.push({
        group: VesselFieldGroup.POSITION,
        reason: MissingReason.POSITION_NOT_FRESH_ENOUGH,
      });
    }
  }

  /**
   * Mặc định: CÓ ÍT NHẤT MỘT field dùng được là đủ (§D.3).
   *
   * Không ngưỡng tuổi: chiều dài tàu không đổi theo thời gian. Refresh vì "dữ
   * liệu cũ 3 ngày" là đốt request để nhận lại đúng con số đó.
   */
  private checkParticularsDefaults(
    particulars: ResolvedParticulars | null,
    missing: MissingRequirement[],
    missingGroups: Set<VesselFieldGroup>
  ): void {
    // Nhóm tồn tại nhưng RỖNG cũng là thiếu: một `ResolvedParticulars` mà mọi
    // field đều null không nói được gì về con tàu.
    const usable =
      particulars !== null &&
      [
        particulars.length,
        particulars.beam,
        particulars.draught,
        particulars.grossTonnage,
        particulars.deadweight,
        particulars.builtYear,
      ].some((field) => field !== null);

    if (!usable) {
      missing.push({
        group: VesselFieldGroup.PARTICULARS,
        reason: MissingReason.MISSING_GROUP,
      });
      missingGroups.add(VesselFieldGroup.PARTICULARS);
    }
  }

  /**
   * Mặc định: `destination` phải có VÀ đủ mới (§D.4).
   *
   * Tuổi đo bằng `fetchedAt`, KHÔNG phải `observedAt`: nhóm voyage không có mốc
   * nguồn (cả ba nguồn đều để `observedAt = null`). Cũng KHÔNG dùng
   * `vessel.resolvedAt` hay `updatedAt` của Mongo — chúng nói lúc TA chạy, không
   * nói dữ liệu cũ đến đâu.
   *
   * ⛔ `eta` null KHÔNG làm voyage thiếu. Bằng chứng P7: ShipFinder cho
   * "07-29 07:01" thiếu năm nên mapper cố ý không map — đòi `eta` mặc định là
   * đòi thứ không nguồn nào đang có.
   */
  private checkVoyageDefaults(
    voyage: ResolvedVoyage | null,
    now: Date,
    missing: MissingRequirement[],
    missingGroups: Set<VesselFieldGroup>
  ): void {
    if (voyage === null) {
      missing.push({ group: VesselFieldGroup.VOYAGE, reason: MissingReason.MISSING_GROUP });
      missingGroups.add(VesselFieldGroup.VOYAGE);
      return;
    }

    const destination = voyage.destination;
    if (destination === null) {
      missing.push({
        group: VesselFieldGroup.VOYAGE,
        field: VesselField.DESTINATION,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      });
      return;
    }

    if (ageMs(destination.fetchedAt, now) > this.policy.voyageMaxAgeMs) {
      missing.push({
        group: VesselFieldGroup.VOYAGE,
        field: VesselField.DESTINATION,
        reason: MissingReason.VOYAGE_TOO_OLD,
      });
    }
  }

  // ---- field chỉ đích danh --------------------------------------------------

  private checkRequiredField(
    vessel: ResolvedCurrentVessel,
    field: VesselField,
    group: VesselFieldGroup,
    now: Date,
    missing: MissingRequirement[]
  ): void {
    const availability = LocalDataSufficiencyChecker.lookup(vessel, field, group);

    if (!availability.available) {
      missing.push({ group, field, reason: MissingReason.MISSING_REQUIRED_FIELD });
      return;
    }

    // `draught` là field NỬA ĐỘNG duy nhất trong particulars — có giá trị chưa
    // đủ, phải còn đúng chuyến. Xem SufficiencyPolicy.draughtMaxAgeMs.
    if (
      field === VesselField.DRAUGHT &&
      availability.fetchedAt !== undefined &&
      ageMs(availability.fetchedAt, now) > this.policy.draughtMaxAgeMs
    ) {
      missing.push({ group, field, reason: MissingReason.FIELD_TOO_OLD });
    }
  }

  /** Tra tường minh theo nhóm. Không reflection, không index động. */
  private static lookup(
    vessel: ResolvedCurrentVessel,
    field: VesselField,
    group: VesselFieldGroup
  ): FieldAvailability {
    switch (group) {
      case VesselFieldGroup.IDENTITY:
        return LocalDataSufficiencyChecker.lookupIdentity(vessel.identity, field);
      case VesselFieldGroup.POSITION:
        return LocalDataSufficiencyChecker.lookupPosition(vessel, field);
      case VesselFieldGroup.PARTICULARS:
        return LocalDataSufficiencyChecker.lookupParticulars(vessel.particulars, field);
      case VesselFieldGroup.VOYAGE:
        return LocalDataSufficiencyChecker.lookupVoyage(vessel.voyage, field);
    }
  }

  private static lookupIdentity(
    identity: ResolvedIdentity | null,
    field: VesselField
  ): FieldAvailability {
    if (identity === null) return UNAVAILABLE;
    switch (field) {
      // `mmsi` là KHOÁ TRA, không phải field tranh chấp -> không có provenance.
      case VesselField.MMSI:
        return { available: identity.mmsi.trim() !== "" };
      case VesselField.IMO:
        return fromResolvedField(identity.imo);
      case VesselField.NAME:
        return fromResolvedField(identity.name);
      case VesselField.CALLSIGN:
        return fromResolvedField(identity.callsign);
      case VesselField.VESSEL_TYPE:
        return fromResolvedField(identity.vesselType);
      case VesselField.VESSEL_TYPE_CODE:
        return fromResolvedField(identity.vesselTypeCode);
      // Canonical có MỘT field `flag`, resolver phân xử code/name RIÊNG (chúng
      // có thể đến từ hai nguồn). Có một trong hai là có cờ — đòi cả hai sẽ
      // loại con tàu chỉ biết "LR" mà chưa biết "Liberia".
      case VesselField.FLAG:
        return identity.flagCode !== null
          ? fromResolvedField(identity.flagCode)
          : fromResolvedField(identity.flagName);
      default:
        return UNAVAILABLE;
    }
  }

  private static lookupPosition(
    vessel: ResolvedCurrentVessel,
    field: VesselField
  ): FieldAvailability {
    const resolved = vessel.position;
    if (resolved === null) return UNAVAILABLE;
    const position: VesselPositionReport = resolved.position;

    switch (field) {
      // Toạ độ là BẮT BUỘC của `VesselPositionReport` và đã qua validation P5.
      // Vị trí tồn tại thì lat/lng tồn tại — không kiểm lại lần hai.
      case VesselField.LAT:
      case VesselField.LNG:
        return { available: true, fetchedAt: resolved.fetchedAt };
      case VesselField.SPEED:
        return { available: position.speed != null, fetchedAt: resolved.fetchedAt };
      case VesselField.COURSE:
        return { available: position.course != null, fetchedAt: resolved.fetchedAt };
      case VesselField.HEADING:
        return { available: position.heading != null, fetchedAt: resolved.fetchedAt };
      case VesselField.NAV_STATUS:
        return { available: position.navStatus != null, fetchedAt: resolved.fetchedAt };
      // Mốc NGUỒN khai. `null` = nguồn không cho biết (bậc NO_SOURCE_TIME).
      case VesselField.POSITION_RECEIVED_AT:
        return { available: resolved.observedAt !== null, fetchedAt: resolved.fetchedAt };
      default:
        return UNAVAILABLE;
    }
  }

  private static lookupParticulars(
    particulars: ResolvedParticulars | null,
    field: VesselField
  ): FieldAvailability {
    if (particulars === null) return UNAVAILABLE;
    switch (field) {
      case VesselField.LENGTH:
        return fromResolvedField(particulars.length);
      case VesselField.BEAM:
        return fromResolvedField(particulars.beam);
      case VesselField.DRAUGHT:
        return fromResolvedField(particulars.draught);
      case VesselField.GROSS_TONNAGE:
        return fromResolvedField(particulars.grossTonnage);
      case VesselField.DEADWEIGHT:
        return fromResolvedField(particulars.deadweight);
      case VesselField.BUILT_YEAR:
        return fromResolvedField(particulars.builtYear);
      default:
        return UNAVAILABLE;
    }
  }

  private static lookupVoyage(
    voyage: ResolvedVoyage | null,
    field: VesselField
  ): FieldAvailability {
    if (voyage === null) return UNAVAILABLE;
    switch (field) {
      case VesselField.DESTINATION:
        return fromResolvedField(voyage.destination);
      case VesselField.ETA:
        return fromResolvedField(voyage.eta);
      case VesselField.CURRENT_PORT:
        return fromResolvedField(voyage.currentPort);
      case VesselField.NEXT_PORT:
        return fromResolvedField(voyage.nextPort);
      case VesselField.LAST_PORT:
        return fromResolvedField(voyage.lastPort);
      case VesselField.LAST_PORT_DEPARTURE_AT:
        return fromResolvedField(voyage.lastPortDepartureAt);
      // `currentPortArrivalAt` / `nextPortEta` là VesselField hợp lệ nhưng
      // `ResolvedVoyage` cố ý KHÔNG phân xử chúng (P8.4 §R.3: chưa nguồn nào
      // đã implement cung cấp). Yêu cầu chúng luôn báo THIẾU — đúng sự thật,
      // không phải lỗi cấu hình.
      default:
        return UNAVAILABLE;
    }
  }

  private static result(
    need: DataNeed,
    missing: readonly MissingRequirement[]
  ): SufficiencyResult {
    return {
      satisfied: missing.length === 0,
      need,
      missing: Object.freeze([...missing]),
    };
  }
}
