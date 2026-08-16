import assert from "node:assert/strict";
import { test } from "node:test";
import { ObservationSaveStatus } from "../../../application/contracts/repositories/IVesselObservationRepository";
import { VesselObservationType, VesselSourceObservation } from "../../../domain/entities/VesselObservation";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { MongoVesselObservationRepository } from "./MongoVesselObservationRepository";
import { VesselObservationModel } from "./observationModels";

const NOW = new Date("2026-08-16T12:10:00.000Z");

function position(mmsi: string, lat = 1): VesselSourceObservation {
  const metadata = createSourceMetadata({
    source: VesselSource.AISSTREAM, fetchedAt: NOW, sourceReceivedAt: NOW,
  });
  return {
    source: VesselSource.AISSTREAM,
    type: VesselObservationType.POSITION,
    vesselKey: { mmsi },
    fetchedAt: NOW,
    sourceReceivedAt: NOW,
    validation: { status: ObservationValidationStatus.VALID, errors: [] },
    data: {
      mmsi, imo: null, lat, lng: 2, speed: 10, course: null, heading: null,
      navStatus: null, latLngApproximate: false, receivedAt: NOW, metadata,
    },
  } as VesselSourceObservation;
}

test("saveMany dedupes the batch and DB with one bounded lookup and one bulk insert", async () => {
  const model = VesselObservationModel as unknown as {
    find: (criteria: unknown) => { select: () => { lean: () => { exec: () => Promise<unknown[]> } } };
    insertMany: (docs: Array<Record<string, unknown>>, options: unknown) => Promise<Array<{ _id: string }>>;
    exists: () => Promise<unknown>;
    create: () => Promise<unknown>;
  };
  const original = { find: model.find, insertMany: model.insertMany, exists: model.exists, create: model.create };
  let findCalls = 0;
  let inserted: Array<Record<string, unknown>> = [];
  model.find = () => ({ select: () => ({ lean: () => ({ exec: async () => [] }) }) });
  model.insertMany = async (docs) => {
    inserted = docs;
    return docs.map((_, index) => ({ _id: `id-${index + 1}` }));
  };
  model.exists = async () => { throw new Error("saveMany must not perform per-item exists"); };
  model.create = async () => { throw new Error("saveMany must not perform per-item create"); };
  const originalFind = model.find;
  model.find = (criteria) => {
    findCalls += 1;
    return originalFind(criteria);
  };

  try {
    const repository = new MongoVesselObservationRepository({ now: () => NOW });
    const results = await repository.saveMany([position("A"), position("A"), position("B", 3)]);

    assert.equal(findCalls, 1);
    assert.equal(inserted.length, 2);
    assert.deepEqual(results.map((result) => result.status), [
      ObservationSaveStatus.SAVED,
      ObservationSaveStatus.SKIPPED_DUPLICATE,
      ObservationSaveStatus.SAVED,
    ]);
    assert.deepEqual(results.map((result) => result.id), ["id-1", undefined, "id-2"]);
  } finally {
    model.find = original.find;
    model.insertMany = original.insertMany;
    model.exists = original.exists;
    model.create = original.create;
  }
});

test("saveMany maps an existing DB fingerprint to its input slot without inserting it", async () => {
  const model = VesselObservationModel as unknown as {
    find: (criteria: { $or: Array<{ fingerprint: { $in: string[] } }> }) => { select: () => { lean: () => { exec: () => Promise<unknown[]> } } };
    insertMany: (docs: Array<Record<string, unknown>>) => Promise<Array<{ _id: string }>>;
  };
  const original = { find: model.find, insertMany: model.insertMany };
  let inserted: Array<Record<string, unknown>> = [];
  model.find = (criteria) => ({
    select: () => ({ lean: () => ({ exec: async () => [{ fingerprint: criteria.$or[0].fingerprint.$in[0] }] }) }),
  });
  model.insertMany = async (docs) => {
    inserted = docs;
    return docs.map((_, index) => ({ _id: `id-${index + 1}` }));
  };

  try {
    const repository = new MongoVesselObservationRepository({ now: () => NOW });
    const results = await repository.saveMany([position("A"), position("B", 3)]);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].mmsi, "B");
    assert.deepEqual(results.map((result) => result.status), [
      ObservationSaveStatus.SKIPPED_DUPLICATE,
      ObservationSaveStatus.SAVED,
    ]);
  } finally {
    model.find = original.find;
    model.insertMany = original.insertMany;
  }
});
