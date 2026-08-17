// ============================================================================
//  APPLICATION · USE CASE: GetOrRefreshVesselDetail
// ----------------------------------------------------------------------------
//      identifier
//        -> GetCanonicalVesselDetail          ĐỌC TRƯỚC, luôn luôn
//        -> đủ tươi?  -> trả ngay, KHÔNG chạm nguồn ngoài
//        -> thiếu?    -> FreeSourceSelector -> CollectVesselObservations
//                     -> ResolveAndStoreCurrentVessel -> đọc lại -> trả
//
//  ⛔ KHÔNG import mongoose/Mongo repository/model. Chỉ hợp đồng + service.
//  ⛔ KHÔNG MyShipTracking. Free-only, và cổng chi phí nằm ở `FreeSourceSelector`.
//  ⛔ KHÔNG quét vùng, KHÔNG crawl hàng loạt: đúng MỘT con tàu mỗi lần gọi.
//  ⛔ KHÔNG sửa `GetCanonicalVesselDetail` — use case đó phải mãi là ĐỌC THUẦN.
// ============================================================================

import { VesselFieldGroup } from "../../../domain/enums/VesselField";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { VesselObservationKey } from "../../../domain/entities/VesselObservation";
import { ICurrentVesselRepository } from "../../contracts/repositories/ICurrentVesselRepository";
import {
  AcquisitionAttempt,
  AcquisitionOutcome,
  AttemptScope,
} from "../../services/acquisition/AcquisitionAttempt";
import { DataNeedType } from "../../services/acquisition/DataNeed";
import { FreeSourceSelector } from "../../services/acquisition/FreeSourceSelector";
import { MissingReason, SufficiencyResult } from "../../services/acquisition/SufficiencyTypes";
import { SourceAttemptPlan } from "../../services/acquisition/SourceSelectionTypes";
import { SourceErrorCategory, SourceRequestError, SourceUnavailableError } from "../../services/crawl-runtime/SourceError";
import { SourceHealthState } from "../../services/crawl-runtime/SourceHealthTracker";
import { DetailRefreshGate } from "../../services/vessel/DetailRefreshGate";
import {
  CanonicalVesselDetail,
  DetailGroup,
} from "../../services/vessel/VesselDetailProjector";
import {
  CollectStatus,
  CollectVesselObservations,
} from "../observation/CollectVesselObservations";
import { ResolveAndStoreCurrentVessel } from "../resolution/ResolveAndStoreCurrentVessel";
import {
  GetCanonicalVesselDetail,
  VesselDetailStatus,
} from "./GetCanonicalVesselDetail";

// ---------------------------------------------------------------------------
//  Chính sách
// ---------------------------------------------------------------------------

export interface DetailRefreshPolicy {
  readonly totalBudgetMs: number;
  readonly maxSources: number;
  readonly minSliceMs: number;
}

export const DEFAULT_DETAIL_REFRESH_POLICY: Readonly<DetailRefreshPolicy> = Object.freeze({
  /**
   * Trần thời gian cho TOÀN BỘ lượt làm mới, không phải cho từng nguồn.
   *
   * 10 giây: ShipInfo/ShipFinder đo được ~1–4 giây mỗi lượt (crawl runtime P4
   * còn cộng thêm nhịp nghỉ chống chặn). Ba nguồn × timeout riêng sẽ thành
   * 30–60 giây treo trên đầu người dùng — không chấp nhận được cho một cú bấm.
   */
  totalBudgetMs: 10_000,
  /**
   * Trần số nguồn được thử trong MỘT lượt.
   *
   * Không gọi cả ba nguồn cho mọi request: mỗi lượt gọi là một request thật lên
   * site người ta, và nguồn thứ ba hiếm khi thêm được gì mà hai nguồn đầu chưa
   * có.
   */
  maxSources: 2,
  /**
   * Còn ít hơn ngần này thì KHÔNG bắt đầu nguồn mới — bắt đầu một request mà
   * biết chắc sẽ bị cắt giữa chừng chỉ tổ tốn một lượt hỏi của nguồn.
   */
  minSliceMs: 1_500,
});

