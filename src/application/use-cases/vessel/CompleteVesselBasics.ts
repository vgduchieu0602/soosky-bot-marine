// ============================================================================
//  APPLICATION · USE CASE: CompleteVesselBasics
//  → Lấp nốt VesselBasics còn THIẾU của một tàu ĐÃ BIẾT, bằng ít request nhất.
// ----------------------------------------------------------------------------
//      mmsi -> canonical hiện có -> field nào còn thiếu/ôi
//           -> gọi ĐÚNG nguồn có khả năng lấp field đó
//           -> CollectVesselObservations (observation + crawl runtime)
//           -> ResolveAndStoreCurrentVessel -> canonical
//
//  Đây KHÔNG phải "detail enrichment". Phạm vi đóng khung đúng 10 field của
//  `VesselBasics`; GT/DWT/năm đóng/chuyến đi/cảng KHÔNG thuộc đây.
//
//  ⚠️ Điều quan trọng nhất là thứ nó KHÔNG làm: nếu canonical còn đủ và còn
//  tươi thì use case này KHÔNG chạm mạng. Một chu kỳ quét map ra 500 tàu không
//  được phép biến thành 500 lượt tra chi tiết.
//
//  Thứ tự nguồn KHÔNG hardcode theo cảm tính — nó đến từ số đo thật (PHASE 4):
//    • ShipFinder  : imo 32%, lat/lon 96%, speed 96%, course 71%, nav 51%,
//                    received 96%, và 66/90 vị trí tươi <= 15 phút.
//    • VesselFinder: nguồn DUY NHẤT có mã AIS số (`vType`), nhưng hay bị chặn.
//    • ShipInfo    : chỉ là lưới cuối — 403 sau vài request.
//
//  KHÔNG có fallback tự động "gọi hết mọi nguồn khi một nguồn hỏng": mỗi nguồn
//  chỉ được gọi khi nó thực sự lấp được field còn thiếu, và vòng lặp dừng ngay
//  khi không còn gì để lấp.
// ============================================================================

import { ICurrentVesselRepository } from "../../contracts/repositories/ICurrentVesselRepository";
import { IVesselObservationRepository } from "../../contracts/repositories/IVesselObservationRepository";
import { DEFAULT_FREE_SOURCE_SELECTION_POLICY } from "../../services/acquisition/FreeSourceSelectionPolicy";
import {
  DEFAULT_POSITION_RESOLVER_POLICY,
  PositionResolverPolicy,
} from "../../services/resolution/PositionResolverPolicy";
import { CollectStatus, CollectVesselObservations } from "../observation/CollectVesselObservations";
import { ResolveAndStoreCurrentVessel } from "../resolution/ResolveAndStoreCurrentVessel";
import { ResolvedCurrentVessel } from "../../services/resolution/ResolvedCurrentVessel";
import { SourceRequestError, SourceUnavailableError } from "../../services/crawl-runtime/SourceError";
import { VesselField } from "../../../domain/enums/VesselField";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { mmsiIdentifier } from "../../../domain/value-objects/VesselIdentifier";

/** Đúng 10 field của hợp đồng VesselBasics, không hơn. */
export const VESSEL_BASICS_FIELDS: readonly VesselField[] = Object.freeze([
  VesselField.NAME,
  VesselField.IMO,
  VesselField.VESSEL_TYPE_CODE,
  VesselField.LAT,
  VesselField.LNG,
  VesselField.COURSE,
  VesselField.SPEED,
  VesselField.NAV_STATUS,
  VesselField.POSITION_RECEIVED_AT,
]);

/** Nguồn nào lấp được field nào — đo được ở PHASE 4, không phải phỏng đoán. */
const FIELDS_BY_SOURCE: Readonly<Record<string, readonly VesselField[]>> = Object.freeze({
  [VesselSource.SHIPFINDER]: Object.freeze([
    VesselField.NAME,
    VesselField.IMO,
    VesselField.LAT,
    VesselField.LNG,
    VesselField.COURSE,
    VesselField.SPEED,
    VesselField.NAV_STATUS,
    VesselField.POSITION_RECEIVED_AT,
  ]),
  [VesselSource.VESSELFINDER]: Object.freeze([
    VesselField.NAME,
    // Nguồn DUY NHẤT đo được có mã AIS số.
    VesselField.VESSEL_TYPE_CODE,
    VesselField.LAT,
    VesselField.LNG,
    VesselField.COURSE,
    VesselField.SPEED,
    VesselField.NAV_STATUS,
    VesselField.POSITION_RECEIVED_AT,
  ]),
  [VesselSource.SHIPINFO]: Object.freeze([
    VesselField.NAME,
    VesselField.IMO,
    VesselField.LAT,
    VesselField.LNG,
    VesselField.COURSE,
    VesselField.SPEED,
    VesselField.POSITION_RECEIVED_AT,
  ]),
});

