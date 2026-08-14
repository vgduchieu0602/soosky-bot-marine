// ============================================================================
//  INFRASTRUCTURE · InMemoryVesselObservationRepository
// ----------------------------------------------------------------------------
//  Cùng hợp đồng với bản Mongo, giữ trong RAM. Dùng cho unit test (không cần
//  MongoDB sống) và cho đường chạy dev không đặt MONGODB_URI.
//
//  ⚠️ Mất khi restart. Đúng với vai trò: đây không phải kho lưu trữ thật.
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

const DEFAULT_LIMIT = 100;

interface StoredObservation {
  observation: VesselSourceObservation;
  fingerprint: string;
}

export interface InMemoryVesselObservationRepositoryDeps {
  dedupeConfig?: ObservationDedupeConfig;
  now?: () => Date;
}

export class InMemoryVesselObservationRepository implements IVesselObservationRepository {
  private readonly stored: StoredObservation[] = [];
  private readonly dedupeConfig: ObservationDedupeConfig;
  private readonly now: () => Date;
  private nextId = 1;

  constructor(deps: InMemoryVesselObservationRepositoryDeps = {}) {
    this.dedupeConfig = deps.dedupeConfig ?? DEFAULT_OBSERVATION_DEDUPE_CONFIG;
    this.now = deps.now ?? (() => new Date());
  }

  async save(observation: VesselSourceObservation): Promise<ObservationSaveResult> {
    const fingerprint = observationFingerprint(observation);
    const cutoff = dedupeCutoff(observation.type, this.now(), this.dedupeConfig);

    const duplicate = this.stored.some(
      (entry) =>
        entry.fingerprint === fingerprint &&
        entry.observation.fetchedAt.getTime() >= cutoff.getTime()
    );
    if (duplicate) {
      return { status: ObservationSaveStatus.SKIPPED_DUPLICATE, fingerprint };
    }

    const id = String(this.nextId++);
    this.stored.push({ observation: { ...observation, id }, fingerprint });
    return { status: ObservationSaveStatus.SAVED, fingerprint, id };
  }

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
    if (key.mmsi === undefined && key.imo === undefined) return Object.freeze([]);
    return this.query(
      (observation) =>
        (key.mmsi !== undefined && observation.vesselKey.mmsi === key.mmsi) ||
        (key.imo !== undefined && observation.vesselKey.imo === key.imo),
      options
    );
  }

  async findRecentBySource(
    source: VesselSource,
    options: ObservationQueryOptions = {}
  ): Promise<readonly VesselSourceObservation[]> {
    return this.query((observation) => observation.source === source, options);
  }

  async findLatestByVesselAndType(
    key: VesselObservationKey,
    type: VesselObservationType,
    options: ObservationQueryOptions = {}
  ): Promise<VesselSourceObservation | null> {
    const found = await this.findRecentByVessel(key, { ...options, type, limit: 1 });
    return found[0] ?? null;
  }

  /** Toàn bộ bản ghi, mới nhất trước — chỉ dùng cho test/kiểm tra. */
  all(): readonly VesselSourceObservation[] {
    return Object.freeze(this.stored.map((entry) => entry.observation));
  }

  get size(): number {
    return this.stored.length;
  }

  private query(
    match: (observation: VesselSourceObservation) => boolean,
    options: ObservationQueryOptions
  ): readonly VesselSourceObservation[] {
    const filtered = this.stored
      .map((entry) => entry.observation)
      .filter((observation) => {
        if (!match(observation)) return false;
        if (options.type !== undefined && observation.type !== options.type) return false;
        if (options.since !== undefined && observation.fetchedAt < options.since) return false;
        if (
          options.includeInvalid !== true &&
          observation.validation.status === ObservationValidationStatus.INVALID
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime());

    return Object.freeze(filtered.slice(0, options.limit ?? DEFAULT_LIMIT));
  }
}