// ---------------------------------------------------------------------------
//  Kết quả
// ---------------------------------------------------------------------------

export const RefreshAttemptStatus = {
  SUCCESS: "SUCCESS",
  /** Nguồn trả dữ liệu nhưng KHÔNG có nhóm đang cần. */
  NO_USEFUL_DATA: "NO_USEFUL_DATA",
  NOT_FOUND: "NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  BLOCKED: "BLOCKED",
  RATE_LIMITED: "RATE_LIMITED",
  ERROR: "ERROR",
  /** Bị chặn bởi cooldown của ứng dụng hoặc của runtime. */
  SKIPPED_COOLDOWN: "SKIPPED_COOLDOWN",
} as const;

export type RefreshAttemptStatus =
  (typeof RefreshAttemptStatus)[keyof typeof RefreshAttemptStatus];

export interface RefreshAttempt {
  readonly source: VesselSource;
  readonly status: RefreshAttemptStatus;
  readonly durationMs: number;
}

export interface GetOrRefreshVesselDetailResult {
  /** `null` chỉ khi canonical vẫn không có gì sau khi đã thử. */
  readonly detail: CanonicalVesselDetail | null;
  readonly status: VesselDetailStatus;
  /**
   * `true` = lượt này ĐÃ CHẠM ít nhất một nguồn ngoài.
   *
   * ⚠️ Nó nói về HÀNH ĐỘNG, không phải kết quả: mọi nguồn hỏng thì `refreshed`
   * vẫn `true` (đã tốn request thật) trong khi `refreshedGroups` rỗng. Muốn
   * biết có lấy thêm được gì không thì đọc `refreshedGroups`.
   */
  readonly refreshed: boolean;
  readonly requestedGroups: readonly DetailGroup[];
  readonly refreshedGroups: readonly DetailGroup[];
  readonly remainingMissingGroups: readonly DetailGroup[];
  readonly remainingStaleGroups: readonly DetailGroup[];
  readonly attempts: readonly RefreshAttempt[];
}

export interface GetOrRefreshVesselDetailInput {
  readonly mmsi?: string;
  readonly imo?: string;
  /**
   * Bỏ qua cooldown của ỨNG DỤNG.
   *
   * ⚠️ KHÔNG bỏ qua được sức khoẻ/cooldown của runtime P4, và không bỏ qua được
   * trần thời gian. Hàng rào chống bị chặn không có công tắc tắt.
   */
  readonly forceRefresh?: boolean;
}

const ALL_GROUPS: readonly DetailGroup[] = Object.freeze([
  DetailGroup.IDENTITY,
  DetailGroup.POSITION,
  DetailGroup.PARTICULARS,
  DetailGroup.VOYAGE,
]);

const GROUP_TO_FIELD_GROUP: Readonly<Record<DetailGroup, VesselFieldGroup>> = Object.freeze({
  [DetailGroup.IDENTITY]: VesselFieldGroup.IDENTITY,
  [DetailGroup.POSITION]: VesselFieldGroup.POSITION,
  [DetailGroup.PARTICULARS]: VesselFieldGroup.PARTICULARS,
  [DetailGroup.VOYAGE]: VesselFieldGroup.VOYAGE,
});

export interface GetOrRefreshVesselDetailDeps {
  read: GetCanonicalVesselDetail;
  selector: FreeSourceSelector;
  collect: CollectVesselObservations;
  resolveAndStore: ResolveAndStoreCurrentVessel;
  gate: DetailRefreshGate;
  /** ĐỌC sức khoẻ nguồn, không sở hữu nó — cùng quy ước với `FreeSourceSelector`. */
  healthOf: (source: VesselSource) => SourceHealthState;
  /** Chỉ dùng để kiểm tra tàu có tồn tại sau khi acquire; không ghi. */
  currentVessels?: ICurrentVesselRepository;
  policy?: DetailRefreshPolicy;
  now?: () => Date;
  logger?: { info(message: string): void };
}

