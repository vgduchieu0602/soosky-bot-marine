// ============================================================================
//  INFRASTRUCTURE · MongoVesselObservationRepository
// ----------------------------------------------------------------------------
//  Append-only vào `vessel_observations`. KHÔNG đụng vessels / latestpositions /
//  vesselpositions — nguồn A không bao giờ ghi đè nguồn B ở đây.
// ============================================================================

import {
  IVesselObservationRepository,
  ObservationQueryOptions,
  ObservationSaveResult,
  ObservationSaveStatus,
} from "../../application/observations/IVesselObservationRepository";
import {
  DEFAULT_OBSERVATION_DEDUPE_CONFIG,
  ObservationDedupeConfig,
  dedupeCutoff,
} from "../../application/observations/ObservationPolicy";
import { observationFingerprint } from "../../application/observations/observationFingerprint";
import { ObservationValidationStatus } from "../../domain/observations/ObservationValidation";
import {
  VesselObservationKey,
  VesselObservationType,
  VesselSourceObservation,
} from "../../domain/observations/VesselObservation";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { VesselObservationModel } from "./mongoose/observationModels";

const DEFAULT_LIMIT = 100;

interface ObservationDoc {
  _id?: unknown;
  source: string;
  type: string;
  mmsi?: string | null;
  imo?: string | null;
  data: unknown;
  fetchedAt: Date;
  sourceReceivedAt?: Date | null;
  validationStatus: string;
  validationErrors?: Array<{ field?: string; code: string; message: string }>;
  parserVersion?: string;
  rawPayload?: unknown;
  rawPayloadTruncated?: boolean;
  fingerprint: string;
}

export interface MongoVesselObservationRepositoryDeps {
  dedupeConfig?: ObservationDedupeConfig;
  now?: () => Date;
}

export class MongoVesselObservationRepository implements IVesselObservationRepository {
  private readonly dedupeConfig: ObservationDedupeConfig;
  private readonly now: () => Date;

  constructor(deps: MongoVesselObservationRepositoryDeps = {}) {
    this.dedupeConfig = deps.dedupeConfig ?? DEFAULT_OBSERVATION_DEDUPE_CONFIG;
    this.now = deps.now ?? (() => new Date());
  }

  async save(observation: VesselSourceObservation): Promise<ObservationSaveResult> {
    const fingerprint = observationFingerprint(observation);
    const cutoff = dedupeCutoff(observation.type, this.now(), this.dedupeConfig);

    const duplicate = await VesselObservationModel.exists({
      fingerprint,
      fetchedAt: { $gte: cutoff },
    });
    if (duplicate !== null) {
      return { status: ObservationSaveStatus.SKIPPED_DUPLICATE, fingerprint };
    }

    const created = await VesselObservationModel.create(
      MongoVesselObservationRepository.toDoc(observation, fingerprint)
    );
    return {
      status: ObservationSaveStatus.SAVED,
      fingerprint,
      id: String(created._id),
    };
  }

  /**
   * Tuần tự có chủ ý: hai observation TRÙNG NHAU trong cùng một mẻ phải ăn
   * dedupe của nhau. Ghi song song thì cái thứ hai không thấy cái thứ nhất.
   */
  async saveMany(
    observations: readonly VesselSourceObservation[]
  ): Promise<readonly ObservationSaveResult[]> {
    const results: ObservationSaveResult[] = [];
    for (const observation of observations) {
      results.push(await this.save(observation));
    }
    return Object.freeze(results);
  }

  async findRecentByVessel(
    key: VesselObservationKey,
    options: ObservationQueryOptions = {}
  ): Promise<readonly VesselSourceObservation[]> {
    const identifiers: Record<string, unknown>[] = [];
    if (key.mmsi !== undefined) identifiers.push({ mmsi: key.mmsi });
    if (key.imo !== undefined) identifiers.push({ imo: key.imo });
    if (identifiers.length === 0) return Object.freeze([]);

    return this.query({ $or: identifiers }, options);
  }

  async findRecentBySource(
    source: VesselSource,
    options: ObservationQueryOptions = {}
  ): Promise<readonly VesselSourceObservation[]> {
    return this.query({ source }, options);
  }

  async findLatestByVesselAndType(
    key: VesselObservationKey,
    type: VesselObservationType,
    options: ObservationQueryOptions = {}
  ): Promise<VesselSourceObservation | null> {
    const found = await this.findRecentByVessel(key, { ...options, type, limit: 1 });
    return found[0] ?? null;
  }

  private async query(
    filter: Record<string, unknown>,
    options: ObservationQueryOptions
  ): Promise<readonly VesselSourceObservation[]> {
    const criteria: Record<string, unknown> = { ...filter };
    if (options.type !== undefined) criteria.type = options.type;
    if (options.since !== undefined) criteria.fetchedAt = { $gte: options.since };
    // Mặc định KHÔNG trả bản ghi hỏng: chúng chỉ để debug parser.
    if (options.includeInvalid !== true) {
      criteria.validationStatus = { $ne: ObservationValidationStatus.INVALID };
    }

    const docs = await VesselObservationModel.find(criteria)
      .sort({ fetchedAt: -1 })
      .limit(options.limit ?? DEFAULT_LIMIT)
      .lean<ObservationDoc[]>()
      .exec();

    return Object.freeze(docs.map(MongoVesselObservationRepository.toEntity));
  }

  private static toDoc(
    observation: VesselSourceObservation,
    fingerprint: string
  ): Record<string, unknown> {
    return {
      source: observation.source,
      type: observation.type,
      mmsi: observation.vesselKey.mmsi ?? null,
      imo: observation.vesselKey.imo ?? null,
      data: observation.data,
      fetchedAt: observation.fetchedAt,
      sourceReceivedAt: observation.sourceReceivedAt ?? null,
      validationStatus: observation.validation.status,
      validationErrors: observation.validation.errors,
      parserVersion: observation.parserVersion,
      rawPayload: observation.rawPayload,
      rawPayloadTruncated: observation.rawPayloadTruncated ?? false,
      fingerprint,
    };
  }

  private static toEntity(doc: ObservationDoc): VesselSourceObservation {
    return {
      id: doc._id === undefined ? undefined : String(doc._id),
      source: doc.source as VesselSource,
      type: doc.type as VesselObservationType,
      vesselKey: {
        mmsi: doc.mmsi ?? undefined,
        imo: doc.imo ?? undefined,
      },
      data: doc.data,
      fetchedAt: doc.fetchedAt,
      sourceReceivedAt: doc.sourceReceivedAt ?? null,
      validation: {
        status: doc.validationStatus as ObservationValidationStatus,
        errors: doc.validationErrors ?? [],
      },
      parserVersion: doc.parserVersion,
      rawPayload: doc.rawPayload,
      rawPayloadTruncated: doc.rawPayloadTruncated,
    } as VesselSourceObservation;
  }
}
