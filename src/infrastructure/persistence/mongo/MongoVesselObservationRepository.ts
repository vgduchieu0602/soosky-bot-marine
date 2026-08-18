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
} from "../../../application/contracts/repositories/IVesselObservationRepository";
import {
  DEFAULT_OBSERVATION_DEDUPE_CONFIG,
  ObservationDedupeConfig,
  dedupeCutoff,
} from "../../../application/services/observation/ObservationPolicy";
import { observationFingerprint } from "../../../application/services/observation/observationFingerprint";
import {
  DEFAULT_OBSERVATION_RETENTION_CONFIG,
  ObservationRetentionConfig,
  observationExpiresAt,
} from "../../../application/services/observation/ObservationRetentionPolicy";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import {
  VesselObservationKey,
  VesselObservationType,
  VesselSourceObservation,
} from "../../../domain/entities/VesselObservation";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { VesselObservationModel } from "./observationModels";

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
  retentionConfig?: ObservationRetentionConfig;
  now?: () => Date;
}

export class MongoVesselObservationRepository implements IVesselObservationRepository {
  private readonly dedupeConfig: ObservationDedupeConfig;
  private readonly retentionConfig: ObservationRetentionConfig;
  private readonly now: () => Date;

  constructor(deps: MongoVesselObservationRepositoryDeps = {}) {
    this.dedupeConfig = deps.dedupeConfig ?? DEFAULT_OBSERVATION_DEDUPE_CONFIG;
    this.retentionConfig = deps.retentionConfig ?? DEFAULT_OBSERVATION_RETENTION_CONFIG;
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

    const created = await VesselObservationModel.create(this.toDoc(observation, fingerprint));
    return {
      status: ObservationSaveStatus.SAVED,
      fingerprint,
      id: String(created._id),
    };
  }

  async saveMany(
    observations: readonly VesselSourceObservation[]
  ): Promise<readonly ObservationSaveResult[]> {
    if (observations.length === 0) return Object.freeze([]);

    const now = this.now();
    const byFingerprint = new Map<string, { firstIndex: number; observation: VesselSourceObservation; cutoff: Date }>();
    const fingerprints = observations.map((observation, index) => {
      const fingerprint = observationFingerprint(observation);
      if (!byFingerprint.has(fingerprint)) {
        byFingerprint.set(fingerprint, {
          firstIndex: index,
          observation,
          cutoff: dedupeCutoff(observation.type, now, this.dedupeConfig),
        });
      }
      return fingerprint;
    });

    const fingerprintGroups = new Map<number, { cutoff: Date; fingerprints: string[] }>();
    for (const [fingerprint, candidate] of byFingerprint) {
      const key = candidate.cutoff.getTime();
      const group = fingerprintGroups.get(key) ?? { cutoff: candidate.cutoff, fingerprints: [] };
      group.fingerprints.push(fingerprint);
      fingerprintGroups.set(key, group);
    }

    const existing = await VesselObservationModel.find({
      $or: [...fingerprintGroups.values()].map(({ cutoff, fingerprints: values }) => ({
        fingerprint: { $in: values },
        fetchedAt: { $gte: cutoff },
      })),
    })
      .select({ fingerprint: 1 })
      .lean<Array<{ fingerprint: string }>>()
      .exec();
    const existingFingerprints = new Set(existing.map((document) => document.fingerprint));

    const toInsert = [...byFingerprint.entries()].filter(
      ([fingerprint]) => !existingFingerprints.has(fingerprint)
    );
    const created =
      toInsert.length === 0
        ? []
        : await VesselObservationModel.insertMany(
            toInsert.map(([fingerprint, candidate]) =>
              this.toDoc(candidate.observation, fingerprint)
            ),
            { ordered: true }
          );
    const savedIds = new Map(
      toInsert.map(([fingerprint], index) => [fingerprint, String(created[index]._id)])
    );

    return Object.freeze(
      fingerprints.map((fingerprint, index) => {
        const candidate = byFingerprint.get(fingerprint)!;
        if (candidate.firstIndex !== index || existingFingerprints.has(fingerprint)) {
          return { status: ObservationSaveStatus.SKIPPED_DUPLICATE, fingerprint };
        }
        return {
          status: ObservationSaveStatus.SAVED,
          fingerprint,
          id: savedIds.get(fingerprint),
        };
      })
    );
  }

