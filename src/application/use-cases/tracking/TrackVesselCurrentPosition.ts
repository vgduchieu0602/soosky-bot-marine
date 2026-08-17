// ============================================================================
//  APPLICATION · USE CASE: TrackVesselCurrentPosition — LÀN TRẢ TIỀN, TƯỜNG MINH
// ----------------------------------------------------------------------------
//      identifier
//        -> validator P1
//        -> PaidFallbackGate (intent = EXPLICIT_TRACKING)
//        -> single-flight theo tàu        ← 10 người bấm ≠ 10 credit
//        -> MyShipTracking /api/v2/vessel  (response=simple, 1 credit, MỘT lần)
//        -> ProviderResultToObservation
//        -> ObservationRecorder
//        -> ResolveAndStoreCurrentVessel
//        -> đọc canonical
//
//  🔴 LUẬT SỐNG CÒN: file này KHÔNG được gọi từ bất kỳ đường free nào.
//     Không `GetOrRefreshVesselDetail`, không `FreeSourceSelector`, không map,
//     không "canonical miss thì gọi tạm". Muốn tiêu tiền thì phải gọi ĐÍCH DANH
//     use case này. Có test hồi quy khoá vĩnh viễn điều đó.
//
//  ⛔ Chỉ vị trí hiện tại. Không bulk, không history, không scheduler.
// ============================================================================

import { VesselObservationKey } from "../../../domain/entities/VesselObservation";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { isValidImo, isValidMmsi } from "../../../domain/validators/identifiers";
import { ProviderDetailsResult } from "../../contracts/providers/ProviderResults";
import { IVesselObservationRepository } from "../../contracts/repositories/IVesselObservationRepository";
import { PaidBudgetSnapshot } from "../../services/acquisition/PaidFallbackPolicy";
import {
  FreeAcquisitionOutcome,
  PaidFallbackGate,
  PaidGateDecision,
  PaidGateReason,
  PaidIntent,
} from "../../services/acquisition/PaidFallbackGate";
import { DataNeedType } from "../../services/acquisition/DataNeed";
import { MissingReason } from "../../services/acquisition/SufficiencyTypes";
import { detailsResultToObservations } from "../../services/observation/providerResultToObservation";
import { VesselFieldGroup } from "../../../domain/enums/VesselField";
import { ResolveAndStoreCurrentVessel } from "../resolution/ResolveAndStoreCurrentVessel";

export const PaidTrackingStatus = {
  /** Có dữ liệu, observation đã ghi, canonical đã phân xử lại. */
  UPDATED: "UPDATED",
  /** Nguồn trả dữ liệu nhưng không dựng được nhóm canonical nào dùng được. */
  NO_USEFUL_DATA: "NO_USEFUL_DATA",
  /** AIS bờ chưa thấy tàu này. KHÔNG có nghĩa tàu không tồn tại. */
  NOT_FOUND: "NOT_FOUND",
  /** Hết credit. Không retry, không coi là nguồn hỏng. */
  NO_CREDITS: "NO_CREDITS",
  /** Cổng trả tiền từ chối — chưa gửi request nào. */
  DENIED: "DENIED",
  /** Lỗi kỹ thuật (timeout / 5xx / mạng / key sai). */
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type PaidTrackingStatus = (typeof PaidTrackingStatus)[keyof typeof PaidTrackingStatus];

export interface TrackVesselCurrentPositionResult {
  readonly status: PaidTrackingStatus;
  readonly source: typeof VesselSource.MYSHIPTRACKING;
  /** Lý do bị chặn — chỉ khi `DENIED`. */
  readonly deniedReason?: PaidGateReason;
  /** Mốc NGUỒN khai của vị trí vừa lấy. */
  readonly sourceReceivedAt?: Date;
  /** Chi phí CÔNG BỐ của `response=simple`. Luôn là 1. */
  readonly expectedCreditCost: number;
  /** Từ header `X-Credit-Charged`. Vắng mặt -> `undefined`, KHÔNG suy ra. */
  readonly actualCreditCharged?: number;
  /** Số observation MỚI được ghi. */
  readonly observationsSaved: number;
  /** Lượt này có thực sự gửi request trả tiền không. */
  readonly requestSent: boolean;
}

/** Đúng phần client mà use case cần — giữ application không biết `fetch`. */
export interface PaidPositionSource {
  fetchCurrentPosition(query: { mmsi?: string; imo?: string }): Promise<PaidPositionFetchResult>;
  /** DTO thô -> canonical. Tách khỏi fetch để test map riêng khỏi mạng. */
  toProviderResult(data: unknown, fetchedAt: Date): ProviderDetailsResult;
}

export type PaidPositionFetchResult =
  | { readonly ok: true; readonly data: unknown; readonly creditCharged?: number }
  | { readonly ok: false; readonly failure: string; readonly creditCharged?: number };

export class InvalidTrackingIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTrackingIdentifierError";
  }
}