/** Nhãn nghĩa là "ô trống", không phải một trạng thái hành hải. */
const NAV_STATUS_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "",
  "-",
  "--",
  "---",
  "unknown",
  "n/a",
]);

/**
 * navStatus có mang dữ liệu thật không.
 *
 * ⚠️ `code = 0` ("under way using engine") là GIÁ TRỊ. Mọi kiểm tra kiểu
 * `code || text` sẽ nuốt mất nó.
 */
function hasNavStatus(navStatus: { code?: number | null; text?: string | null } | null | undefined): boolean {
  if (navStatus === null || navStatus === undefined) return false;
  if (typeof navStatus.code === "number") return true;
  const text = navStatus.text;
  if (typeof text !== "string") return false;
  return !NAV_STATUS_PLACEHOLDERS.has(text.trim().toLowerCase());
}

/** Nhóm phụ thuộc độ tươi — cũ quá thì coi như chưa có. */
const MOTION_BASICS_FIELDS: readonly VesselField[] = Object.freeze([
  VesselField.SPEED,
  VesselField.COURSE,
  VesselField.NAV_STATUS,
  VesselField.POSITION_RECEIVED_AT,
]);

export const DEFAULT_BASICS_SOURCE_ORDER: readonly VesselSource[] = Object.freeze([
  VesselSource.SHIPFINDER,
  VesselSource.VESSELFINDER,
  VesselSource.SHIPINFO,
]);

export const CompleteBasicsStatus = {
  /** Canonical đã đủ và còn tươi -> KHÔNG chạm mạng. */
  ALREADY_SUFFICIENT: "ALREADY_SUFFICIENT",
  /** Có gọi nguồn và canonical đã được ghi lại. */
  COMPLETED: "COMPLETED",
  /** Có gọi nguồn nhưng vẫn còn field thiếu. */
  PARTIAL: "PARTIAL",
  /** Mọi nguồn ứng viên đều không dùng được (chặn/cooldown). */
  NO_SOURCE_AVAILABLE: "NO_SOURCE_AVAILABLE",
} as const;

export type CompleteBasicsStatus =
  (typeof CompleteBasicsStatus)[keyof typeof CompleteBasicsStatus];

export interface SourceAttempt {
  readonly source: VesselSource;
  /** Field còn thiếu mà nguồn này được kỳ vọng lấp. */
  readonly targeted: readonly VesselField[];
  readonly outcome: "RECORDED" | "NOT_FOUND" | "UNAVAILABLE" | "ERROR" | "RECENTLY_ASKED";
  readonly error?: string;
}

export interface CompleteVesselBasicsResult {
  readonly mmsi: string;
  readonly status: CompleteBasicsStatus;
  /** Thiếu gì TRƯỚC khi gọi nguồn. */
  readonly missingBefore: readonly VesselField[];
  /** Còn thiếu gì SAU khi gọi. */
  readonly missingAfter: readonly VesselField[];
  readonly attempts: readonly SourceAttempt[];
  /** Số request thực sự bắn ra — dùng để chứng minh không có bão request. */
  readonly requests: number;
  readonly vessel: ResolvedCurrentVessel | null;
}

export interface CompleteVesselBasicsDeps {
  currentVesselRepository: ICurrentVesselRepository;
  collect: CollectVesselObservations;
  resolveAndStore: ResolveAndStoreCurrentVessel;
  /** Ngưỡng "còn tươi" cho nhóm motion. Mặc định dùng lại policy của resolver. */
  policy?: PositionResolverPolicy;
  /**
   * Dùng để biết một nguồn VỪA được hỏi hay chưa. Không truyền -> mất hàng rào
   * chống hỏi lại, và mỗi chu kỳ sẽ hỏi lại đúng những nguồn vừa trả lời "không có".
   */
  observationRepository?: IVesselObservationRepository;
  /** Khoảng thời gian tối thiểu trước khi hỏi LẠI cùng một nguồn về cùng một tàu. */
  sourceRetryTtlMs?: number;
  sourceOrder?: readonly VesselSource[];
  now?: () => Date;
}

