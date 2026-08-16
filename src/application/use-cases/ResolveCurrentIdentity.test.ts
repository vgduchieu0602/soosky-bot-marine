// ============================================================================
//  TEST · ResolveCurrentIdentity + ResolveCurrentParticulars
// ----------------------------------------------------------------------------
//  Dùng repository THẬT (InMemory) để chứng minh truy vấn P8.2 và hai resolver
//  P8.3 ăn khớp nhau. Không mạng, không Mongo.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { ObservationValidationStatus } from "../../domain/enums/ObservationValidation";
import {
  IdentityObservation,
  ParticularsObservation,
  VesselObservationType,
} from "../../domain/entities/VesselObservation";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../domain/enums/VesselSource";
import { InMemoryVesselObservationRepository } from "../../infrastructure/persistence/memory/InMemoryVesselObservationRepository";
import { ResolutionReason } from "../services/resolution/ResolverTypes";
import { ResolveCurrentIdentity } from "./ResolveCurrentIdentity";
import { ResolveCurrentParticulars } from "./ResolveCurrentParticulars";

const MMSI = "636018086";
const NOW = new Date("2026-08-14T17:00:00.000Z");
const SHIPFINDER_AT = new Date("2026-08-14T16:40:41.985Z");
const SHIPINFO_AT = new Date("2026-08-14T10:40:13.307Z");

function identity(source: VesselSource, fetchedAt: Date, data: object): IdentityObservation {
  return {
    source,
    type: VesselObservationType.IDENTITY,
    vesselKey: { mmsi: MMSI },
    fetchedAt,
    sourceReceivedAt: null,
    validation: { status: ObservationValidationStatus.VALID, errors: [] },
    data: { mmsi: MMSI, metadata: createSourceMetadata({ source, fetchedAt }), ...data },
  };
}

function particulars(source: VesselSource, fetchedAt: Date, data: object): ParticularsObservation {
  return {
    source,
    type: VesselObservationType.PARTICULARS,
    vesselKey: { mmsi: MMSI },
    fetchedAt,
    sourceReceivedAt: null,
    validation: { status: ObservationValidationStatus.VALID, errors: [] },
    data: { mmsi: MMSI, metadata: createSourceMetadata({ source, fetchedAt }), ...data },
  };
}

function repo(): InMemoryVesselObservationRepository {
  return new InMemoryVesselObservationRepository({ now: () => NOW });
}

test("CA THẬT · đọc từ kho -> identity trộn field đúng", async () => {
  const store = repo();
  await store.save(
    identity(VesselSource.SHIPFINDER, SHIPFINDER_AT, {
      name: "AGIA DOXA",
      callsign: "D5OC7",
      vesselType: "Cargo ship",
      flag: { code: "LBR", name: null },
    })
  );
  await store.save(
    identity(VesselSource.SHIPINFO, SHIPINFO_AT, {
      name: "Agia Doxa",
      callsign: "D5OC7",
      vesselType: "Bulk Carrier",
      flag: { code: "LR", name: "Liberia" },
    })
  );

  const useCase = new ResolveCurrentIdentity({ repository: store, now: () => NOW });
  const result = await useCase.execute({ mmsi: MMSI });

  assert.ok(result);
  assert.equal(result.name?.reason, ResolutionReason.SOURCES_AGREE);
  assert.equal(result.vesselType?.value, "Bulk Carrier");
  assert.equal(result.vesselType?.source, VesselSource.SHIPINFO);
  assert.equal(result.flagName?.value, "Liberia");
  assert.equal(result.flagCode?.reason, ResolutionReason.SOURCES_AGREE);
});

test("CA THẬT · đọc từ kho -> particulars bù trừ giữa hai nguồn", async () => {
  const store = repo();
  await store.save(
    particulars(VesselSource.SHIPFINDER, SHIPFINDER_AT, {
      length: 179,
      beam: 29,
      draught: 5.9,
      builtYear: null,
      deadweight: null,
    })
  );
  await store.save(
    particulars(VesselSource.SHIPINFO, SHIPINFO_AT, {
      length: null,
      beam: null,
      draught: null,
      builtYear: 2010,
      deadweight: 33261,
    })
  );

  const useCase = new ResolveCurrentParticulars({ repository: store, now: () => NOW });
  const result = await useCase.execute({ mmsi: MMSI });

  assert.deepEqual(
    {
      length: [result?.length?.value, result?.length?.source],
      beam: [result?.beam?.value, result?.beam?.source],
      draught: [result?.draught?.value, result?.draught?.source],
      builtYear: [result?.builtYear?.value, result?.builtYear?.source],
      deadweight: [result?.deadweight?.value, result?.deadweight?.source],
    },
    {
      length: [179, VesselSource.SHIPFINDER],
      beam: [29, VesselSource.SHIPFINDER],
      draught: [5.9, VesselSource.SHIPFINDER],
      builtYear: [2010, VesselSource.SHIPINFO],
      deadweight: [33261, VesselSource.SHIPINFO],
    }
  );
});

test("tàu chưa có observation -> null, KHÔNG gọi nguồn để lấy thêm", async () => {
  const store = repo();
  assert.equal(
    await new ResolveCurrentIdentity({ repository: store, now: () => NOW }).execute({
      mmsi: "999999999",
    }),
    null
  );
  assert.equal(
    await new ResolveCurrentParticulars({ repository: store, now: () => NOW }).execute({
      mmsi: "999999999",
    }),
    null
  );
});

test("bản ghi ngoài cửa sổ 90 ngày bị bỏ qua", async () => {
  const store = repo();
  const longAgo = new Date(NOW.getTime() - 120 * 24 * 60 * 60 * 1000);
  await store.save(identity(VesselSource.SHIPINFO, longAgo, { name: "TÀU CŨ" }));

  const useCase = new ResolveCurrentIdentity({ repository: store, now: () => NOW });
  assert.equal(await useCase.execute({ mmsi: MMSI }), null);
});

test("use case KHÔNG ghi gì vào kho", async () => {
  const store = repo();
  await store.save(identity(VesselSource.SHIPFINDER, SHIPFINDER_AT, { name: "AGIA DOXA" }));
  const before = store.size;

  const useCase = new ResolveCurrentIdentity({ repository: store, now: () => NOW });
  await useCase.execute({ mmsi: MMSI });
  await useCase.execute({ mmsi: MMSI });

  assert.equal(store.size, before, "resolver chỉ ĐỌC");
});
