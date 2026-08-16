import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IVesselObservationRepository,
  ObservationSaveResult,
  ObservationSaveStatus,
} from "../../contracts/repositories/IVesselObservationRepository";
import { AisCoalescedBatch } from "../../services/ingestion/AisCoalescingBuffer";
import { VesselSourceObservation } from "../../../domain/entities/VesselObservation";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselIdentity } from "../../../domain/value-objects/VesselIdentity";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import { IngestAisBatch } from "./IngestAisBatch";
import { InMemoryVesselObservationRepository } from "../../../infrastructure/persistence/memory/InMemoryVesselObservationRepository";
import { InMemoryCurrentVesselRepository } from "../../../infrastructure/persistence/memory/InMemoryCurrentVesselRepository";
import { ResolveCurrentVessel } from "../resolution/ResolveCurrentVessel";
import { ResolveAndStoreCurrentVessel } from "../resolution/ResolveAndStoreCurrentVessel";

const FETCHED_AT = new Date("2026-08-16T12:10:00.000Z");

function entry(mmsi: string, groups: "identity" | "position" | "both") {
  const metadata = createSourceMetadata({
    source: VesselSource.AISSTREAM,
    fetchedAt: FETCHED_AT,
    sourceReceivedAt: groups === "identity" ? null : FETCHED_AT,
  });
  const identity: VesselIdentity = {
    mmsi, imo: null, name: `VESSEL ${mmsi}`, callsign: null, vesselType: null,
    vesselTypeCode: 70, flag: null, metadata,
  };
  const position: VesselPositionReport = {
    mmsi, imo: null, lat: 1, lng: 2, speed: 10, course: 90, heading: null,
    navStatus: null, latLngApproximate: false, receivedAt: FETCHED_AT, metadata,
  };
  return {
    mmsi,
    ...(groups === "identity" || groups === "both" ? { identity } : {}),
    ...(groups === "position" || groups === "both" ? { position } : {}),
  };
}

function batch(...entries: ReturnType<typeof entry>[]): AisCoalescedBatch {
  return { entries, createdAt: FETCHED_AT, remaining: 0 };
}

class RecordingRepository implements IVesselObservationRepository {
  calls: Array<readonly VesselSourceObservation[]> = [];
  async save(): Promise<ObservationSaveResult> { throw new Error("save must not be used"); }
  async saveMany(observations: readonly VesselSourceObservation[]) {
    this.calls = [...this.calls, observations];
    return observations.map((observation) => ({
      status: ObservationSaveStatus.SAVED,
      fingerprint: `${observation.vesselKey.mmsi}:${observation.type}`,
    }));
  }
  async findRecentByVessel(): Promise<readonly VesselSourceObservation[]> { return []; }
  async findRecentBySource(): Promise<readonly VesselSourceObservation[]> { return []; }
  async findLatestByVesselAndType() { return null; }
  async findLatestPerSourceByVesselAndType() { return []; }
}

test("persists identity and position in one saveMany call, then resolves the MMSI once", async () => {
  const repository = new RecordingRepository();
  const resolved: string[] = [];
  const ingest = new IngestAisBatch({
    repository,
    resolveAndStore: { execute: async ({ mmsi }: { mmsi?: string }) => { resolved.push(mmsi!); } },
    resolveConcurrency: 2,
  });

  const result = await ingest.execute(batch(entry("636018086", "both")));

  assert.equal(repository.calls.length, 1);
  assert.deepEqual(repository.calls[0].map((observation) => observation.type), ["IDENTITY", "POSITION"]);
  assert.deepEqual(resolved, ["636018086"]);
  assert.deepEqual(result, {
    inputEntries: 1, observationsCreated: 2, observationsSaved: 2,
    observationsSkippedDuplicate: 0, vesselsAffected: 1, vesselsResolved: 1,
    vesselsResolveFailed: 0,
  });
});

test("bounds resolution concurrency and reports a per-vessel resolve failure without losing persisted observations", async () => {
  const repository = new RecordingRepository();
  let active = 0;
  let peak = 0;
  const ingest = new IngestAisBatch({
    repository,
    resolveConcurrency: 2,
    resolveAndStore: {
      execute: async ({ mmsi }: { mmsi?: string }) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (mmsi === "B") throw new Error("resolver failed");
      },
    },
  });

  const result = await ingest.execute(batch(entry("A", "position"), entry("B", "position"), entry("C", "position")));

  assert.equal(repository.calls[0].length, 3, "persistence completed before resolution");
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded configured bound`);
  assert.equal(result.vesselsResolved, 2);
  assert.equal(result.vesselsResolveFailed, 1);
});

test("position-only AIS updates canonical position without erasing an existing AIS identity", async () => {
  const observations = new InMemoryVesselObservationRepository({ now: () => new Date("2026-08-16T13:00:00.000Z") });
  const current = new InMemoryCurrentVesselRepository({ now: () => new Date("2026-08-16T13:00:00.000Z") });
  const resolveAndStore = new ResolveAndStoreCurrentVessel({
    resolve: new ResolveCurrentVessel({ repository: observations, now: () => new Date("2026-08-16T13:00:00.000Z") }),
    repository: current,
  });
  const ingest = new IngestAisBatch({ repository: observations, resolveAndStore, resolveConcurrency: 1 });

  await ingest.execute(batch(entry("636018086", "identity")));
  const identityOnly = await current.findByMmsi("636018086");
  assert.equal(identityOnly?.identity?.name?.value, "VESSEL 636018086");
  assert.equal(identityOnly?.position, null);
  const later = new Date("2026-08-16T12:11:00.000Z");
  const positionOnly = entry("636018086", "position");
  const position = {
    ...positionOnly.position!, lat: 3, receivedAt: later,
    metadata: createSourceMetadata({ source: VesselSource.AISSTREAM, fetchedAt: later, sourceReceivedAt: later }),
  };
  await ingest.execute(batch({ ...positionOnly, position }));

  const stored = await current.findByMmsi("636018086");
  assert.equal(stored?.identity?.name?.value, "VESSEL 636018086");
  assert.equal(stored?.position?.position.lat, 3);
});