  async findRecentByVessel(
    key: VesselObservationKey,
    options: ObservationQueryOptions = {}
  ): Promise<readonly VesselSourceObservation[]> {
    const filter = MongoVesselObservationRepository.vesselFilter(key);
    if (filter === null) return Object.freeze([]);
    return this.query(filter, options);
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

  /**
   * Mới nhất của MỖI nguồn, bằng một `aggregate` duy nhất:
   *   $match -> $sort fetchedAt DESC -> $group theo source lấy $first
   * Index `{mmsi:1, type:1, fetchedAt:-1}` (đã có sẵn) phục vụ đúng $match + $sort này.
   *
   * `limit` cố tình bị bỏ qua: số kết quả do (số nguồn × `maxPerSource`) quyết định.
   */
  async findLatestPerSourceByVesselAndType(
    key: VesselObservationKey,
    type: VesselObservationType,
    options: ObservationQueryOptions = {}
  ): Promise<readonly VesselSourceObservation[]> {
    const filter = MongoVesselObservationRepository.vesselFilter(key);
    if (filter === null) return Object.freeze([]);

    const criteria = MongoVesselObservationRepository.buildCriteria(filter, { ...options, type });

    // Chặn trên cứng cho số bản ghi mỗi nguồn. `$slice` chạy SAU `$sort`, nên
    // đây đúng là "N bản mới nhất của nguồn đó", không phải N bản bất kỳ.
    const maxPerSource = Math.max(1, Math.floor(options.maxPerSource ?? 1));

    const rows = await VesselObservationModel.aggregate<{ docs: ObservationDoc[] }>([
      { $match: criteria },
      { $sort: { fetchedAt: -1 } },
      { $group: { _id: "$source", docs: { $push: "$$ROOT" } } },
      { $project: { docs: { $slice: ["$docs", maxPerSource] } } },
      // Sắp theo tên nguồn -> kết quả tất định, không phụ thuộc thứ tự nhóm của Mongo.
      { $sort: { _id: 1 } },
    ]).exec();

    return Object.freeze(
      rows.flatMap((row) => row.docs.map((doc) => MongoVesselObservationRepository.toEntity(doc)))
    );
  }

  /** `null` = khoá rỗng, không truy vấn gì cả. */
  private static vesselFilter(key: VesselObservationKey): Record<string, unknown> | null {
    const identifiers: Record<string, unknown>[] = [];
    if (key.mmsi !== undefined) identifiers.push({ mmsi: key.mmsi });
    if (key.imo !== undefined) identifiers.push({ imo: key.imo });
    return identifiers.length === 0 ? null : { $or: identifiers };
  }

  /** Dùng chung cho `find` và `aggregate` -> hai đường không thể lệch luật lọc. */
  private static buildCriteria(
    filter: Record<string, unknown>,
    options: ObservationQueryOptions
  ): Record<string, unknown> {
    const criteria: Record<string, unknown> = { ...filter };
    if (options.type !== undefined) criteria.type = options.type;
    if (options.since !== undefined) criteria.fetchedAt = { $gte: options.since };
    // Mặc định KHÔNG trả bản ghi hỏng: chúng chỉ để debug parser.
    if (options.includeInvalid !== true) {
      criteria.validationStatus = { $ne: ObservationValidationStatus.INVALID };
    }
    return criteria;
  }

  private async query(
    filter: Record<string, unknown>,
    options: ObservationQueryOptions
  ): Promise<readonly VesselSourceObservation[]> {
    const criteria = MongoVesselObservationRepository.buildCriteria(filter, options);

    const docs = await VesselObservationModel.find(criteria)
      .sort({ fetchedAt: -1 })
      .limit(options.limit ?? DEFAULT_LIMIT)
      .lean<ObservationDoc[]>()
      .exec();

    return Object.freeze(docs.map(MongoVesselObservationRepository.toEntity));
  }

  /**
   * `expiresAt` được tính Ở ĐÂY, không ở domain: TTL là vòng đời của bản ghi
   * trong kho, không phải một sự thật về con tàu. Retention `null` -> field
   * VẮNG MẶT, và TTL index của Mongo bỏ qua document không có field đó.
   */
  private toDoc(
    observation: VesselSourceObservation,
    fingerprint: string
  ): Record<string, unknown> {
    const expiresAt = observationExpiresAt(
      {
        source: observation.source,
        type: observation.type,
        validationStatus: observation.validation.status,
        fetchedAt: observation.fetchedAt,
      },
      this.retentionConfig
    );

    return {
      ...(expiresAt === null ? {} : { expiresAt }),
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