export interface TrackVesselCurrentPositionInput {
  readonly mmsi?: string;
  readonly imo?: string;
}

export interface TrackVesselCurrentPositionDeps {
  source: PaidPositionSource;
  gate: PaidFallbackGate;
  observations: IVesselObservationRepository;
  resolveAndStore: ResolveAndStoreCurrentVessel;
  /**
   * Hạn mức còn lại. `remainingCalls: null` nghĩa là KHÔNG BIẾT, và cổng coi
   * đó là TỪ CHỐI — MyShipTracking không công bố giá nên "chắc là còn" là một
   * canh bạc bằng tiền thật.
   */
  budget: () => PaidBudgetSnapshot;
  now?: () => Date;
  logger?: { info(message: string): void };
}

const EXPECTED_CREDIT_COST = 1;

/** Chi phí thật -> trạng thái. Giữ ở một chỗ để hai đường không lệch nhau. */
const FAILURE_TO_STATUS: Readonly<Record<string, PaidTrackingStatus>> = Object.freeze({
  NOT_FOUND: PaidTrackingStatus.NOT_FOUND,
  NO_CREDITS: PaidTrackingStatus.NO_CREDITS,
});

export class TrackVesselCurrentPosition {
  private readonly deps: TrackVesselCurrentPositionDeps;
  private readonly now: () => Date;
  /**
   * Single-flight theo TÀU — bắt buộc, vì mỗi lượt là tiền thật. 10 người bấm
   * cùng lúc phải thành ĐÚNG MỘT credit, không phải mười.
   */
  private readonly inFlight = new Map<string, Promise<TrackVesselCurrentPositionResult>>();

  private stats = {
    requests: 0,
    singleFlightJoins: 0,
    success: 0,
    notFound: 0,
    noCredits: 0,
    rateLimited: 0,
    denied: 0,
    errors: 0,
    creditsChargedKnown: 0,
  };

  constructor(deps: TrackVesselCurrentPositionDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  getStats(): Readonly<typeof this.stats> & { inFlight: number } {
    return { ...this.stats, inFlight: this.inFlight.size };
  }

  /**
   * @throws InvalidTrackingIdentifierError khi định danh thiếu/sai — không lượt
   *         trả tiền nào được xuất phát từ một MMSI sai định dạng.
   */
  async execute(
    input: TrackVesselCurrentPositionInput
  ): Promise<TrackVesselCurrentPositionResult> {
    const key = TrackVesselCurrentPosition.validate(input);
    const flightKey = `${key.mmsi ?? ""}/${key.imo ?? ""}`;

    const running = this.inFlight.get(flightKey);
    if (running !== undefined) {
      this.stats.singleFlightJoins += 1;
      return running;
    }

    // `finally` nhả khoá: hỏng cũng phải nhả, nếu không con tàu đó bị khoá
    // vĩnh viễn khỏi làn trả tiền.
    const promise = this.run(key).finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, promise);
    return promise;
  }

