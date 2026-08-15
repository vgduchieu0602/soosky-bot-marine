// ============================================================================
//  TEST · InMemoryCurrentVesselRepository + currentVesselContentHash
// ----------------------------------------------------------------------------
//  Kiểm hợp đồng của kho canonical: upsert (không append), tra bằng MMSI/IMO,
//  idempotency bỏ qua `resolvedAt`, và provenance sống sót qua roundtrip.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { CurrentVesselSaveStatus } from "../../application/current/ICurrentVesselRepository";
import { currentVesselContentHash } from "../../application/current/currentVesselContent";
import { ResolvedCurrentVessel } from "../../application/resolver/ResolvedCurrentVessel";
import { PositionFreshness } from "../../application/resolver/PositionResolverPolicy";
import { RejectionReason, ResolutionReason } from "../../application/resolver/ResolverTypes";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { InMemoryCurrentVesselRepository } from "./InMemoryCurrentVesselRepository";

const MMSI = "636018086";
const IMO = "9467976";
const RESOLVED_AT = new Date("2026-08-14T17:00:00.000Z");
const SF_FETCHED = new Date("2026-08-14T16:40:41.985Z");
const SF_OBSERVED = new Date("2026-08-14T16:39:41.000Z");
const SI_FETCHED = new Date("2026-08-14T10:40:13.307Z");

function vessel(overrides: Partial<ResolvedCurrentVessel> = {}): ResolvedCurrentVessel {
  return {
    vesselKey: { mmsi: MMSI, imo: IMO },
    identity: {
      mmsi: MMSI,
      imo: null,
      name: {
        value: "AGIA DOXA",
        source: VesselSource.SHIPFINDER,
        observationId: "obs-identity-sf",
        observedAt: null,
        fetchedAt: SF_FETCHED,
        reason: ResolutionReason.SOURCES_AGREE,
        rejected: [
          {
            source: VesselSource.SHIPINFO,
            observationId: "obs-identity-si",
            reason: RejectionReason.OLDER_FETCH,
          },
        ],
      },
      callsign: null,
      vesselType: {
        value: "Bulk Carrier",
        source: VesselSource.SHIPINFO,
        observationId: "obs-identity-si",
        observedAt: null,
        fetchedAt: SI_FETCHED,
        reason: ResolutionReason.SOURCE_FIELD_PREFERENCE,
        rejected: [],
      },
      vesselTypeCode: null,
      flagCode: null,
      flagName: null,
    },
    position: {
      position: {
        mmsi: MMSI,
        lat: 33.74968333333333,
        lng: -118.20891666666667,
        speed: 0,
        course: 0.9,
        heading: 58,
        navStatus: { code: null, text: "Moored" },
        latLngApproximate: false,
        receivedAt: SF_OBSERVED,
        metadata: createSourceMetadata({
          source: VesselSource.SHIPFINDER,
          fetchedAt: SF_FETCHED,
          sourceReceivedAt: SF_OBSERVED,
        }),
      },
      source: VesselSource.SHIPFINDER,
      observationId: "obs-position-sf",
      observedAt: SF_OBSERVED,
      fetchedAt: SF_FETCHED,
      freshness: PositionFreshness.LIVE,
      reason: ResolutionReason.FRESHER_SOURCE_TIMESTAMP,
      rejected: [
        {
          source: VesselSource.SHIPINFO,
          observationId: "obs-position-si",
          reason: RejectionReason.STALER_TIMESTAMP,
        },
      ],
    },
    particulars: {
      mmsi: MMSI,
      length: {
        value: 179,
        source: VesselSource.SHIPFINDER,
        observationId: "obs-part-sf",
        observedAt: null,
        fetchedAt: SF_FETCHED,
        reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
        rejected: [],
      },
      beam: null,
      draught: null,
      grossTonnage: null,
      deadweight: null,
      builtYear: {
        value: 2010,
        source: VesselSource.SHIPINFO,
        observationId: "obs-part-si",
        observedAt: null,
        fetchedAt: SI_FETCHED,
        reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
        rejected: [],
      },
    },
    voyage: {
      mmsi: MMSI,
      destination: {
        value: "LONG BEACH, US",
        source: VesselSource.SHIPFINDER,
        observationId: "obs-voyage-sf",
        observedAt: null,
        fetchedAt: SF_FETCHED,
        reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
        rejected: [],
      },
      eta: {
        value: new Date("2026-08-22T09:30:00.000Z"),
        source: VesselSource.SHIPFINDER,
        observationId: "obs-voyage-sf",
        observedAt: null,
        fetchedAt: SF_FETCHED,
        reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
        rejected: [],
      },
      currentPort: null,
      nextPort: null,
      lastPort: null,
      lastPortDepartureAt: null,
    },
    resolvedAt: RESOLVED_AT,
    ...overrides,
  };
}

// ---- Vân tay nội dung -----------------------------------------------------

