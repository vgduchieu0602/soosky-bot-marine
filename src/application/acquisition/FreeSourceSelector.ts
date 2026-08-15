// ============================================================================
//  APPLICATION · FreeSourceSelector — HÀM THUẦN
// ----------------------------------------------------------------------------
//      (khoá, need, SufficiencyResult, sức khoẻ, các lần đã thử, now)
//        ->  FreeSourceSelectionResult
//
//  Trả lời ĐÚNG MỘT câu: "nguồn FREE nào nên thử TIẾP THEO?"
//
//  ⛔ KHÔNG gọi mạng · KHÔNG import provider/client/CollectVesselObservations ·
//  KHÔNG chạm repository · KHÔNG sửa health (chỉ ĐỌC) · KHÔNG đọc đồng hồ ·
//  KHÔNG chọn nguồn PAID · KHÔNG mở AISStream.
//
//  Chỉ trả về MỘT plan, không phải cả chuỗi. Sau khi gọi nguồn đó, P9.4 phải
//  resolve lại rồi hỏi sufficiency lại rồi hỏi selector lại. Đó chính là cách
//  điều kiện dừng được bảo đảm (ACQUISITION_POLICY.md §H): mỗi vòng phải chứng
//  minh vẫn còn thiếu thì mới được đi tiếp.
//
//  Luật đầy đủ: ACQUISITION_POLICY.md §E.
// ============================================================================

import {
  VesselField,
  VesselFieldGroup,
  getFieldGroup,
  getFieldsInGroup,
} from "../../domain/value-objects/VesselField";
import { VesselObservationKey } from "../../domain/observations/VesselObservation";
import {
  VesselIdentifier,
  imoIdentifier,
  mmsiIdentifier,
} from "../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import {
  FieldSupportStatus,
  SourceCapability,
  SourceCostType,
} from "../capabilities/SourceCapability";
import { getSourceCapability } from "../capabilities/capabilityQueries";
import { SOURCE_CAPABILITY_MATRIX } from "../capabilities/sourceCapabilityMatrix";
import { SourceHealthState } from "../runtime/SourceHealthTracker";
import { ProviderOperation } from "../providers/VesselDataProvider";
import { CollectOperation } from "../use-cases/CollectVesselObservations";
import {
  AcquisitionAttempt,
  AcquisitionOutcome,
  AttemptScope,
  attemptMatchesVessel,
} from "./AcquisitionAttempt";
import { DataNeed, getGroupsForNeed } from "./DataNeed";
import {
  DEFAULT_FREE_SOURCE_SELECTION_POLICY,
  FreeSourceSelectionPolicy,
} from "./FreeSourceSelectionPolicy";
import { MissingReason, SufficiencyResult } from "./SufficiencyTypes";
import {
  AcquisitionRequirement,
  FreeSourceSelectionResult,
  SkippedSource,
  SourceAttemptPlan,
  SourceSelectionReason,
  SourceSkipReason,
} from "./SourceSelectionTypes";

export interface FreeSourceSelectorInput {
  readonly key: VesselObservationKey;
  readonly need: DataNeed;
  readonly sufficiency: SufficiencyResult;
  /**
   * ĐỌC sức khoẻ, không sở hữu nó. Truyền hàm thay vì `SourceRuntimeManager`
   * để selector không thể vô tình gọi `recordFailure`/`enterCooldown` —
   * vòng đời health thuộc runtime P4.
   */
  readonly healthOf: (source: VesselSource) => SourceHealthState;
  /** Do người gọi giữ. P9.3 không lưu ở đâu. */
  readonly attempts?: readonly AcquisitionAttempt[];
  readonly now: Date;
}

export interface FreeSourceSelectorDeps {
  policy?: FreeSourceSelectionPolicy;
}

/**
 * Nhóm canonical -> cờ operation trong matrix.
 *
 * `identity` KHÔNG có cờ riêng, và đó là sự thật của matrix chứ không phải
 * thiếu sót: identity đi kèm mọi response tra theo định danh. Nguồn tra được
 * bằng MMSI/IMO là nguồn lấy được identity — cổng định danh đã bao việc này.
 */
