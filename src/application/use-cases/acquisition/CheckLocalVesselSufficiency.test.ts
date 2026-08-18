// ============================================================================
//  TEST · CheckLocalVesselSufficiency
// ----------------------------------------------------------------------------
//  Dùng kho canonical THẬT (InMemory, P8.5) — không mock repository, để nếu
//  chiến lược tra khoá của use case lệch khỏi kho thì test này thấy.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { PositionFreshness } from "../../services/resolution/PositionResolverPolicy";
import { ResolvedCurrentVessel } from "../../services/resolution/ResolvedCurrentVessel";
import { ResolutionReason, ResolvedField } from "../../services/resolution/ResolverTypes";
import { VesselField, VesselFieldGroup } from "../../../domain/enums/VesselField";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { InMemoryCurrentVesselRepository } from "../../../infrastructure/persistence/memory/InMemoryCurrentVesselRepository";
import { DataNeedType, InvalidDataNeedError } from "../../services/acquisition/DataNeed";
import { MissingReason } from "../../services/acquisition/SufficiencyTypes";
import { CheckLocalVesselSufficiency } from "./CheckLocalVesselSufficiency";

const MMSI = "636018086";
const IMO = "9467976";
const NOW = new Date("2026-08-14T17:00:00.000Z");
const FETCHED = new Date("2026-08-14T16:40:41.985Z");

function field<T>(value: T, fetchedAt: Date = FETCHED): ResolvedField<T> {
  return {
    value,
    source: VesselSource.SHIPFINDER,
    observationId: "obs-1",
    observedAt: null,
    fetchedAt,
    reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
    rejected: [],
  };
}

function vessel(overrides: Partial<ResolvedCurrentVessel> = {}): ResolvedCurrentVessel {
  return {
    vesselKey: { mmsi: MMSI, imo: IMO },
    identity: {
      mmsi: MMSI,
      imo: field(IMO),
      name: field("AGIA DOXA"),
      callsign: null,
      vesselType: null,
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
        receivedAt: FETCHED,
        metadata: createSourceMetadata({ source: VesselSource.SHIPFINDER, fetchedAt: FETCHED }),
      },
      source: VesselSource.SHIPFINDER,
      observationId: "obs-position",
      observedAt: FETCHED,
      fetchedAt: FETCHED,
      freshness: PositionFreshness.LIVE,
      reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
      rejected: [],
      motion: null,
    },
    particulars: {
      mmsi: MMSI,
      length: field(179),
      beam: null,
      draught: null,
      grossTonnage: null,
      deadweight: null,
      builtYear: null,
    },
    voyage: null,
    resolvedAt: NOW,
    ...overrides,
  };
}

async function storeWith(v: ResolvedCurrentVessel): Promise<InMemoryCurrentVesselRepository> {
  const repo = new InMemoryCurrentVesselRepository({ now: () => NOW });
  await repo.upsert(v);
  return repo;
}

function useCaseFor(repository: InMemoryCurrentVesselRepository): CheckLocalVesselSufficiency {
  return new CheckLocalVesselSufficiency({ repository, now: () => NOW });
}

// ---- Đường chạy chính -----------------------------------------------------

test("tra bằng MMSI · dữ liệu đủ -> satisfied", async () => {
  const useCase = useCaseFor(await storeWith(vessel()));
  const { sufficiency: result } = await useCase.execute({ mmsi: MMSI }, { type: DataNeedType.POSITION });

  assert.equal(result.satisfied, true);
  assert.deepEqual([...result.missing], []);
});

test("tra bằng IMO · cùng con tàu, cùng kết quả", async () => {
  const useCase = useCaseFor(await storeWith(vessel()));

  const { sufficiency: byMmsi } = await useCase.execute({ mmsi: MMSI }, { type: DataNeedType.IDENTITY });
  const { sufficiency: byImo } = await useCase.execute({ imo: IMO }, { type: DataNeedType.IDENTITY });

  assert.equal(byImo.satisfied, true);
  assert.deepEqual(byImo, byMmsi);
});

test("có cả hai khoá -> MMSI trước, khớp chiến lược của kho", async () => {
  const repo = new InMemoryCurrentVesselRepository({ now: () => NOW });
  await repo.upsert(vessel());

  const { sufficiency: result } = await useCaseFor(repo).execute(
    { mmsi: MMSI, imo: IMO },
    { type: DataNeedType.IDENTITY }
  );
  assert.equal(result.satisfied, true);
});

test("MMSI không có nhưng IMO có -> vẫn tra được", async () => {
  const useCase = useCaseFor(await storeWith(vessel()));
  const { sufficiency: result } = await useCase.execute(
    { mmsi: "000000000", imo: IMO },
    { type: DataNeedType.IDENTITY }
  );
  assert.equal(result.satisfied, true);
});