export class CompleteVesselBasics {
  private readonly repository: ICurrentVesselRepository;
  private readonly collect: CollectVesselObservations;
  private readonly resolveAndStore: ResolveAndStoreCurrentVessel;
  private readonly policy: PositionResolverPolicy;
  private readonly observations?: IVesselObservationRepository;
  private readonly sourceRetryTtlMs: number;
  private readonly sourceOrder: readonly VesselSource[];
  private readonly now: () => Date;

  constructor(deps: CompleteVesselBasicsDeps) {
    this.repository = deps.currentVesselRepository;
    this.collect = deps.collect;
    this.resolveAndStore = deps.resolveAndStore;
    this.policy = deps.policy ?? DEFAULT_POSITION_RESOLVER_POLICY;
    this.observations = deps.observationRepository;
    this.sourceRetryTtlMs =
      deps.sourceRetryTtlMs ?? DEFAULT_FREE_SOURCE_SELECTION_POLICY.recentSuccessTtlMs;
    this.sourceOrder = deps.sourceOrder ?? DEFAULT_BASICS_SOURCE_ORDER;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * @param mmsi Tàu ĐÃ BIẾT. Use case này không khám phá tàu mới.
   * @throws không ném vì nguồn hỏng — nguồn hỏng là một KẾT QUẢ, ghi vào
   *         `attempts` rồi đi tiếp sang nguồn khác.
   */
  async execute(mmsi: string): Promise<CompleteVesselBasicsResult> {
    const now = this.now();
    const before = await this.repository.findByMmsi(mmsi);
    const missingBefore = this.missingBasics(before, now);

    // Còn đủ và còn tươi -> DỪNG. Đây là hàng rào chống bão request.
    if (missingBefore.length === 0) {
      return {
        mmsi,
        status: CompleteBasicsStatus.ALREADY_SUFFICIENT,
        missingBefore: [],
        missingAfter: [],
        attempts: [],
        requests: 0,
        vessel: before,
      };
    }

    const attempts: SourceAttempt[] = [];
    let requests = 0;
    let missing = missingBefore;

    for (const source of this.sourceOrder) {
      if (missing.length === 0) break;
      const canFill = (FIELDS_BY_SOURCE[source] ?? []).filter((f) => missing.includes(f));
      // Nguồn không lấp được gì đang thiếu -> KHÔNG gọi. Tiết kiệm nguyên một request.
      if (canFill.length === 0) continue;

      // Nguồn VỪA được hỏi về đúng con tàu này -> KHÔNG hỏi lại.
      //
      // Đây là hàng rào quan trọng nhất chống bão request: field mà KHÔNG nguồn
      // nào có (VD `imo` của tàu nhỏ) sẽ "còn thiếu" mãi mãi, và nếu không có
      // luật này thì mỗi chu kỳ lại đi hỏi đủ ba nguồn về đúng field đó.
      // Bằng chứng là "đã hỏi" nằm sẵn trong observation store nên nó SỐNG SÓT
      // qua restart, không phải bộ nhớ tạm trong tiến trình.
      if (await this.askedRecently(mmsi, source, now)) {
        attempts.push({ source, targeted: canFill, outcome: "RECENTLY_ASKED" });
        continue;
      }

      requests += 1;
      try {
        const result = await this.collect.execute({
          source,
          identifier: mmsiIdentifier(mmsi),
        });
        attempts.push({
          source,
          targeted: canFill,
          outcome: result.status === CollectStatus.RECORDED ? "RECORDED" : "NOT_FOUND",
        });
        if (result.status === CollectStatus.RECORDED) {
          // Phân xử lại NGAY để nguồn sau chỉ phải lo phần còn thiếu thật sự.
          await this.resolveAndStore.execute({ mmsi });
          missing = this.missingBasics(await this.repository.findByMmsi(mmsi), this.now());
        }
      } catch (err) {
        const unavailable =
          err instanceof SourceUnavailableError || err instanceof SourceRequestError;
        attempts.push({
          source,
          targeted: canFill,
          outcome: unavailable ? "UNAVAILABLE" : "ERROR",
          error: (err as Error).message?.slice(0, 200),
        });
      }
    }

    const vessel = await this.repository.findByMmsi(mmsi);
    const missingAfter = this.missingBasics(vessel, this.now());
    const recorded = attempts.some((a) => a.outcome === "RECORDED");

    return {
      mmsi,
      status:
        missingAfter.length === 0
          ? CompleteBasicsStatus.COMPLETED
          : recorded
            ? CompleteBasicsStatus.PARTIAL
            : CompleteBasicsStatus.NO_SOURCE_AVAILABLE,
      missingBefore,
      missingAfter,
      attempts,
      requests,
      vessel,
    };
  }

  /**
   * Field VesselBasics còn THIẾU hoặc đã ÔI.
   *
   * Cố ý KHÔNG dùng `LocalDataSufficiencyChecker` ở đây, vì hai lý do cụ thể:
   *   1. nó ra đời TRƯỚC khối `position.motion`, nên vẫn tìm speed/course
   *      trong payload vị trí — nơi các field đó không còn nằm nữa;
   *   2. `DataNeed` nhận đúng MỘT nhóm, còn VesselBasics cắt ngang hai nhóm
   *      (identity + position), và `DataNeedType.FULL` lại đòi thêm
   *      particulars/voyage vốn KHÔNG thuộc hợp đồng này.
   *
   * Ngưỡng "tươi" vẫn LẤY LẠI từ `PositionResolverPolicy` — không đẻ ra một
   * định nghĩa tươi thứ hai trong hệ thống.
   */
  private missingBasics(
    vessel: ResolvedCurrentVessel | null,
    now: Date
  ): readonly VesselField[] {
    if (vessel === null) return VESSEL_BASICS_FIELDS;

    const missing = VESSEL_BASICS_FIELDS.filter((field) => !this.hasField(vessel, field));

    // Motion có mặt nhưng quá cũ cũng là "thiếu": vị trí hôm qua không trả lời
    // được câu hỏi tàu đang ở đâu. Mốc so sánh là giờ NGUỒN khai, không phải
    // giờ ta tải về.
    const observedAt = vessel.position?.motion?.observedAt ?? null;
    const stale =
      observedAt === null ||
      now.getTime() - observedAt.getTime() > this.policy.recentMaxAgeMs;
    if (stale) {
      for (const field of MOTION_BASICS_FIELDS) {
        if (!missing.includes(field)) missing.push(field);
      }
    }
    return missing;
  }

  /** Nguồn này đã trả lời về tàu này trong `sourceRetryTtlMs` gần đây chưa. */
  private async askedRecently(
    mmsi: string,
    source: VesselSource,
    now: Date
  ): Promise<boolean> {
    if (this.observations === undefined) return false;
    const since = new Date(now.getTime() - this.sourceRetryTtlMs);
    const recent = await this.observations.findRecentByVessel(
      { mmsi },
      { since, includeInvalid: true }
    );
    return recent.some((observation) => observation.source === source);
  }

  private hasField(vessel: ResolvedCurrentVessel | null, field: VesselField): boolean {
    if (vessel === null) return false;
    switch (field) {
      case VesselField.NAME: return vessel.identity?.name != null;
      case VesselField.IMO: return vessel.identity?.imo != null;
      case VesselField.VESSEL_TYPE_CODE: return vessel.identity?.vesselTypeCode != null;
      // Khối `position` TỒN TẠI không có nghĩa là có toạ độ. Phải soi đúng giá trị,
      // nếu không một canonical thiếu lat vẫn bị coi là "đã đủ" và không bao giờ
      // được lấp.
      case VesselField.LAT: return typeof vessel.position?.position?.lat === "number";
      case VesselField.LNG: return typeof vessel.position?.position?.lng === "number";
      case VesselField.SPEED: return vessel.position?.motion?.speed != null;
      case VesselField.COURSE: return vessel.position?.motion?.course != null;
      // Nhóm navStatus tồn tại nhưng rỗng ("Unknown", "-") KHÔNG phải dữ liệu.
      // Mã 0 thì NGƯỢC LẠI: đó là giá trị thật của tàu đang chạy máy.
      case VesselField.NAV_STATUS: return hasNavStatus(vessel.position?.motion?.navStatus);
      case VesselField.POSITION_RECEIVED_AT: return vessel.position?.motion?.observedAt != null;
      default: return false;
    }
  }
}