const OPERATION_FLAG_BY_GROUP: Readonly<
  Record<VesselFieldGroup, keyof SourceCapability["operations"] | null>
> = Object.freeze({
  [VesselFieldGroup.POSITION]: "position",
  [VesselFieldGroup.PARTICULARS]: "particulars",
  [VesselFieldGroup.VOYAGE]: "voyage",
  [VesselFieldGroup.IDENTITY]: null,
});

/**
 * Field TỐI THIỂU để coi một nguồn giải được cả NHÓM (khi người gọi không chỉ
 * đích danh field nào). Khớp đúng định nghĩa "đủ" của P9.2 §D.
 */
const GROUP_MINIMUM_FIELDS: Readonly<Record<VesselFieldGroup, readonly VesselField[] | null>> =
  Object.freeze({
    // Cần cả mốc NGUỒN, không chỉ toạ độ. Vị trí không rõ tuổi rơi vào bậc
    // NO_SOURCE_TIME của resolver -> không bao giờ đủ tươi, nên nguồn không
    // khai được `positionReceivedAt` thì gọi nó cũng không giải quyết gì.
    [VesselFieldGroup.POSITION]: Object.freeze([
      VesselField.LAT,
      VesselField.LNG,
      VesselField.POSITION_RECEIVED_AT,
    ]),
    [VesselFieldGroup.IDENTITY]: Object.freeze([VesselField.NAME]),
    [VesselFieldGroup.VOYAGE]: Object.freeze([VesselField.DESTINATION]),
    // `null` = "bất kỳ field nào của nhóm cũng được" (P9.2: particulars trần
    // chỉ đòi có gì đó dùng được).
    [VesselFieldGroup.PARTICULARS]: null,
  });

const HEALTH_RANK: Readonly<Record<SourceHealthState, number>> = Object.freeze({
  [SourceHealthState.HEALTHY]: 0,
  [SourceHealthState.DEGRADED]: 1,
  // Hai bậc dưới không bao giờ tới được bước sắp xếp — đã bị cổng health loại.
  [SourceHealthState.COOLDOWN]: 2,
  [SourceHealthState.DISABLED]: 3,
});

/** `mmsiIdentifier`/`imoIdentifier` ném khi giá trị rác — ở đây rác chỉ nghĩa là "không dùng được". */
function tryIdentifier(
  build: (value: string) => VesselIdentifier,
  value: string
): VesselIdentifier | null {
  try {
    return build(value);
  } catch {
    return null;
  }
}

interface Candidate {
  readonly source: VesselSource;
  readonly capability: Readonly<SourceCapability>;
  readonly identifier: VesselIdentifier;
  /** Yêu cầu mà nguồn này giải được. Rỗng -> không phải ứng viên. */
  readonly covered: readonly AcquisitionRequirement[];
  readonly healthRank: number;
  /** Vị trí trong `positionPreference`; không có mặt -> cuối bảng. */
  readonly positionRank: number;
  /** Nhóm ĐỘNG nhất mà nguồn này chạm tới. Nhỏ hơn = động hơn. */
  readonly groupRank: number;
}

export class FreeSourceSelector {
  private readonly policy: FreeSourceSelectionPolicy;

  constructor(deps: FreeSourceSelectorDeps = {}) {
    this.policy = deps.policy ?? DEFAULT_FREE_SOURCE_SELECTION_POLICY;
  }

  select(input: FreeSourceSelectorInput): FreeSourceSelectionResult {
    // Đã đủ thì không có gì để lấy. Không cân nhắc nguồn nào, không trace gì.
    if (input.sufficiency.satisfied) {
      return { next: null, skipped: Object.freeze([]) };
    }

    const requirements = this.toRequirements(input.sufficiency, input.need);
    if (requirements.length === 0) {
      return { next: null, skipped: Object.freeze([]) };
    }

    const skipped: SkippedSource[] = [];
    const candidates: Candidate[] = [];

    // Duyệt theo tên nguồn -> `skipped` tất định, không phụ thuộc thứ tự khoá
    // của object matrix.
    const sources = (Object.keys(SOURCE_CAPABILITY_MATRIX) as VesselSource[]).sort((a, b) =>
      a.localeCompare(b)
    );

    for (const source of sources) {
      const candidate = this.evaluate(source, requirements, input, skipped);
      if (candidate !== null) candidates.push(candidate);
    }

    if (candidates.length === 0) {
      return { next: null, skipped: Object.freeze(skipped) };
    }

    const ordered = [...candidates].sort((a, b) => this.compare(a, b, requirements));
    const [winner, runnerUp] = ordered;

    return {
      next: FreeSourceSelector.toPlan(winner, runnerUp, candidates.length),
      skipped: Object.freeze(skipped),
    };
  }

