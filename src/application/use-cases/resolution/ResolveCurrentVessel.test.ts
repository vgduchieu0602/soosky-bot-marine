// ============================================================================
//  TEST · ResolveCurrentVoyage + ResolveCurrentVessel (ghép bốn nhóm)
// ----------------------------------------------------------------------------
//  Dùng repository THẬT (InMemory), không mock resolver — chứng minh truy vấn
//  P8.2 và bốn resolver ăn khớp. Số liệu lấy từ observation thật của AGIA DOXA.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import {
  VesselObservationType,
  VesselSourceObservation,
} from "../../../domain/entities/VesselObservation";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { InMemoryVesselObservationRepository } from "../../../infrastructure/persistence/memory/InMemoryVesselObservationRepository";
import { ResolutionReason } from "../../services/resolution/ResolverTypes";
import { ResolveCurrentVessel } from "./ResolveCurrentVessel";
import { ResolveCurrentVoyage } from "./ResolveCurrentVoyage";

const MMSI = "636018086";
const NOW = new Date("2026-08-14T17:00:00.000Z");
const SHIPFINDER_AT = new Date("2026-08-14T16:40:41.985Z");
const SHIPINFO_AT = new Date("2026-08-14T10:40:13.307Z");
/** Mốc NGUỒN của vị trí ShipFinder — 1 phút trước lúc fetch. */
const SF_POSITION_AT = new Date("2026-08-14T16:39:41.000Z");
/** Mốc NGUỒN của vị trí ShipInfo — trễ 14.49 giờ. */
const SI_POSITION_AT = new Date("2026-08-13T20:11:07.000Z");

function observation(
  type: VesselObservationType,
  source: VesselSource,
  fetchedAt: Date,
  data: object,
  sourceReceivedAt: Date | null = null
): VesselSourceObservation {
  return {
    source,
    type,
    vesselKey: { mmsi: MMSI },
    fetchedAt,
    sourceReceivedAt,
    validation: { status: ObservationValidationStatus.VALID, errors: [] },
    data: { mmsi: MMSI, metadata: createSourceMetadata({ source, fetchedAt, sourceReceivedAt }), ...data },
  } as VesselSourceObservation;
}

/** Kho chứa đúng bộ observation thật của AGIA DOXA. */
async function agiaDoxaStore(): Promise<InMemoryVesselObservationRepository> {
  const store = new InMemoryVesselObservationRepository({ now: () => NOW });

  await store.save(
    observation(VesselObservationType.IDENTITY, VesselSource.SHIPFINDER, SHIPFINDER_AT, {
      imo: "9467976",
      name: "AGIA DOXA",
      callsign: "D5OC7",
      vesselType: "Cargo ship",
      flag: { code: "LBR", name: null },
    })
  );
  await store.save(
    observation(VesselObservationType.IDENTITY, VesselSource.SHIPINFO, SHIPINFO_AT, {
      imo: "9467976",
      name: "Agia Doxa",
      callsign: "D5OC7",
      vesselType: "Bulk Carrier",
      flag: { code: "LR", name: "Liberia" },
    })
  );

  await store.save(
    observation(
      VesselObservationType.POSITION,
      VesselSource.SHIPFINDER,
      SHIPFINDER_AT,
      {
        lat: 33.74968333333333,
        lng: -118.20891666666667,
        speed: 0,
        course: 0.9,
        heading: 58,
        navStatus: { code: null, text: "Moored" },
        latLngApproximate: false,
        receivedAt: SF_POSITION_AT,
      },
      SF_POSITION_AT
    )
  );
  await store.save(
    observation(
      VesselObservationType.POSITION,
      VesselSource.SHIPINFO,
      SHIPINFO_AT,
      {
        lat: 33.74833,
        lng: -118.20833,
        speed: 0,
        course: null,
        heading: null,
        navStatus: null,
        latLngApproximate: false,
        receivedAt: SI_POSITION_AT,
      },
      SI_POSITION_AT
    )
  );

  await store.save(
    observation(VesselObservationType.PARTICULARS, VesselSource.SHIPFINDER, SHIPFINDER_AT, {
      length: 179,
      beam: 29,
      draught: 5.9,
      builtYear: null,
      deadweight: null,
    })
  );
  await store.save(
    observation(VesselObservationType.PARTICULARS, VesselSource.SHIPINFO, SHIPINFO_AT, {
      length: null,
      beam: null,
      draught: null,
      builtYear: 2010,
      deadweight: 33261,
    })
  );

  await store.save(
    observation(VesselObservationType.VOYAGE, VesselSource.SHIPFINDER, SHIPFINDER_AT, {
      destination: "LONG BEACH, US",
      eta: null,
    })
  );

  return store;
}

// ---- ResolveCurrentVoyage --------------------------------------------------