test("trả kèm vessel đã đọc -> người gọi không phải tra lại", async () => {
  const useCase = useCaseFor(await storeWith(vessel()));
  const { sufficiency, vessel: read } = await useCase.execute(
    { mmsi: MMSI },
    { type: DataNeedType.POSITION }
  );

  assert.equal(sufficiency.satisfied, true);
  assert.equal(read?.identity?.name?.value, "AGIA DOXA");
  assert.equal(read?.position?.source, VesselSource.SHIPFINDER);
});

test("kho rỗng -> vessel null, KHÔNG ném", async () => {
  const useCase = useCaseFor(new InMemoryCurrentVesselRepository({ now: () => NOW }));
  const { vessel: read } = await useCase.execute({ mmsi: MMSI }, { type: DataNeedType.POSITION });
  assert.equal(read, null);
});

// ---- Chưa có tàu ----------------------------------------------------------

test("kho rỗng -> NO_CURRENT_VESSEL, KHÔNG ném lỗi", async () => {
  const useCase = useCaseFor(new InMemoryCurrentVesselRepository({ now: () => NOW }));
  const { sufficiency: result } = await useCase.execute({ mmsi: MMSI }, { type: DataNeedType.FULL });

  assert.equal(result.satisfied, false);
  assert.deepEqual([...result.missing], [{ reason: MissingReason.NO_CURRENT_VESSEL }]);
});

// ---- Thiếu thật -----------------------------------------------------------

test("voyage null -> FULL thiếu nhóm voyage", async () => {
  const useCase = useCaseFor(await storeWith(vessel()));
  const { sufficiency: result } = await useCase.execute({ mmsi: MMSI }, { type: DataNeedType.FULL });

  assert.equal(result.satisfied, false);
  assert.deepEqual(
    [...result.missing],
    [{ group: VesselFieldGroup.VOYAGE, reason: MissingReason.MISSING_GROUP }]
  );
});

test("builtYear chỉ đích danh -> báo thiếu qua đường kho thật", async () => {
  const useCase = useCaseFor(await storeWith(vessel()));
  const { sufficiency: result } = await useCase.execute(
    { mmsi: MMSI },
    { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.BUILT_YEAR] }
  );

  assert.equal(result.satisfied, false);
  assert.equal(result.missing[0]?.field, VesselField.BUILT_YEAR);
});

// ---- Đầu vào sai ----------------------------------------------------------

test("khoá rỗng -> ném lỗi, KHÔNG truy vấn kho", async () => {
  let lookups = 0;
  const repo = new InMemoryCurrentVesselRepository({ now: () => NOW });
  const spied = {
    upsert: repo.upsert.bind(repo),
    findByMmsi: async (mmsi: string) => {
      lookups++;
      return repo.findByMmsi(mmsi);
    },
    findByImo: async (imo: string) => {
      lookups++;
      return repo.findByImo(imo);
    },
  };

  await assert.rejects(
    () =>
      new CheckLocalVesselSufficiency({ repository: spied, now: () => NOW }).execute(
        {},
        { type: DataNeedType.POSITION }
      ),
    /MMSI hoặc IMO/
  );
  assert.equal(lookups, 0);
});

test("need sai nhóm -> InvalidDataNeedError", async () => {
  const useCase = useCaseFor(await storeWith(vessel()));
  await assert.rejects(
    () =>
      useCase.execute(
        { mmsi: MMSI },
        { type: DataNeedType.POSITION, requiredFields: [VesselField.BUILT_YEAR] }
      ),
    InvalidDataNeedError
  );
});

// ---- Ranh giới ------------------------------------------------------------

test("use case KHÔNG ghi gì vào kho", async () => {
  const repo = await storeWith(vessel());
  const before = repo.size;
  const useCase = useCaseFor(repo);

  await useCase.execute({ mmsi: MMSI }, { type: DataNeedType.FULL });
  await useCase.execute({ mmsi: MMSI }, { type: DataNeedType.POSITION });

  assert.equal(repo.size, before, "chỉ ĐỌC");
});

test("`now` tiêm vào -> cùng dữ liệu, đồng hồ khác, kết quả khác", async () => {
  const repo = await storeWith(
    vessel({
      voyage: {
        mmsi: MMSI,
        destination: field("LONG BEACH, US"),
        eta: null,
        currentPort: null,
        nextPort: null,
        lastPort: null,
        lastPortDepartureAt: null,
      },
    })
  );

  const atNow = new CheckLocalVesselSufficiency({ repository: repo, now: () => NOW });
  assert.equal(
    (await atNow.execute({ mmsi: MMSI }, { type: DataNeedType.VOYAGE })).sufficiency.satisfied,
    true
  );

  const later = new Date(NOW.getTime() + 8 * 60 * 60 * 1000);
  const atLater = new CheckLocalVesselSufficiency({ repository: repo, now: () => later });
  const { sufficiency: result } = await atLater.execute({ mmsi: MMSI }, { type: DataNeedType.VOYAGE });

  assert.equal(result.satisfied, false);
  assert.equal(result.missing[0]?.reason, MissingReason.VOYAGE_TOO_OLD);
});