export class GetOrRefreshVesselDetail {
  private readonly deps: GetOrRefreshVesselDetailDeps;
  private readonly policy: DetailRefreshPolicy;
  private readonly now: () => Date;

  constructor(deps: GetOrRefreshVesselDetailDeps) {
    this.deps = deps;
    this.policy = deps.policy ?? DEFAULT_DETAIL_REFRESH_POLICY;
    this.now = deps.now ?? (() => new Date());
  }

  async execute(
    input: GetOrRefreshVesselDetailInput
  ): Promise<GetOrRefreshVesselDetailResult> {
    // BƯỚC 1 — ĐỌC TRƯỚC, luôn luôn. Định danh rác bị `read` ném ra ở đây, nên
    // không lượt crawl nào xuất phát từ một MMSI sai định dạng.
    const first = await this.deps.read.execute({ mmsi: input.mmsi, imo: input.imo });

    const force = input.forceRefresh === true;
    if (first.status === VesselDetailStatus.FOUND && !first.detail.needsRefresh && !force) {
      // Đủ và tươi -> KHÔNG chạm nguồn ngoài. Đây là đường đi thường gặp nhất
      // khi người dùng bấm vào một chấm trên map.
      return GetOrRefreshVesselDetail.settled(first.detail, [], [], []);
    }

    const requestedGroups =
      first.status === VesselDetailStatus.FOUND
        ? force
          ? ALL_GROUPS
          : first.detail.refreshGroups
        : ALL_GROUPS;

    const vesselKey: VesselObservationKey = {
      mmsi: input.mmsi?.trim() === "" ? undefined : input.mmsi?.trim(),
      imo: input.imo?.trim() === "" ? undefined : input.imo?.trim(),
    };
    const gateKey = `${vesselKey.mmsi ?? ""}/${vesselKey.imo ?? ""}`;

    const { allowed, suppressed } = this.deps.gate.filterAllowed(
      gateKey,
      requestedGroups,
      force
    );
    if (allowed.length === 0) {
      // Vừa hỏi xong -> trả thứ đang có. Bấm 20 lần không thành 20 lượt crawl.
      // `suppressed` chỉ để đọc hiểu; không có `attempt` nào vì không nguồn nào
      // được chạm tới.
      void suppressed;
      return GetOrRefreshVesselDetail.settled(first.detail, requestedGroups, [], []);
    }

    // BƯỚC 2 — gộp mọi lời gọi đồng thời cho cùng con tàu về MỘT lượt.
    return this.deps.gate.runSingleFlight(gateKey, () =>
      this.refresh(vesselKey, gateKey, requestedGroups, allowed, first.detail)
    );
  }