test("ResolveCurrentVoyage · đọc từ kho -> destination của ShipFinder", async () => {
  const store = await agiaDoxaStore();
  const result = await new ResolveCurrentVoyage({ repository: store, now: () => NOW }).execute({
    mmsi: MMSI,
  });

  assert.equal(result?.destination?.value, "LONG BEACH, US");
  assert.equal(result?.destination?.source, VesselSource.SHIPFINDER);
  assert.equal(result?.eta, null);
});

test("ResolveCurrentVoyage · bản ghi ngoài cửa sổ 7 ngày bị bỏ qua", async () => {
  const store = new InMemoryVesselObservationRepository({ now: () => NOW });
  const longAgo = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
  await store.save(
    observation(VesselObservationType.VOYAGE, VesselSource.SHIPFINDER, longAgo, {
      destination: "CHUYẾN CŨ",
    })
  );

  const result = await new ResolveCurrentVoyage({ repository: store, now: () => NOW }).execute({
    mmsi: MMSI,
  });
  assert.equal(result, null);
});

// ---- CA THẬT · AGIA DOXA ghép đủ bốn nhóm ---------------------------------

test("CA THẬT · AGIA DOXA — bốn nhóm ghép đúng, mỗi field giữ xuất xứ", async () => {
  const store = await agiaDoxaStore();
  const result = await new ResolveCurrentVessel({ repository: store, now: () => NOW }).execute({
    mmsi: MMSI,
  });

  assert.ok(result);

  // --- IDENTITY: trộn field, tốt hơn cả hai nguồn đơn lẻ ---
  assert.equal(result.identity?.name?.value, "AGIA DOXA");
  assert.equal(result.identity?.name?.reason, ResolutionReason.SOURCES_AGREE);
  assert.equal(result.identity?.callsign?.reason, ResolutionReason.SOURCES_AGREE);
  assert.equal(result.identity?.vesselType?.value, "Bulk Carrier");
  assert.equal(result.identity?.vesselType?.source, VesselSource.SHIPINFO);
  assert.equal(result.identity?.flagName?.value, "Liberia");
  assert.equal(result.identity?.flagCode?.reason, ResolutionReason.SOURCES_AGREE);

  // --- POSITION: ShipFinder thắng vì mốc NGUỒN tươi hơn ---
  assert.equal(result.position?.source, VesselSource.SHIPFINDER);
  assert.equal(result.position?.reason, ResolutionReason.FRESHER_SOURCE_TIMESTAMP);
  assert.equal(result.position?.observedAt?.toISOString(), SF_POSITION_AT.toISOString());
  assert.equal(result.position?.position.heading, 58);

  // --- PARTICULARS: bù trừ giữa hai nguồn ---
  assert.deepEqual(
    {
      length: [result.particulars?.length?.value, result.particulars?.length?.source],
      beam: [result.particulars?.beam?.value, result.particulars?.beam?.source],
      draught: [result.particulars?.draught?.value, result.particulars?.draught?.source],
      builtYear: [result.particulars?.builtYear?.value, result.particulars?.builtYear?.source],
      deadweight: [result.particulars?.deadweight?.value, result.particulars?.deadweight?.source],
    },
    {
      length: [179, VesselSource.SHIPFINDER],
      beam: [29, VesselSource.SHIPFINDER],
      draught: [5.9, VesselSource.SHIPFINDER],
      builtYear: [2010, VesselSource.SHIPINFO],
      deadweight: [33261, VesselSource.SHIPINFO],
    }
  );
  assert.equal(result.particulars?.grossTonnage, null, "không nguồn nào có -> không bịa");

  // --- VOYAGE ---
  assert.equal(result.voyage?.destination?.value, "LONG BEACH, US");
  assert.equal(result.voyage?.eta, null);

  // --- Metadata của read model ---
  assert.equal(result.resolvedAt.getTime(), NOW.getTime());
  assert.deepEqual(result.vesselKey, { mmsi: MMSI, imo: "9467976" });
});

test("CA THẬT · POSITION giữ NGUYÊN KHỐI — tầng ghép không lấp field", async () => {
  const store = await agiaDoxaStore();
  const result = await new ResolveCurrentVessel({ repository: store, now: () => NOW }).execute({
    mmsi: MMSI,
  });

  // ShipInfo (thua) có speed=0 nhưng course/heading null. Kẻ thắng đi nguyên khối:
  // không nhóm nào được bơm field vào position.
  assert.equal(result?.position?.position.course, 0.9);
  assert.equal(result?.position?.position.navStatus?.text, "Moored");
  // Và position không mượn gì từ identity/particulars/voyage.
  assert.equal("vesselType" in (result?.position?.position ?? {}), false);
  assert.equal("destination" in (result?.position?.position ?? {}), false);
});