  // ---- missing -> requirement ----------------------------------------------

  /**
   * Dịch "thiếu cái gì" (P9.2) sang "cần lấy được cái gì" (P9.3).
   *
   * `NO_CURRENT_VESSEL` KHÔNG có nghĩa "gọi mọi nguồn": nó suy ra đúng bộ yêu
   * cầu MẶC ĐỊNH của need, y hệt bộ mà P9.2 dùng để nói "đủ" — hai tầng phải
   * nói về cùng một thứ.
   */
  private toRequirements(
    sufficiency: SufficiencyResult,
    need: DataNeed
  ): readonly AcquisitionRequirement[] {
    const collected: AcquisitionRequirement[] = [];

    for (const item of sufficiency.missing) {
      if (item.reason === MissingReason.NO_CURRENT_VESSEL) {
        for (const group of getGroupsForNeed(need.type)) collected.push({ group });
        // ⚠️ Phải kèm CẢ field người gọi chỉ đích danh. Chưa có canonical thì
        // P9.2 chỉ kịp nói "không có gì" — nó không liệt kê từng field thiếu.
        // Bỏ qua chỗ này thì "cần builtYear" trên một con tàu chưa có dữ liệu
        // sẽ rơi về yêu cầu particulars CHUNG, và ta chọn phải nguồn không cấp
        // được builtYear.
        for (const field of need.requiredFields ?? []) {
          collected.push({ group: getFieldGroup(field), field });
        }
        continue;
      }
      if (item.group === undefined) continue;

      switch (item.reason) {
        // Cả nhóm vắng, hoặc vị trí có mà quá cũ -> cùng một yêu cầu: lấy nhóm đó.
        case MissingReason.MISSING_GROUP:
        case MissingReason.POSITION_NOT_FRESH_ENOUGH:
          collected.push({ group: item.group });
          break;
        case MissingReason.MISSING_REQUIRED_FIELD:
        case MissingReason.VOYAGE_TOO_OLD:
        case MissingReason.FIELD_TOO_OLD:
          collected.push({ group: item.group, field: item.field });
          break;
      }
    }

    // Bỏ trùng rồi sắp tất định -> `missing` xáo trộn không đổi kết quả.
    const unique = new Map<string, AcquisitionRequirement>();
    for (const requirement of collected) {
      unique.set(`${requirement.group}|${requirement.field ?? "*"}`, requirement);
    }

    return Object.freeze(
      [...unique.values()].sort((a, b) => {
        const rank = this.groupRank(a.group) - this.groupRank(b.group);
        if (rank !== 0) return rank;
        return (a.field ?? "").localeCompare(b.field ?? "");
      })
    );
  }

  // ---- cổng lọc -------------------------------------------------------------

