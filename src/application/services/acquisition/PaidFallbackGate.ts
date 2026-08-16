// ============================================================================
//  APPLICATION · PaidFallbackGate — HÀM THUẦN, MẶC ĐỊNH TỪ CHỐI
// ----------------------------------------------------------------------------
//      (khoá, need, sufficiency, cách vòng free đã dừng, các lần đã thử,
//       cho phép trả tiền?, ngân sách, now)  ->  ALLOW | DENY + lý do
//
//  Trả lời ĐÚNG MỘT câu: "có được phép tiêu tiền cho yêu cầu này không?"
//
//  ⛔ KHÔNG gọi API · KHÔNG import client/provider · KHÔNG chạm repository ·
//  KHÔNG đếm quota · KHÔNG đọc đồng hồ · KHÔNG chọn endpoint · KHÔNG lưu gì.
//  Nó KHÔNG gọi MyShipTracking — client còn chưa tồn tại (P9.5 §31).
//
//  MẶC ĐỊNH TỪ CHỐI. Mọi đường đi ra khỏi hàm này đều là DENY, trừ đúng một
//  đường phải vượt qua CHÍN cổng. Chi phí của một `ALLOW` sai là tiền thật;
//  chi phí của một `DENY` sai chỉ là `satisfied: false`. Bất đối xứng, và luật
//  ở đây nghiêng hẳn về phía an toàn.
//
//  Luật đầy đủ: ACQUISITION_POLICY.md §L.
// ============================================================================

import {
  VesselField,
  VesselFieldGroup,
} from "../../../domain/enums/VesselField";
import { VesselObservationKey } from "../../../domain/entities/VesselObservation";
import { VesselSource } from "../../../domain/enums/VesselSource";
import {
  AcquisitionAttempt,
  AttemptScope,
  attemptMatchesVessel,
} from "./AcquisitionAttempt";
import { DataNeed, validateDataNeed } from "./DataNeed";
import {
  GROUP_MINIMUM_FIELDS,
  toAcquisitionRequirements,
} from "./acquisitionRequirements";
import { DEFAULT_FREE_SOURCE_SELECTION_POLICY } from "./FreeSourceSelectionPolicy";
import {
  DEFAULT_PAID_FALLBACK_POLICY,
  PaidBudgetSnapshot,
  PaidFallbackPolicy,
  paidTtlForGroups,
} from "./PaidFallbackPolicy";
import {
  PaidFieldValue,
  isWorthPaying,
  paidFieldValue,
} from "./PaidSourceCapability";
import { SufficiencyResult } from "./SufficiencyTypes";
import { AcquisitionRequirement } from "./SourceSelectionTypes";

/**
 * Cách vòng acquisition FREE đã kết thúc.
 *
 * Chuỗi khớp `AcquisitionStopReason` (P9.4) nhưng khai lại ở đây có chủ ý: cổng
 * này thuộc tầng acquisition, còn `AcquireFreeVesselData` là use case. Import
 * ngược lên use case sẽ khoá cổng vào đúng một người gọi.
 */
export const FreeAcquisitionOutcome = {
  LOCAL_DATA_SUFFICIENT: "LOCAL_DATA_SUFFICIENT",
  SATISFIED_AFTER_ACQUISITION: "SATISFIED_AFTER_ACQUISITION",
  /** Đã thử hết nguồn free đáng thử — ĐƯỜNG DUY NHẤT mở được cổng này. */
  NO_FREE_SOURCE_AVAILABLE: "NO_FREE_SOURCE_AVAILABLE",
  /** Hết ngân sách gọi free. Có thể VẪN CÒN nguồn free chưa thử. */
  ATTEMPT_BUDGET_EXHAUSTED: "ATTEMPT_BUDGET_EXHAUSTED",
} as const;

export type FreeAcquisitionOutcome =
  (typeof FreeAcquisitionOutcome)[keyof typeof FreeAcquisitionOutcome];