test("contentHash · `resolvedAt` MỘT MÌNH không đổi vân tay", () => {
  const a = vessel({ resolvedAt: new Date("2026-08-14T17:00:00.000Z") });
  const b = vessel({ resolvedAt: new Date("2026-08-20T03:11:59.000Z") });
  assert.equal(currentVesselContentHash(a), currentVesselContentHash(b));
});

test("contentHash · đổi GIÁ TRỊ thì đổi vân tay", () => {
  const base = vessel();
  const changed = vessel({
    particulars: { ...base.particulars!, length: { ...base.particulars!.length!, value: 180 } },
  });
  assert.notEqual(currentVesselContentHash(base), currentVesselContentHash(changed));
});

test("contentHash · đổi XUẤT XỨ (cùng giá trị) VẪN đổi vân tay", () => {
  const base = vessel();
  // 179 do ShipFinder nói KHÁC 179 do ShipInfo nói — canonical đang trỏ nguồn khác.
  const reSourced = vessel({
    particulars: {
      ...base.particulars!,
      length: { ...base.particulars!.length!, source: VesselSource.SHIPINFO },
    },
  });
  assert.notEqual(currentVesselContentHash(base), currentVesselContentHash(reSourced));
});

test("contentHash · đổi lý do phân xử VẪN đổi vân tay", () => {
  const base = vessel();
  const reReasoned = vessel({
    position: { ...base.position!, reason: ResolutionReason.ONLY_AVAILABLE_VALUE },
  });
  assert.notEqual(currentVesselContentHash(base), currentVesselContentHash(reReasoned));
});

// ---- Upsert ---------------------------------------------------------------

test("lần đầu -> CREATED, đúng một bản ghi", async () => {
  const repo = new InMemoryCurrentVesselRepository({ now: () => RESOLVED_AT });
  const result = await repo.upsert(vessel());

  assert.equal(result.status, CurrentVesselSaveStatus.CREATED);
  assert.equal(repo.size, 1);
  assert.equal(result.createdAt.getTime(), RESOLVED_AT.getTime());
  assert.equal(result.updatedAt.getTime(), RESOLVED_AT.getTime());
});

test("cùng nội dung, `resolvedAt` khác -> UNCHANGED, `updatedAt` KHÔNG đổi", async () => {
  let clock = RESOLVED_AT;
  const repo = new InMemoryCurrentVesselRepository({ now: () => clock });

  const first = await repo.upsert(vessel());
  clock = new Date("2026-08-14T18:30:00.000Z");
  const second = await repo.upsert(vessel({ resolvedAt: new Date("2026-08-14T18:30:00.000Z") }));

  assert.equal(second.status, CurrentVesselSaveStatus.UNCHANGED);
  assert.equal(repo.size, 1, "KHÔNG append bản thứ hai");
  assert.equal(second.updatedAt.getTime(), first.updatedAt.getTime());
  assert.equal(second.id, first.id);
});

test("đổi nội dung -> UPDATED, vẫn một bản ghi, `updatedAt` tiến lên", async () => {
  let clock = RESOLVED_AT;
  const repo = new InMemoryCurrentVesselRepository({ now: () => clock });
  const first = await repo.upsert(vessel());

  const base = vessel();
  clock = new Date("2026-08-14T18:30:00.000Z");
  const second = await repo.upsert(
    vessel({ voyage: { ...base.voyage!, destination: { ...base.voyage!.destination!, value: "VERACRUZ, MX" } } })
  );

  assert.equal(second.status, CurrentVesselSaveStatus.UPDATED);
  assert.equal(repo.size, 1);
  assert.equal(second.id, first.id);
  assert.equal(second.updatedAt.getTime(), clock.getTime());
  assert.equal(second.createdAt.getTime(), first.createdAt.getTime(), "createdAt bất biến");

  const read = await repo.findByMmsi(MMSI);
  assert.equal(read?.voyage?.destination?.value, "VERACRUZ, MX");
});

// ---- Tra cứu --------------------------------------------------------------

test("tra bằng MMSI và bằng IMO đều ra cùng con tàu", async () => {
  const repo = new InMemoryCurrentVesselRepository({ now: () => RESOLVED_AT });
  await repo.upsert(vessel());

  const byMmsi = await repo.findByMmsi(MMSI);
  const byImo = await repo.findByImo(IMO);

  assert.ok(byMmsi);
  assert.ok(byImo);
  assert.deepEqual(byMmsi, byImo);
});

test("tra không thấy -> null, không bịa bản rỗng", async () => {
  const repo = new InMemoryCurrentVesselRepository({ now: () => RESOLVED_AT });
  assert.equal(await repo.findByMmsi("000000000"), null);
  assert.equal(await repo.findByImo("0000000"), null);
});