  /** `null` = bị loại; lý do đã đẩy vào `skipped`. */
  private evaluate(
    source: VesselSource,
    requirements: readonly AcquisitionRequirement[],
    input: FreeSourceSelectorInput,
    skipped: SkippedSource[]
  ): Candidate | null {
    const capability = getSourceCapability(source);

    // Cổng 1 — CHỈ nguồn FREE. Loại luôn `EXISTING_STREAM` (AISStream: Marine
    // sở hữu connection, bot không mở cái thứ hai) lẫn `PAID` (MyShipTracking:
    // cổng trả tiền là việc của P9.4+, không phải của bộ chọn free).
    if (capability.costType !== SourceCostType.FREE) {
      skipped.push({ source, reason: SourceSkipReason.UNSUPPORTED_NEED });
      return null;
    }

    // Cổng 2 — capability TRƯỚC sức khoẻ. Nguồn khoẻ mà không cấp được thứ đang
    // thiếu thì khoẻ cũng vô ích (ACQUISITION_POLICY.md §E.2).
    const covered = requirements.filter((requirement) =>
      FreeSourceSelector.canCover(capability, requirement)
    );
    if (covered.length === 0) {
      skipped.push({ source, reason: SourceSkipReason.NO_REQUIRED_CAPABILITY });
      return null;
    }

    // Cổng 3 — định danh. ShipFinder trả 404 cho /ship/detail/imo/{imo}; một
    // yêu cầu chỉ có IMO mà gọi nó là NOT_FOUND ĐƯỢC ĐẢM BẢO TRƯỚC. Chặn ở đây,
    // không để nó thành một request thật.
    const identifier = FreeSourceSelector.identifierFor(capability, input.key);
    if (identifier === null) {
      skipped.push({ source, reason: SourceSkipReason.UNSUPPORTED_IDENTIFIER });
      return null;
    }

    // Cổng 4 — đã thử rồi.
    const suppression = this.suppressionReason(source, input);
    if (suppression !== null) {
      skipped.push({ source, reason: suppression });
      return null;
    }

    // Cổng 5 — sức khoẻ. COOLDOWN/DISABLED loại thẳng; DEGRADED vẫn được thử,
    // chỉ xếp sau HEALTHY khi mọi thứ khác ngang nhau.
    const health = input.healthOf(source);
    if (health === SourceHealthState.DISABLED) {
      skipped.push({ source, reason: SourceSkipReason.SOURCE_DISABLED });
      return null;
    }
    if (health === SourceHealthState.COOLDOWN) {
      skipped.push({ source, reason: SourceSkipReason.SOURCE_COOLDOWN });
      return null;
    }

    return {
      source,
      capability,
      identifier,
      covered: Object.freeze(covered),
      healthRank: HEALTH_RANK[health],
      positionRank: this.positionRank(source),
      groupRank: Math.min(...covered.map((requirement) => this.groupRank(requirement.group))),
    };
  }

  /**
   * Nguồn giải được yêu cầu này không.
   *
   * CHỈ chấp nhận `CONFIRMED`. `CANDIDATE` là suy đoán chưa POC — dựa vào nó để
   * tự động đi crawl là biến phỏng đoán thành hành động
   * (SOURCE_CAPABILITY_MATRIX.md §3).
   */
  private static canCover(
    capability: Readonly<SourceCapability>,
    requirement: AcquisitionRequirement
  ): boolean {
    const flag = OPERATION_FLAG_BY_GROUP[requirement.group];
    if (flag !== null && !capability.operations[flag]) return false;

    if (requirement.field !== undefined) {
      return capability.fields[requirement.field] === FieldSupportStatus.CONFIRMED;
    }

    const minimum = GROUP_MINIMUM_FIELDS[requirement.group];
    if (minimum === null) {
      // "Bất kỳ field nào của nhóm" -> có ít nhất một CONFIRMED là đủ.
      return getFieldsInGroup(requirement.group).some(
        (field) => capability.fields[field] === FieldSupportStatus.CONFIRMED
      );
    }
    return minimum.every((field) => capability.fields[field] === FieldSupportStatus.CONFIRMED);
  }

  /**
   * Trục tra dùng được cho nguồn này, hoặc `null`.
   *
   * MMSI trước — mọi nguồn đang có provider đều tra được bằng MMSI, còn IMO thì
   * không (ShipFinder trả 404). Định danh RÁC (dữ liệu cũ trong DB) bị coi như
   * "không tra được" chứ KHÔNG ném: một khoá hỏng không được phép làm chết cả
   * lượt acquisition khi nguồn khác vẫn còn dùng được.
   */
  private static identifierFor(
    capability: Readonly<SourceCapability>,
    key: VesselObservationKey
  ): VesselIdentifier | null {
    if (key.mmsi !== undefined && capability.operations.searchByMmsi) {
      const identifier = tryIdentifier(mmsiIdentifier, key.mmsi);
      if (identifier !== null) return identifier;
    }
    if (key.imo !== undefined && capability.operations.searchByImo) {
      const identifier = tryIdentifier(imoIdentifier, key.imo);
      if (identifier !== null) return identifier;
    }
    return null;
  }