export const PaidGateDecision = {
  ALLOW: "ALLOW",
  DENY: "DENY",
} as const;

export type PaidGateDecision = (typeof PaidGateDecision)[keyof typeof PaidGateDecision];

export const PaidGateReason = {
  /** Qua đủ chín cổng. */
  PAID_ALLOWED: "PAID_ALLOWED",
  /** Người gọi không bật `allowPaidFallback`. Đây là mặc định. */
  PAID_NOT_ALLOWED: "PAID_NOT_ALLOWED",
  /** Dữ liệu local đã đủ — không mua thứ đang có. */
  LOCAL_ALREADY_SUFFICIENT: "LOCAL_ALREADY_SUFFICIENT",
  /** Đường free chưa đi hết. ⛔ Tiền không được dùng để nhảy qua hàng. */
  FREE_OPTIONS_NOT_EXHAUSTED: "FREE_OPTIONS_NOT_EXHAUSTED",
  /** Nguồn trả tiền cũng không có thứ đang thiếu. */
  NO_PAID_CAPABILITY: "NO_PAID_CAPABILITY",
  /** Chỉ còn thiếu field mà nguồn free đã cấp được — mua là mua lại. */
  ENRICHMENT_ONLY_NEED: "ENRICHMENT_ONLY_NEED",
  /** Đã gọi trả tiền trong CHÍNH lượt này. */
  PAID_ALREADY_ATTEMPTED: "PAID_ALREADY_ATTEMPTED",
  /** Vừa gọi trả tiền cho tàu này, còn trong cửa sổ chặn. */
  RECENT_PAID_ATTEMPT: "RECENT_PAID_ATTEMPT",
  /** Hết hạn mức, hoặc tài khoản trả tiền không bật. */
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  /** KHÔNG BIẾT còn bao nhiêu. Không biết thì không tiêu. */
  BUDGET_UNKNOWN: "BUDGET_UNKNOWN",
} as const;

export type PaidGateReason = (typeof PaidGateReason)[keyof typeof PaidGateReason];

export interface PaidFallbackRequest {
  readonly key: VesselObservationKey;
  readonly need: DataNeed;
  readonly sufficiency: SufficiencyResult;
  /** Vòng free đã dừng thế nào. Xem `FreeAcquisitionOutcome`. */
  readonly freeOutcome: FreeAcquisitionOutcome;
  /** Cả free lẫn paid. Cổng chỉ lọc ra các lần chạm nguồn TRẢ TIỀN. */
  readonly attempts?: readonly AcquisitionAttempt[];
  /** ⚠️ Mặc định coi như `false` nếu không phải đúng `true`. */
  readonly allowPaidFallback: boolean;
  readonly budget: PaidBudgetSnapshot;
  readonly now: Date;
}

export interface PaidFallbackDecisionResult {
  readonly decision: PaidGateDecision;
  readonly reason: PaidGateReason;
  /**
   * Field mà lần gọi trả tiền sẽ nhắm tới — chỉ những field ĐÁNG tiền.
   * Rỗng khi `DENY`.
   */
  readonly targetFields: readonly VesselField[];
}

export interface PaidFallbackGateDeps {
  policy?: PaidFallbackPolicy;
}

const NO_FIELDS: readonly VesselField[] = Object.freeze([]);

export class PaidFallbackGate {
  private readonly policy: PaidFallbackPolicy;

  constructor(deps: PaidFallbackGateDeps = {}) {
    this.policy = deps.policy ?? DEFAULT_PAID_FALLBACK_POLICY;
  }

