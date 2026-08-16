// ============================================================================
//  APPLICATION · ObservationRecorder — cửa DUY NHẤT để ghi observation
// ----------------------------------------------------------------------------
//  ProviderResult -> observation -> raw payload policy -> repository.saveMany().
//
//  Provider KHÔNG được gọi thẳng repository: parser HTML mà biết tới MongoDB là
//  đúng thứ kiến trúc này tồn tại để ngăn.
//
//  Recorder KHÔNG: phân xử nguồn, chọn nguồn, gọi mạng, retry, giới hạn tốc độ,
//  đụng `latestpositions`, đụng `vessels`. Nó chỉ ghi lại lời khai.
// ============================================================================

import { VesselSourceObservation } from "../../../domain/entities/VesselObservation";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import {
  ProviderDetailsResult,
  ProviderPositionResult,
  ProviderSearchResult,
} from "../../contracts/providers/ProviderResults";
import {
  IVesselObservationRepository,
  ObservationSaveResult,
} from "../../contracts/repositories/IVesselObservationRepository";
import {
  DEFAULT_MAX_RAW_PAYLOAD_BYTES,
  DEFAULT_RAW_PAYLOAD_POLICY,
  RawPayloadPolicy,
  prepareRawPayload,
  shouldKeepRawPayload,
} from "./ObservationPolicy";
import {
  ObservationMappingContext,
  detailsResultToObservations,
  positionResultToObservations,
  searchResultToObservations,
} from "./providerResultToObservation";

export interface ObservationRecorderDeps {
  repository: IVesselObservationRepository;
  rawPayloadPolicy?: RawPayloadPolicy;
  maxRawPayloadBytes?: number;
  /** Mặc định cho mọi lần ghi; từng lần vẫn override được. */
  parserVersion?: string;
  now?: () => Date;
}

export interface RecordOptions {
  parserVersion?: string;
  /** Response thô của nguồn. Giữ hay không do RawPayloadPolicy quyết định. */
  rawPayload?: unknown;
}

export class ObservationRecorder {
  private readonly repository: IVesselObservationRepository;
  private readonly rawPayloadPolicy: RawPayloadPolicy;
  private readonly maxRawPayloadBytes: number;
  private readonly defaultParserVersion?: string;
  private readonly now: () => Date;

  constructor(deps: ObservationRecorderDeps) {
    this.repository = deps.repository;
    this.rawPayloadPolicy = deps.rawPayloadPolicy ?? DEFAULT_RAW_PAYLOAD_POLICY;
    this.maxRawPayloadBytes = deps.maxRawPayloadBytes ?? DEFAULT_MAX_RAW_PAYLOAD_BYTES;
    this.defaultParserVersion = deps.parserVersion;
    this.now = deps.now ?? (() => new Date());
  }

  async recordDetails(
    result: ProviderDetailsResult,
    options: RecordOptions = {}
  ): Promise<readonly ObservationSaveResult[]> {
    return this.record(detailsResultToObservations(result, this.context(options)), options);
  }

  async recordPosition(
    result: ProviderPositionResult,
    options: RecordOptions = {}
  ): Promise<readonly ObservationSaveResult[]> {
    return this.record(positionResultToObservations(result, this.context(options)), options);
  }

  /** Cả một mẻ quét vùng. Một lần `saveMany` cho toàn bộ. */
  async recordPositions(
    results: readonly ProviderPositionResult[],
    options: RecordOptions = {}
  ): Promise<readonly ObservationSaveResult[]> {
    const context = this.context(options);
    const observations = results.flatMap((result) => [
      ...positionResultToObservations(result, context),
    ]);
    return this.record(observations, options);
  }

  async recordSearch(
    result: ProviderSearchResult,
    options: RecordOptions = {}
  ): Promise<readonly ObservationSaveResult[]> {
    return this.record(searchResultToObservations(result, this.context(options)), options);
  }

  /** Áp raw payload policy rồi ghi. Danh sách rỗng -> không chạm repository. */
  async record(
    observations: readonly VesselSourceObservation[],
    options: RecordOptions = {}
  ): Promise<readonly ObservationSaveResult[]> {
    if (observations.length === 0) return Object.freeze([]);
    const withPayload = observations.map((observation) =>
      this.applyRawPayloadPolicy(observation, options.rawPayload)
    );
    return this.repository.saveMany(withPayload);
  }

  private context(options: RecordOptions): ObservationMappingContext {
    return {
      parserVersion: options.parserVersion ?? this.defaultParserVersion,
      now: this.now(),
    };
  }

  /**
   * ON_ERROR (mặc định): bản ghi sạch không kèm payload; PARTIAL/INVALID thì
   * kèm — đó là bằng chứng duy nhất để biết nguồn đã đổi form hay parser sai.
   */
  private applyRawPayloadPolicy(
    observation: VesselSourceObservation,
    rawPayload: unknown
  ): VesselSourceObservation {
    if (rawPayload === undefined || rawPayload === null) return observation;

    const fullyValid = observation.validation.status === ObservationValidationStatus.VALID;
    if (!shouldKeepRawPayload(this.rawPayloadPolicy, fullyValid)) return observation;

    const prepared = prepareRawPayload(rawPayload, this.maxRawPayloadBytes);
    if (prepared.payload === undefined) return observation;

    return {
      ...observation,
      rawPayload: prepared.payload,
      rawPayloadTruncated: prepared.truncated,
    };
  }
}