  /** `null` = không bị chặn. */
  private suppressionReason(
    source: VesselSource,
    input: FreeSourceSelectorInput
  ): SourceSkipReason | null {
    let recent: SourceSkipReason | null = null;

    for (const attempt of input.attempts ?? []) {
      if (attempt.source !== source) continue;
      if (!attemptMatchesVessel(attempt, input.key)) continue;

      // Đã thử trong CHÍNH lượt này -> chặn ngay, không TTL. Đây là hàng rào
      // chống vòng lặp: gọi ShipFinder, hỏng, rồi lại chọn ShipFinder.
      // Kể cả SUCCESS: dữ liệu nó có đã lấy rồi, hỏi lại cho ra đúng thế.
      if (attempt.scope === AttemptScope.CURRENT_REQUEST) {
        return SourceSkipReason.ALREADY_ATTEMPTED_THIS_REQUEST;
      }

      if (this.withinRecentWindow(attempt, input.now)) {
        recent = SourceSkipReason.RECENTLY_ATTEMPTED;
      }
    }

    return recent;
  }

  /**
   * ⚠️ `FAILED` KHÔNG có cửa sổ chặn riêng: `SourceHealthTracker` (P4) đã đếm
   * chuỗi hỏng và tự bật COOLDOWN. Chặn chồng thêm một tầng nữa ở đây sẽ khoá
   * nguồn lâu hơn ý định của cả hai chính sách, và không ai biết tầng nào đang
   * khoá.
   */
  private withinRecentWindow(attempt: AcquisitionAttempt, now: Date): boolean {
    const age = Math.max(0, now.getTime() - attempt.attemptedAt.getTime());
    switch (attempt.outcome) {
      case AcquisitionOutcome.NOT_FOUND:
        return age < this.policy.recentNotFoundTtlMs;
      case AcquisitionOutcome.SUCCESS:
        return age < this.policy.recentSuccessTtlMs;
      case AcquisitionOutcome.FAILED:
        return false;
    }
  }

  // ---- sắp xếp --------------------------------------------------------------

  /**
   * Nhỏ hơn = tốt hơn. Kết thúc bằng tên nguồn -> tất định, không phụ thuộc thứ
   * tự đầu vào.
   *
   * ⚠️ Bảng ưu tiên vị trí đứng TRƯỚC sức khoẻ, khác với thứ tự gợi ý trong
   * spec. Lý do: preference mã hoá "nguồn nào GIẢI ĐƯỢC bài toán", không phải
   * "nguồn nào đang tiện". ShipInfo `HEALTHY` vẫn trễ ~14 giờ nên không bao giờ
   * cho ra vị trí `LIVE`; ShipFinder `DEGRADED` thì vẫn còn cơ hội. Chọn nguồn
   * khoẻ hơn ở đây là tiêu một request để chắc chắn vẫn chưa đủ. `DEGRADED`
   * nghĩa là "có chuỗi hỏng chưa tới ngưỡng", không phải "hỏng".
   */
  private compare(
    a: Candidate,
    b: Candidate,
    requirements: readonly AcquisitionRequirement[]
  ): number {
    // 1. Giải được nhiều yêu cầu hơn -> ít request hơn cho cùng kết quả.
    if (a.covered.length !== b.covered.length) return b.covered.length - a.covered.length;

    // 2. Ưu tiên riêng cho vị trí — chỉ khi vị trí thực sự đang thiếu.
    if (requirements.some((requirement) => requirement.group === VesselFieldGroup.POSITION)) {
      if (a.positionRank !== b.positionRank) return a.positionRank - b.positionRank;
    }

    // 3. Dữ liệu ĐỘNG trước dữ liệu tĩnh: vị trí/chuyến đi cũ đi theo thời gian,
    //    `length`/`builtYear` thì không — hoãn chúng một lượt không mất gì.
    if (a.groupRank !== b.groupRank) return a.groupRank - b.groupRank;

    // 4. Ngang khả năng -> nguồn khoẻ hơn.
    if (a.healthRank !== b.healthRank) return a.healthRank - b.healthRank;

    // 5. `defaultPriority` CHỈ là tie-break, không phải tiêu chí đầu.
    if (a.capability.defaultPriority !== b.capability.defaultPriority) {
      return a.capability.defaultPriority - b.capability.defaultPriority;
    }
    return a.source.localeCompare(b.source);
  }