  private async refresh(
    vesselKey: VesselObservationKey,
    gateKey: string,
    requestedGroups: readonly DetailGroup[],
    allowedGroups: readonly DetailGroup[],
    before: CanonicalVesselDetail | null
  ): Promise<GetOrRefreshVesselDetailResult> {
    const startedAt = this.now().getTime();
    const deadline = startedAt + this.policy.totalBudgetMs;

    const attempts: RefreshAttempt[] = [];
    const history: AcquisitionAttempt[] = [];
    let outstanding = [...allowedGroups];
    let detail = before;
    let anySaved = false;

    for (let round = 0; round < this.policy.maxSources; round += 1) {
      const remainingMs = deadline - this.now().getTime();
      // §21: ngân sách là của CẢ LƯỢT. Không đủ chỗ cho một nguồn nữa thì dừng,
      // đừng mở một request mà biết chắc sẽ bị cắt.
      if (remainingMs < this.policy.minSliceMs) break;
      if (outstanding.length === 0) break;

      const plan = this.deps.selector.select({
        key: vesselKey,
        need: { type: DataNeedType.FULL },
        // Dùng lại NGUYÊN bộ chọn nguồn của P9: cổng chi phí (loại PAID và
        // EXISTING_STREAM), cổng capability, cổng định danh, cổng sức khoẻ,
        // cổng "đã thử rồi". Không dựng bảng ưu tiên thứ hai ở đây.
        sufficiency: GetOrRefreshVesselDetail.sufficiencyFor(outstanding),
        healthOf: this.deps.healthOf,
        attempts: history,
        now: this.now(),
      }).next;

      if (plan === null) break;

      const attemptStartedAt = this.now().getTime();
      const outcome = await this.trySource(plan.source, plan, remainingMs);
      attempts.push({
        source: plan.source,
        status: outcome.status,
        durationMs: this.now().getTime() - attemptStartedAt,
      });
      history.push({
        source: plan.source,
        operation: plan.operation,
        vesselKey,
        attemptedAt: this.now(),
        // Đã thử trong CHÍNH lượt này -> selector chặn vô điều kiện, không TTL.
        scope: AttemptScope.CURRENT_REQUEST,
        outcome: GetOrRefreshVesselDetail.toAcquisitionOutcome(outcome.status),
        targetFields: plan.targetFields,
      });

      // Nguồn chưa có provider / không hỗ trợ operation KHÔNG tốn request nào,
      // nên nó không được ăn một suất trong trần `maxSources`. Trần đó tồn tại
      // để giới hạn số lần ĐÁNH RA NGOÀI, không phải số vòng lặp.
      if (outcome.status === RefreshAttemptStatus.NO_USEFUL_DATA && !outcome.touchedNetwork) {
        round -= 1;
      }

      if (outcome.status !== RefreshAttemptStatus.SUCCESS) continue;
      anySaved = true;

      // BƯỚC 3 — observation đã ghi -> phân xử lại -> ĐỌC LẠI để biết còn thiếu gì.
      await this.deps.resolveAndStore.execute(vesselKey);
      const reread = await this.deps.read.execute({
        mmsi: vesselKey.mmsi,
        imo: vesselKey.imo,
      });
      detail = reread.detail;

      // §14 — dừng SỚM khi đã đủ. Nguồn còn lại không thêm được gì cho nhóm
      // đang cần, mà vẫn tốn một request thật.
      const stillMissing = new Set(reread.detail?.refreshGroups ?? []);
      outstanding = outstanding.filter((group) => stillMissing.has(group));
    }

    this.deps.gate.recordAttempt(gateKey, allowedGroups, anySaved);

    const refreshedGroups = allowedGroups.filter((group) => !outstanding.includes(group));
    this.deps.logger?.info(
      `[detail-refresh] ${gateKey} cần=${requestedGroups.join(",")} ` +
        `nguồn=${attempts.map((a) => `${a.source}:${a.status}`).join(",") || "—"} ` +
        `lấy được=${refreshedGroups.join(",") || "—"} ` +
        `${this.now().getTime() - startedAt}ms`
    );

    return {
      ...GetOrRefreshVesselDetail.settled(detail, requestedGroups, refreshedGroups, attempts),
      refreshed: attempts.length > 0,
    };
  }