  /**
   * @throws InvalidDataNeedError khi need sai hình dạng — lỗi người gọi, không
   *         phải "không được tiêu tiền".
   */
  evaluate(request: PaidFallbackRequest): PaidFallbackDecisionResult {
    validateDataNeed(request.need);

    // ---- Cổng 1 · MẶC ĐỊNH TỪ CHỐI -----------------------------------------
    // `!== true` chứ không phải `=== false`: `undefined` do quên khai cũng phải
    // là từ chối. Không có đường nào tiêu tiền một cách ngầm định.
    if (request.allowPaidFallback !== true) {
      return deny(PaidGateReason.PAID_NOT_ALLOWED);
    }

    // ---- Cổng 2 · Đã đủ thì không mua --------------------------------------
    // Đứng TRƯỚC mọi thứ khác: người gọi bật `allowPaidFallback` không có nghĩa
    // là muốn tiêu tiền, chỉ có nghĩa là cho phép khi thật sự cần.
    if (request.sufficiency.satisfied) {
      return deny(PaidGateReason.LOCAL_ALREADY_SUFFICIENT);
    }

    // ---- Cổng 3 · Đường free phải đi HẾT -----------------------------------
    // CHỈ `NO_FREE_SOURCE_AVAILABLE` mở được cổng. `ATTEMPT_BUDGET_EXHAUSTED`
    // nghĩa là ta hết lượt, KHÔNG phải hết nguồn — có thể còn nguồn free chưa
    // đụng tới. Cho qua ở đó là biến ngân sách free thành đường tắt sang tiền
    // thật: cứ để nó cạn rồi mua.
    if (request.freeOutcome !== FreeAcquisitionOutcome.NO_FREE_SOURCE_AVAILABLE) {
      return deny(PaidGateReason.FREE_OPTIONS_NOT_EXHAUSTED);
    }

    // ---- Cổng 4+5 · Đã gọi trả tiền rồi ------------------------------------
    const requirements = toAcquisitionRequirements(
      request.sufficiency,
      request.need,
      DEFAULT_FREE_SOURCE_SELECTION_POLICY
    );
    if (requirements.length === 0) {
      // Không nói được thiếu gì thì không nói được mua gì.
      return deny(PaidGateReason.NO_PAID_CAPABILITY);
    }

    const suppression = this.suppressionReason(request, requirements);
    if (suppression !== null) return deny(suppression);

    // ---- Cổng 6 · Tra được bằng định danh đang có --------------------------
    // MyShipTracking nhận CẢ `mmsi` LẪN `imo` (khác ShipFinder, vốn 404 với
    // IMO). Nên cổng này chỉ chặn khoá rỗng.
    if (request.key.mmsi === undefined && request.key.imo === undefined) {
      return deny(PaidGateReason.NO_PAID_CAPABILITY);
    }

    // ---- Cổng 7+8 · Có gì để mua, và có ĐÁNG mua không ---------------------
    const priced = PaidFallbackGate.priceRequirements(requirements);
    if (priced.every((entry) => entry.value === PaidFieldValue.UNSUPPORTED)) {
      // VD: cần `heading` — response của MyShipTracking không có field đó,
      // cả simple lẫn extended. Gọi là đốt quota chắc chắn vô ích.
      return deny(PaidGateReason.NO_PAID_CAPABILITY);
    }

    const worth = priced.filter((entry) => isWorthPaying(entry.value));
    if (worth.length === 0) {
      // Còn thiếu, nguồn trả tiền CÓ, nhưng nguồn free cũng có -> mua lại thứ
      // đang có miễn phí. Đây là ca `ENRICHMENT_ONLY` của §21.
      return deny(PaidGateReason.ENRICHMENT_ONLY_NEED);
    }

    // ---- Cổng 9 · Ngân sách ------------------------------------------------
    // ĐỨNG CUỐI có chủ ý: nói "hết tiền" khi thật ra API không có field đó là
    // chẩn đoán sai, và nó sẽ khiến người vận hành đi nạp thêm quota một cách
    // vô ích.
    if (!request.budget.enabled) {
      return deny(PaidGateReason.BUDGET_EXHAUSTED);
    }
    if (request.budget.remainingCalls === null) {
      // Bảo thủ theo §25: MyShipTracking không công bố giá, nên "chắc là còn"
      // là một canh bạc bằng tiền thật.
      return deny(PaidGateReason.BUDGET_UNKNOWN);
    }
    if (request.budget.remainingCalls <= 0) {
      return deny(PaidGateReason.BUDGET_EXHAUSTED);
    }

    return {
      decision: PaidGateDecision.ALLOW,
      reason: PaidGateReason.PAID_ALLOWED,
      // Chỉ nhắm tới field ĐÁNG tiền. Field enrichment đi kèm response thì cứ
      // nhận, nhưng chúng không phải lý do của lần gọi này.
      targetFields: Object.freeze(
        [...new Set(worth.map((entry) => entry.field))].sort((a, b) => a.localeCompare(b))
      ),
    };
  }

