// ============================================================================
//  APPLICATION · USE CASE: CollectVesselObservations
//  → Nối P3 (provider) + P4 (runtime) + P5 (observation) thành MỘT đường chạy.
// ----------------------------------------------------------------------------
//      identifier -> registry.get(source) -> runtime.execute(provider.getX)
//                 -> ProviderResult -> ObservationRecorder -> repository
//
//  Use case này KHÔNG biết ShipInfo là gì. Nó nhận `source`, tra provider trong
//  registry, chạy qua executor của đúng nguồn đó. Thêm nguồn mới sau này không
//  phải sửa file này.
//
//  KHÔNG có ở đây (và không được thêm vào): retry, sleep, rate limit, cooldown
//  (đã ở P4) · merge, chọn nguồn, fallback, chấm điểm (thuộc resolver, CHƯA CÓ)
//  · ghi thẳng repository (phải qua recorder để chạy validation + dedupe).
//
//  NOT_FOUND đi bằng đường riêng: provider trả `null` -> ta ném một lỗi đã phân
//  loại NOT_FOUND để `SourceHealthTracker` đếm vào `notFoundCount` mà KHÔNG tăng
//  chuỗi hỏng. Tra 500 mmsi lạ không được phép khoá một nguồn đang khoẻ.
// ============================================================================

import {
  ObservationSaveResult,
} from "../../contracts/repositories/IVesselObservationRepository";
import { ObservationRecorder } from "../../services/observation/ObservationRecorder";
import { ProviderRegistry } from "../../services/acquisition/ProviderRegistry";
import {
  ProviderDetailsResult,
  ProviderPositionResult,
} from "../../contracts/providers/ProviderResults";
import {
  ProviderOperation,
  VesselDataProvider,
  providerSupportsOperation,
} from "../../contracts/providers/VesselDataProvider";
import {
  SourceErrorCategory,
  SourceRequestError,
  notFoundError,
} from "../../services/crawl-runtime/SourceError";
import { SourceHealthSnapshot } from "../../services/crawl-runtime/SourceHealthTracker";
import { SourceRuntimeManager } from "../../services/crawl-runtime/SourceRuntimeManager";
import {
  VesselIdentifier,
  formatVesselIdentifier,
} from "../../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../../domain/enums/VesselSource";

export const CollectStatus = {
  /** Nguồn có tàu; observation đã đi qua validation + dedupe. */
  RECORDED: "RECORDED",
  /** Nguồn trả lời rõ ràng là không có tàu này. Không phải lỗi. */
  NOT_FOUND: "NOT_FOUND",
  /** Chưa có provider implementation cho nguồn này. */
  NO_PROVIDER: "NO_PROVIDER",
  /** Provider có nhưng không implement operation được yêu cầu. */
  UNSUPPORTED_OPERATION: "UNSUPPORTED_OPERATION",
} as const;

export type CollectStatus = (typeof CollectStatus)[keyof typeof CollectStatus];

/** Chỉ hai operation tra theo định danh. Tìm theo tên/quét vùng không thuộc đây. */
export type CollectOperation =
  | typeof ProviderOperation.GET_DETAILS
  | typeof ProviderOperation.GET_POSITION;

export interface CollectVesselObservationsParams {
  source: VesselSource;
  identifier: VesselIdentifier;
  /** Mặc định GET_DETAILS — một request cho ra nhiều nhóm canonical nhất. */
  operation?: CollectOperation;
  /** Response thô để debug parser; giữ hay không do RawPayloadPolicy quyết định. */
  rawPayload?: unknown;
}

export interface CollectVesselObservationsResult {
  status: CollectStatus;
  source: VesselSource;
  operation: CollectOperation;
  observations: readonly ObservationSaveResult[];
  /** Ảnh sức khoẻ nguồn SAU lần chạy này. undefined khi chưa chạm runtime. */
  health?: SourceHealthSnapshot;
}

export interface CollectVesselObservationsDeps {
  registry: ProviderRegistry;
  runtime: SourceRuntimeManager;
  recorder: ObservationRecorder;
  /** VD { shipinfo: "shipinfo-embedded-json-v1" } — nguồn đổi form thì bump. */
  parserVersionBySource?: Partial<Record<VesselSource, string>>;
}

const NO_OBSERVATIONS: readonly ObservationSaveResult[] = Object.freeze([]);

export class CollectVesselObservations {
  constructor(private readonly deps: CollectVesselObservationsDeps) {}

  /**
   * @throws SourceRequestError cho mọi lỗi KHÁC not-found (PARSE_ERROR,
   *         BLOCKED, RATE_LIMITED, TIMEOUT...) — đã phân loại sẵn bởi P4.
   * @throws SourceUnavailableError khi nguồn đang cooldown / bị tắt.
   */
  async execute(
    params: CollectVesselObservationsParams
  ): Promise<CollectVesselObservationsResult> {
    const { source, identifier } = params;
    const operation = params.operation ?? ProviderOperation.GET_DETAILS;

    const provider = this.deps.registry.get(source);
    if (provider === undefined) {
      return { status: CollectStatus.NO_PROVIDER, source, operation, observations: NO_OBSERVATIONS };
    }
    if (!providerSupportsOperation(provider, operation)) {
      return {
        status: CollectStatus.UNSUPPORTED_OPERATION,
        source,
        operation,
        observations: NO_OBSERVATIONS,
      };
    }

    const executor = this.deps.runtime.getExecutor(source);
    const label = formatVesselIdentifier(identifier);

    try {
      // Toàn bộ phần chạm mạng nằm TRONG executor: cooldown gate, hàng đợi,
      // nhịp nghỉ, timeout, phân loại lỗi, retry, cập nhật health.
      const result = await executor.execute(
        async () => {
          const value = await this.callProvider(provider, operation, identifier);
          if (value === null) {
            throw notFoundError(source, `${source} không có tàu ${label}`);
          }
          return value;
        },
        { operation }
      );

      const observations = await this.record(source, operation, result, params.rawPayload);
      return {
        status: CollectStatus.RECORDED,
        source,
        operation,
        observations,
        health: executor.getHealth(),
      };
    } catch (err) {
      // NOT_FOUND là câu trả lời hợp lệ của một nguồn khoẻ mạnh, không phải sự cố.
      if (
        err instanceof SourceRequestError &&
        err.category === SourceErrorCategory.NOT_FOUND
      ) {
        return {
          status: CollectStatus.NOT_FOUND,
          source,
          operation,
          observations: NO_OBSERVATIONS,
          health: executor.getHealth(),
        };
      }
      throw err;
    }
  }

  private callProvider(
    provider: VesselDataProvider,
    operation: CollectOperation,
    identifier: VesselIdentifier
  ): Promise<ProviderDetailsResult | ProviderPositionResult | null> {
    if (operation === ProviderOperation.GET_POSITION) {
      // `providerSupportsOperation` đã kiểm; dấu `!` chỉ để TypeScript yên tâm.
      return provider.getPosition!(identifier);
    }
    return provider.getDetails!(identifier);
  }

  private record(
    source: VesselSource,
    operation: CollectOperation,
    result: ProviderDetailsResult | ProviderPositionResult,
    rawPayload: unknown
  ): Promise<readonly ObservationSaveResult[]> {
    const options = {
      parserVersion: this.deps.parserVersionBySource?.[source],
      rawPayload,
    };
    return operation === ProviderOperation.GET_POSITION
      ? this.deps.recorder.recordPosition(result as ProviderPositionResult, options)
      : this.deps.recorder.recordDetails(result as ProviderDetailsResult, options);
  }
}