  /**
   * Một nguồn hỏng KHÔNG được làm chết cả request.
   *
   * Mọi lỗi được phân loại rồi trả về như một `attempt`; vòng lặp đi tiếp sang
   * nguồn sau nếu chính sách còn cho phép.
   */
  private async trySource(
    source: VesselSource,
    plan: SourceAttemptPlan,
    remainingMs: number
  ): Promise<{ status: RefreshAttemptStatus; touchedNetwork: boolean }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      // Chặn cứng theo ngân sách CÒN LẠI. Request phía dưới vẫn chạy nốt (chưa
      // có đường huỷ tới tận HTTP client), nhưng người gọi không bị giữ thêm.
      const budget = new Promise<{ status: RefreshAttemptStatus; touchedNetwork: boolean }>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: RefreshAttemptStatus.TIMEOUT, touchedNetwork: true }),
          remainingMs
        );
        timer.unref?.();
      });

      const work = this.deps.collect
        .execute({ source, identifier: plan.identifier, operation: plan.operation })
        .then((result) => {
          if (result.status === CollectStatus.NOT_FOUND) {
            return { status: RefreshAttemptStatus.NOT_FOUND, touchedNetwork: true };
          }
          if (
            result.status === CollectStatus.NO_PROVIDER ||
            result.status === CollectStatus.UNSUPPORTED_OPERATION
          ) {
            // Chưa ra khỏi tiến trình -> không tính là một lần đánh ra ngoài.
            return { status: RefreshAttemptStatus.NO_USEFUL_DATA, touchedNetwork: false };
          }
          // Ghi được nhưng toàn bản trùng -> không có gì mới để phân xử.
          return result.observations.length === 0
            ? { status: RefreshAttemptStatus.NO_USEFUL_DATA, touchedNetwork: true }
            : { status: RefreshAttemptStatus.SUCCESS, touchedNetwork: true };
        });

      return await Promise.race([work, budget]);
    } catch (error) {
      return { status: GetOrRefreshVesselDetail.classify(error), touchedNetwork: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Dùng lại phân loại lỗi của runtime P4 — không đoán lại từ chuỗi thông báo. */
  private static classify(error: unknown): RefreshAttemptStatus {
    if (error instanceof SourceUnavailableError) return RefreshAttemptStatus.SKIPPED_COOLDOWN;
    if (error instanceof SourceRequestError) {
      switch (error.category) {
        case SourceErrorCategory.NOT_FOUND:
          return RefreshAttemptStatus.NOT_FOUND;
        case SourceErrorCategory.TIMEOUT:
          return RefreshAttemptStatus.TIMEOUT;
        case SourceErrorCategory.BLOCKED:
          return RefreshAttemptStatus.BLOCKED;
        case SourceErrorCategory.RATE_LIMITED:
          return RefreshAttemptStatus.RATE_LIMITED;
        default:
          return RefreshAttemptStatus.ERROR;
      }
    }
    return RefreshAttemptStatus.ERROR;
  }

  /**
   * ⚠️ `NOT_FOUND` map sang `AcquisitionOutcome.NOT_FOUND`, KHÔNG phải `FAILED`:
   * nguồn trả lời rõ ràng "không có tàu này" là nguồn ĐANG KHOẺ (P4 §18).
   */
  private static toAcquisitionOutcome(status: RefreshAttemptStatus): AcquisitionOutcome {
    if (status === RefreshAttemptStatus.SUCCESS) return AcquisitionOutcome.SUCCESS;
    if (status === RefreshAttemptStatus.NOT_FOUND) return AcquisitionOutcome.NOT_FOUND;
    return AcquisitionOutcome.FAILED;
  }

  /**
   * Nhóm đang thiếu -> `SufficiencyResult` mà `FreeSourceSelector` hiểu.
   *
   * Đây là cả cầu nối giữa DETAIL-1 (`refreshGroups`) và P9 (`AcquisitionRequirement`)
   * — mười dòng, không phải một tầng abstraction mới.
   */
  private static sufficiencyFor(groups: readonly DetailGroup[]): SufficiencyResult {
    return {
      satisfied: false,
      need: { type: DataNeedType.FULL },
      missing: groups.map((group) => ({
        group: GROUP_TO_FIELD_GROUP[group],
        reason: MissingReason.MISSING_GROUP,
      })),
    };
  }

  private static settled(
    detail: CanonicalVesselDetail | null,
    requestedGroups: readonly DetailGroup[],
    refreshedGroups: readonly DetailGroup[],
    attempts: readonly RefreshAttempt[]
  ): GetOrRefreshVesselDetailResult {
    return {
      detail,
      status: detail === null ? VesselDetailStatus.NOT_FOUND : VesselDetailStatus.FOUND,
      refreshed: attempts.length > 0,
      requestedGroups: Object.freeze([...requestedGroups]),
      refreshedGroups: Object.freeze([...refreshedGroups]),
      remainingMissingGroups: detail?.missingGroups ?? ALL_GROUPS,
      remainingStaleGroups: detail?.staleGroups ?? [],
      attempts: Object.freeze([...attempts]),
    };
  }
}