  /**
   * `null` = không bị chặn.
   *
   * Chỉ xét lần chạm nguồn TRẢ TIỀN cho CHÍNH con tàu này. Lần thử free không
   * liên quan — chúng không tốn tiền.
   */
  private suppressionReason(
    request: PaidFallbackRequest,
    requirements: readonly AcquisitionRequirement[]
  ): PaidGateReason | null {
    const ttl = paidTtlForGroups(
      requirements.map((requirement) => requirement.group),
      this.policy
    );
    let paidThisRequest = 0;
    let recent: PaidGateReason | null = null;

    for (const attempt of request.attempts ?? []) {
      if (attempt.source !== VesselSource.MYSHIPTRACKING) continue;
      if (!attemptMatchesVessel(attempt, request.key)) continue;

      if (attempt.scope === AttemptScope.CURRENT_REQUEST) {
        paidThisRequest += 1;
        continue;
      }

      // ⚠️ Chặn theo TTL bất kể kết quả — kể cả `NOT_FOUND`. Nguồn vừa nói
      // "không có tàu này" thì hỏi lại sau vài giây cho ra đúng câu đó, và lần
      // hỏi lại vẫn có thể bị tính credit.
      const age = Math.max(0, request.now.getTime() - attempt.attemptedAt.getTime());
      if (age < ttl) recent = PaidGateReason.RECENT_PAID_ATTEMPT;
    }

    // Một lần gọi `extended` đã trả về cả bốn nhóm -> không có lý do gọi lần hai.
    if (paidThisRequest >= this.policy.maxPaidAttemptsPerRequest) {
      return PaidGateReason.PAID_ALREADY_ATTEMPTED;
    }
    return recent;
  }

  /**
   * Yêu cầu -> (field, giá trị trả tiền).
   *
   * Yêu cầu ở mức NHÓM (không chỉ đích danh field) được quy về đúng bộ field
   * tối thiểu mà P9.2 dùng để nói "đủ" — hai tầng phải nói về cùng một thứ.
   * Nhóm `particulars` không có bộ tối thiểu (bất kỳ field nào cũng được) nên
   * cố ý KHÔNG mở rộng: "cần particulars nói chung" mà free đã có thì không
   * phải lý do tiêu tiền.
   */
  private static priceRequirements(
    requirements: readonly AcquisitionRequirement[]
  ): readonly { field: VesselField; value: PaidFieldValue }[] {
    const priced: { field: VesselField; value: PaidFieldValue }[] = [];
    const seen = new Set<VesselField>();

    const add = (field: VesselField): void => {
      if (seen.has(field)) return;
      seen.add(field);
      priced.push({ field, value: paidFieldValue(field) });
    };

    for (const requirement of requirements) {
      if (requirement.field !== undefined) {
        add(requirement.field);
        continue;
      }
      const minimum = GROUP_MINIMUM_FIELDS[requirement.group as VesselFieldGroup];
      if (minimum !== null) {
        for (const field of minimum) add(field);
      }
    }
    return priced;
  }
}

function deny(reason: PaidGateReason): PaidFallbackDecisionResult {
  return { decision: PaidGateDecision.DENY, reason, targetFields: NO_FIELDS };
}