  private groupRank(group: VesselFieldGroup): number {
    const index = this.policy.dynamicGroupOrder.indexOf(group);
    return index === -1 ? this.policy.dynamicGroupOrder.length : index;
  }

  private positionRank(source: VesselSource): number {
    const index = this.policy.positionPreference.indexOf(source);
    return index === -1 ? this.policy.positionPreference.length : index;
  }

  // ---- plan -----------------------------------------------------------------

  private static toPlan(
    winner: Candidate,
    runnerUp: Candidate | undefined,
    candidateCount: number
  ): SourceAttemptPlan {
    const groups = new Set(winner.covered.map((requirement) => requirement.group));
    const positionOnly =
      groups.size === 1 && groups.has(VesselFieldGroup.POSITION);

    return {
      source: winner.source,
      // Chỉ thiếu mỗi vị trí -> request nhẹ nhất. Còn nhóm khác -> `getDetails`,
      // vì `ProviderDetailsResult` mang được CẢ BỐN nhóm (kể cả position) nên
      // một request giải hết. Hai request cho hai nhóm là phí một lượt nghỉ 3–8s.
      operation: positionOnly
        ? (ProviderOperation.GET_POSITION as CollectOperation)
        : (ProviderOperation.GET_DETAILS as CollectOperation),
      identifier: winner.identifier,
      targetFields: FreeSourceSelector.targetFields(winner),
      reason: FreeSourceSelector.selectionReason(winner, runnerUp, candidateCount),
    };
  }

  /** Field mà LẦN GỌI NÀY nhắm tới — gộp mọi yêu cầu nguồn này giải được. */
  private static targetFields(candidate: Candidate): readonly VesselField[] {
    const fields = new Set<VesselField>();

    for (const requirement of candidate.covered) {
      if (requirement.field !== undefined) {
        fields.add(requirement.field);
        continue;
      }
      const minimum = GROUP_MINIMUM_FIELDS[requirement.group];
      if (minimum !== null) {
        for (const field of minimum) fields.add(field);
        continue;
      }
      // Nhóm "bất kỳ field nào" -> nhắm tới đúng những field nguồn CONFIRMED.
      for (const field of getFieldsInGroup(requirement.group)) {
        if (candidate.capability.fields[field] === FieldSupportStatus.CONFIRMED) {
          fields.add(field);
        }
      }
    }

    return Object.freeze([...fields].sort((a, b) => a.localeCompare(b)));
  }

  /** Tiêu chí ĐẦU TIÊN phân định kẻ thắng với kẻ đứng ngay sau. */
  private static selectionReason(
    winner: Candidate,
    runnerUp: Candidate | undefined,
    candidateCount: number
  ): SourceSelectionReason {
    if (candidateCount === 1) return SourceSelectionReason.ONLY_SOURCE_FOR_REQUIRED_FIELD;
    if (runnerUp === undefined) return SourceSelectionReason.ONLY_SOURCE_FOR_REQUIRED_FIELD;

    if (winner.covered.length !== runnerUp.covered.length) {
      return SourceSelectionReason.BEST_CAPABILITY_MATCH;
    }
    if (
      winner.positionRank !== runnerUp.positionRank &&
      winner.covered.some((requirement) => requirement.group === VesselFieldGroup.POSITION)
    ) {
      return SourceSelectionReason.BEST_POSITION_SOURCE;
    }
    if (winner.groupRank !== runnerUp.groupRank) {
      return SourceSelectionReason.BEST_CAPABILITY_MATCH;
    }
    if (winner.healthRank !== runnerUp.healthRank) {
      return SourceSelectionReason.HEALTHIER_SOURCE;
    }
    return SourceSelectionReason.LOWER_COST_FREE_SOURCE;
  }
}