test("upsert rejects a vessel without a canonical identifier", async () => {
  const repo = new InMemoryCurrentVesselRepository({ now: () => RESOLVED_AT });

  await assert.rejects(repo.upsert(vessel({ vesselKey: {} })), /MMSI.*IMO/);
  assert.equal(repo.size, 0);
});

// ---- Trùng bản ghi --------------------------------------------------------

test("resolve bằng MMSI rồi bằng IMO KHÔNG sinh bản thứ hai", async () => {
  const repo = new InMemoryCurrentVesselRepository({ now: () => RESOLVED_AT });

  await repo.upsert(vessel({ vesselKey: { mmsi: MMSI, imo: IMO } }));
  // Lần sau người gọi chỉ có IMO trong tay.
  const second = await repo.upsert(vessel({ vesselKey: { imo: IMO } }));

  assert.equal(repo.size, 1, "cùng con tàu -> cùng một document");
  assert.equal(second.status, CurrentVesselSaveStatus.UPDATED);
});

test("khoá canonical chỉ được BỔ SUNG, không bị xoá", async () => {
  const repo = new InMemoryCurrentVesselRepository({ now: () => RESOLVED_AT });

  await repo.upsert(vessel({ vesselKey: { mmsi: MMSI, imo: IMO } }));
  // Lần resolve này chưa phân xử được IMO -> khoá thiếu imo.
  await repo.upsert(
    vessel({ vesselKey: { mmsi: MMSI }, resolvedAt: new Date("2026-08-14T18:00:00.000Z") })
  );

  assert.equal(repo.size, 1);
  assert.ok(await repo.findByImo(IMO), "IMO đã biết KHÔNG được mất");
});

// ---- Roundtrip ------------------------------------------------------------

test("ROUNDTRIP · provenance sống sót nguyên vẹn, không chỉ giá trị", async () => {
  const repo = new InMemoryCurrentVesselRepository({ now: () => RESOLVED_AT });
  const original = vessel();
  await repo.upsert(original);

  const read = await repo.findByMmsi(MMSI);
  assert.ok(read);

  const length = read.particulars?.length;
  assert.equal(length?.value, 179);
  assert.equal(length?.source, VesselSource.SHIPFINDER);
  assert.equal(length?.observationId, "obs-part-sf");
  assert.equal(length?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
  assert.equal(length?.observedAt, null);
  assert.equal(length?.fetchedAt.getTime(), SF_FETCHED.getTime());

  // Xuất xứ POSITION đầy đủ, kể cả bậc độ tươi và kẻ bị loại.
  assert.equal(read.position?.source, VesselSource.SHIPFINDER);
  assert.equal(read.position?.observationId, "obs-position-sf");
  assert.equal(read.position?.freshness, PositionFreshness.LIVE);
  assert.equal(read.position?.reason, ResolutionReason.FRESHER_SOURCE_TIMESTAMP);
  assert.deepEqual(
    read.position?.rejected.map((r) => [r.source, r.reason]),
    [[VesselSource.SHIPINFO, RejectionReason.STALER_TIMESTAMP]]
  );

  // Mỗi field giữ nguồn RIÊNG — không bị gom về một `identitySource`.
  assert.equal(read.identity?.name?.source, VesselSource.SHIPFINDER);
  assert.equal(read.identity?.vesselType?.source, VesselSource.SHIPINFO);
  assert.equal(read.particulars?.builtYear?.source, VesselSource.SHIPINFO);

  assert.deepEqual(read, original);
});

test("ROUNDTRIP · Date vẫn là Date, không thành chuỗi", async () => {
  const repo = new InMemoryCurrentVesselRepository({ now: () => RESOLVED_AT });
  await repo.upsert(vessel());
  const read = await repo.findByMmsi(MMSI);

  for (const [label, value] of [
    ["resolvedAt", read?.resolvedAt],
    ["position.observedAt", read?.position?.observedAt],
    ["position.fetchedAt", read?.position?.fetchedAt],
    ["position.position.receivedAt", read?.position?.position.receivedAt],
    ["voyage.eta.value", read?.voyage?.eta?.value],
    ["identity.name.fetchedAt", read?.identity?.name?.fetchedAt],
  ] as const) {
    assert.ok(value instanceof Date, `${label} phải là Date, nhận ${typeof value}`);
  }

  assert.equal(read?.voyage?.eta?.value.toISOString(), "2026-08-22T09:30:00.000Z");
  assert.equal(read?.position?.position.receivedAt.getTime(), SF_OBSERVED.getTime());
});

test("kho trả BẢN SAO — sửa kết quả đọc không đụng được dữ liệu đã lưu", async () => {
  const repo = new InMemoryCurrentVesselRepository({ now: () => RESOLVED_AT });
  await repo.upsert(vessel());

  const read = (await repo.findByMmsi(MMSI)) as { particulars: { length: { value: number } } };
  read.particulars.length.value = 999;

  const again = await repo.findByMmsi(MMSI);
  assert.equal(again?.particulars?.length?.value, 179);
});