  private async run(key: VesselObservationKey): Promise<TrackVesselCurrentPositionResult> {
    const startedAt = this.now();

    // ---- Cổng trả tiền -----------------------------------------------------
    // Ý định TƯỜNG MINH: cổng 2 (local đã đủ) và 3 (free chưa cạn) không áp
    // dụng — người dùng trả tiền để lấy vị trí trả tiền. Mọi cổng còn lại giữ
    // nguyên, đặc biệt là ngân sách và chống gọi lặp.
    const decision = this.deps.gate.evaluate({
      intent: PaidIntent.EXPLICIT_TRACKING,
      key,
      need: { type: DataNeedType.POSITION },
      sufficiency: {
        satisfied: false,
        need: { type: DataNeedType.POSITION },
        missing: [{ group: VesselFieldGroup.POSITION, reason: MissingReason.MISSING_GROUP }],
      },
      freeOutcome: FreeAcquisitionOutcome.NO_FREE_SOURCE_AVAILABLE,
      allowPaidFallback: true,
      budget: this.deps.budget(),
      now: startedAt,
    });

    if (decision.decision !== PaidGateDecision.ALLOW) {
      this.stats.denied += 1;
      return {
        status: PaidTrackingStatus.DENIED,
        source: VesselSource.MYSHIPTRACKING,
        deniedReason: decision.reason,
        expectedCreditCost: EXPECTED_CREDIT_COST,
        observationsSaved: 0,
        requestSent: false,
      };
    }

    // ---- ĐÚNG MỘT request --------------------------------------------------
    // Không có đường "MMSI trượt thì thử IMO": đó là hai credit cho một cú bấm.
    this.stats.requests += 1;
    const fetched = await this.deps.source.fetchCurrentPosition({
      mmsi: key.mmsi,
      imo: key.imo,
    });
    if (fetched.creditCharged !== undefined) this.stats.creditsChargedKnown += 1;

    const base = {
      source: VesselSource.MYSHIPTRACKING,
      expectedCreditCost: EXPECTED_CREDIT_COST,
      ...(fetched.creditCharged === undefined ? {} : { actualCreditCharged: fetched.creditCharged }),
      requestSent: true,
    } as const;

    if (!fetched.ok) {
      const status = FAILURE_TO_STATUS[fetched.failure] ?? PaidTrackingStatus.UNAVAILABLE;
      if (status === PaidTrackingStatus.NOT_FOUND) this.stats.notFound += 1;
      else if (status === PaidTrackingStatus.NO_CREDITS) this.stats.noCredits += 1;
      else if (fetched.failure === "RATE_LIMITED") this.stats.rateLimited += 1;
      else this.stats.errors += 1;

      this.log(key, status, startedAt, undefined, fetched.creditCharged);
      return { ...base, status, observationsSaved: 0 };
    }

    // ---- Nguồn -> observation -> resolver ----------------------------------
    // ⛔ TUYỆT ĐỐI không ghi thẳng canonical từ provider: mất xuất xứ, và mất
    //    luôn khả năng để resolver quyết định dữ liệu nào mới hơn.
    const result = this.deps.source.toProviderResult(fetched.data, startedAt);
    const observations = detailsResultToObservations(result, {
      parserVersion: "myshiptracking-v2-simple",
      now: startedAt,
    });

    if (observations.length === 0) {
      this.stats.errors += 1;
      this.log(key, PaidTrackingStatus.NO_USEFUL_DATA, startedAt, undefined, fetched.creditCharged);
      return { ...base, status: PaidTrackingStatus.NO_USEFUL_DATA, observationsSaved: 0 };
    }

    const saved = await this.deps.observations.saveMany(observations);
    const savedCount = saved.filter((entry) => entry.status === "SAVED").length;

    // Phân xử lại. ⚠️ Resolver KHÔNG biết bản ghi này tốn tiền, và không được
    // biết: nếu AIS có vị trí mới hơn thì AIS vẫn thắng. Trả tiền không mua
    // được quyền ghi đè dữ liệu mới hơn.
    await this.deps.resolveAndStore.execute(key);

    const sourceReceivedAt = result.position?.receivedAt;
    this.stats.success += 1;
    this.log(key, PaidTrackingStatus.UPDATED, startedAt, sourceReceivedAt, fetched.creditCharged);

    return {
      ...base,
      status: PaidTrackingStatus.UPDATED,
      ...(sourceReceivedAt === undefined ? {} : { sourceReceivedAt }),
      observationsSaved: savedCount,
    };
  }

  /** MỘT dòng mỗi lượt. ⛔ Không bao giờ có API key hay header Authorization. */
  private log(
    key: VesselObservationKey,
    status: PaidTrackingStatus,
    startedAt: Date,
    sourceReceivedAt: Date | undefined,
    creditCharged: number | undefined
  ): void {
    this.deps.logger?.info(
      `[paid-tracking] ${key.mmsi ?? key.imo} ${status} ` +
        `${this.now().getTime() - startedAt.getTime()}ms ` +
        `credit=${creditCharged ?? "?"} ` +
        `sourceReceivedAt=${sourceReceivedAt?.toISOString() ?? "—"}`
    );
  }

  private static validate(input: TrackVesselCurrentPositionInput): VesselObservationKey {
    const mmsi = input.mmsi?.trim();
    const imo = input.imo?.trim();

    if ((mmsi === undefined || mmsi === "") && (imo === undefined || imo === "")) {
      throw new InvalidTrackingIdentifierError("Cần ít nhất một trong MMSI hoặc IMO");
    }
    if (mmsi !== undefined && mmsi !== "" && !isValidMmsi(mmsi)) {
      throw new InvalidTrackingIdentifierError(`MMSI không hợp lệ: "${mmsi}"`);
    }
    if (imo !== undefined && imo !== "" && !isValidImo(imo)) {
      throw new InvalidTrackingIdentifierError(`IMO không hợp lệ: "${imo}"`);
    }

    // Ưu tiên MMSI khi có cả hai: API đòi ĐÚNG MỘT định danh, và MMSI là khoá
    // mà map trao cho người dùng.
    return mmsi !== undefined && mmsi !== "" ? { mmsi } : { imo };
  }
}
