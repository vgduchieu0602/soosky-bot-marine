import {
  IVesselObservationRepository,
  ObservationSaveStatus,
} from "../../contracts/repositories/IVesselObservationRepository";
import { AisCoalescedBatch } from "../../services/ingestion/AisCoalescingBuffer";
import { detailsResultToObservations } from "../../services/observation/providerResultToObservation";

export interface AisCurrentVesselResolver {
  execute(key: { mmsi: string }): Promise<unknown>;
}

export interface IngestAisBatchDeps {
  repository: IVesselObservationRepository;
  resolveAndStore: AisCurrentVesselResolver;
  /** Supplied by bootstrap so this use case never imports an infrastructure parser. */
  parserVersion?: string;
  resolveConcurrency: number;
}

export interface IngestAisBatchResult {
  readonly inputEntries: number;
  readonly observationsCreated: number;
  readonly observationsSaved: number;
  readonly observationsSkippedDuplicate: number;
  readonly vesselsAffected: number;
  readonly vesselsResolved: number;
  readonly vesselsResolveFailed: number;
}

/** Persists one coalesced AIS batch, then refreshes each affected current vessel once. */
export class IngestAisBatch {
  private readonly repository: IVesselObservationRepository;
  private readonly resolveAndStore: AisCurrentVesselResolver;
  private readonly parserVersion?: string;
  private readonly resolveConcurrency: number;

  constructor(deps: IngestAisBatchDeps) {
    if (!Number.isInteger(deps.resolveConcurrency) || deps.resolveConcurrency < 1) {
      throw new Error(`resolveConcurrency must be a positive integer, received ${deps.resolveConcurrency}`);
    }
    this.repository = deps.repository;
    this.resolveAndStore = deps.resolveAndStore;
    this.parserVersion = deps.parserVersion;
    this.resolveConcurrency = deps.resolveConcurrency;
  }

  async execute(batch: AisCoalescedBatch): Promise<IngestAisBatchResult> {
    const observations = batch.entries.flatMap((entry) =>
      detailsResultToObservations(entry, { parserVersion: this.parserVersion })
    );
    const persisted = await this.repository.saveMany(observations);
    const mmsi = [...new Set(batch.entries.map((entry) => entry.mmsi))];
    const resolution = await this.resolveAll(mmsi);

    return {
      inputEntries: batch.entries.length,
      observationsCreated: observations.length,
      observationsSaved: persisted.filter((result) => result.status === ObservationSaveStatus.SAVED).length,
      observationsSkippedDuplicate: persisted.filter(
        (result) => result.status === ObservationSaveStatus.SKIPPED_DUPLICATE
      ).length,
      vesselsAffected: mmsi.length,
      vesselsResolved: resolution.resolved,
      vesselsResolveFailed: resolution.failed,
    };
  }

  private async resolveAll(mmsi: readonly string[]): Promise<{ resolved: number; failed: number }> {
    let next = 0;
    let resolved = 0;
    let failed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const current = next;
        next += 1;
        if (current >= mmsi.length) return;
        try {
          await this.resolveAndStore.execute({ mmsi: mmsi[current] });
          resolved += 1;
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.resolveConcurrency, mmsi.length) }, worker));
    return { resolved, failed };
  }
}