test("CA THẬT · provenance KHÔNG bị bóc — mọi field vẫn là ResolvedField", async () => {
  const store = await agiaDoxaStore();
  const result = await new ResolveCurrentVessel({ repository: store, now: () => NOW }).execute({
    mmsi: MMSI,
  });

  const length = result?.particulars?.length;
  assert.ok(length);
  // Không flatten thành `length = 179` trần.
  assert.equal(typeof length.value, "number");
  assert.ok(length.source);
  assert.ok(length.observationId, "truy ngược được về bản ghi gốc");
  assert.ok(length.fetchedAt instanceof Date);
  assert.ok(length.reason);
  assert.ok(Array.isArray(length.rejected));
  assert.equal(length.observedAt, null, "particulars không có mốc nguồn");
});

// ---- Rỗng / một phần -------------------------------------------------------

test("kho rỗng -> null", async () => {
  const store = new InMemoryVesselObservationRepository({ now: () => NOW });
  const result = await new ResolveCurrentVessel({ repository: store, now: () => NOW }).execute({
    mmsi: MMSI,
  });
  assert.equal(result, null);
});

test("chỉ có IDENTITY -> vẫn trả read model, ba nhóm còn lại null", async () => {
  const store = new InMemoryVesselObservationRepository({ now: () => NOW });
  await store.save(
    observation(VesselObservationType.IDENTITY, VesselSource.SHIPFINDER, SHIPFINDER_AT, {
      name: "AGIA DOXA",
    })
  );

  const result = await new ResolveCurrentVessel({ repository: store, now: () => NOW }).execute({
    mmsi: MMSI,
  });

  assert.ok(result);
  assert.equal(result.identity?.name?.value, "AGIA DOXA");
  assert.equal(result.position, null);
  assert.equal(result.particulars, null);
  assert.equal(result.voyage, null);
});

test("resolvedAt là thời điểm CHẠY resolve, không phải max(fetchedAt)", async () => {
  const store = await agiaDoxaStore();
  const later = new Date("2026-08-14T18:30:00.000Z");

  const result = await new ResolveCurrentVessel({ repository: store, now: () => later }).execute({
    mmsi: MMSI,
  });

  assert.equal(result?.resolvedAt.getTime(), later.getTime());
  assert.notEqual(result?.resolvedAt.getTime(), SHIPFINDER_AT.getTime());
});

test("vesselKey · imo được BỔ SUNG từ identity khi khoá tra chưa có", async () => {
  const store = await agiaDoxaStore();
  const result = await new ResolveCurrentVessel({ repository: store, now: () => NOW }).execute({
    mmsi: MMSI,
  });

  assert.equal(result?.vesselKey.mmsi, MMSI);
  assert.equal(result?.vesselKey.imo, "9467976", "lấy từ identity đã phân xử");
});

test("vesselKey · imo người gọi đưa vào KHÔNG bị nguồn ghi đè", async () => {
  const store = new InMemoryVesselObservationRepository({ now: () => NOW });
  const bad = observation(VesselObservationType.IDENTITY, VesselSource.SHIPFINDER, SHIPFINDER_AT, {
    imo: "9999999",
    name: "AGIA DOXA",
  });
  await store.save({ ...bad, vesselKey: { mmsi: MMSI, imo: "9467976" } });

  const result = await new ResolveCurrentVessel({ repository: store, now: () => NOW }).execute({
    mmsi: MMSI,
    imo: "9467976",
  });

  // Identity phân xử ra IMO khác -> khoá tra vẫn giữ nguyên.
  assert.equal(result?.identity?.imo?.value, "9999999");
  assert.equal(result?.vesselKey.imo, "9467976");
});

test("vesselKey · không bịa MMSI khi người gọi chỉ đưa imo", async () => {
  const store = new InMemoryVesselObservationRepository({ now: () => NOW });
  const identity = observation(
    VesselObservationType.IDENTITY,
    VesselSource.SHIPFINDER,
    SHIPFINDER_AT,
    { imo: "9467976", name: "AGIA DOXA" }
  );
  await store.save({ ...identity, vesselKey: { imo: "9467976" } });

  const result = await new ResolveCurrentVessel({ repository: store, now: () => NOW }).execute({
    imo: "9467976",
  });

  assert.equal(result?.identity?.name?.value, "AGIA DOXA");
  assert.equal(result?.vesselKey.imo, "9467976");
  assert.equal(result?.vesselKey.mmsi, undefined);
});

test("use case KHÔNG ghi gì vào kho", async () => {
  const store = await agiaDoxaStore();
  const before = store.size;

  const useCase = new ResolveCurrentVessel({ repository: store, now: () => NOW });
  await useCase.execute({ mmsi: MMSI });
  await useCase.execute({ mmsi: MMSI });

  assert.equal(store.size, before, "resolver chỉ ĐỌC");
});
