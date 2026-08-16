// ============================================================================
//  TEST · ResolveAndStoreCurrentVessel
// ----------------------------------------------------------------------------
//  Chạy đường THẬT: kho observation (InMemory) -> 4 resolver -> kho canonical
//  (InMemory). Không mock resolver — nếu luật phân xử và luật lưu trữ lệch nhau
//  thì test này phải thấy.
//
//  Số liệu lấy từ observation thật của AGIA DOXA sau POC P6.4/P7.4.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurrentVesselSaveResult,
  ICurrentVesselRepository,
} from "../../contracts/repositories/ICurrentVesselRepository";
import { ResolvedCurrentVessel } from "../../services/resolution/ResolvedCurrentVessel";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import {
  VesselObservationType,
  VesselSourceObservation,
} from "../../../domain/entities/VesselObservation";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { InMemoryCurrentVesselRepository } from "../../../infrastructure/persistence/memory/InMemoryCurrentVesselRepository";
import { InMemoryVesselObservationRepository } from "../../../infrastructure/persistence/memory/InMemoryVesselObservationRepository";
import { ResolveCurrentVessel } from "./ResolveCurrentVessel";
import {
  ResolveAndStoreCurrentVessel,
  ResolveAndStoreStatus,
} from "./ResolveAndStoreCurrentVessel";

const MMSI = "636018086";
const IMO = "9467976";
const NOW = new Date("2026-08-14T17:00:00.000Z");
const SF_FETCHED = new Date("2026-08-14T16:40:41.985Z");
const SF_OBSERVED = new Date("2026-08-14T16:39:41.000Z");
const SI_FETCHED = new Date("2026-08-14T10:40:13.307Z");
const SI_OBSERVED = new Date("2026-08-13T20:11:07.000Z");

function observation(
  type: VesselObservationType,
  source: VesselSource,
  fetchedAt: Date,
  data: object,
  sourceReceivedAt: Date | null = null,
  key: { mmsi?: string; imo?: string } = { mmsi: MMSI }
): VesselSourceObservation {
  return {
    source,
    type,
    vesselKey: key,
    fetchedAt,
    sourceReceivedAt,
    validation: { status: ObservationValidationStatus.VALID, errors: [] },
    data: {
      mmsi: MMSI,
      metadata: createSourceMetadata({ source, fetchedAt, sourceReceivedAt }),
      ...data,
    },
  } as VesselSourceObservation;
}

function shipInfoPosition(): VesselSourceObservation {
  return observation(
    VesselObservationType.POSITION,
    VesselSource.SHIPINFO,
    SI_FETCHED,
    {
      lat: 33.74833,
      lng: -118.20833,
      speed: 0,
      course: null,
      heading: null,
      navStatus: null,
      latLngApproximate: false,
      receivedAt: SI_OBSERVED,
    },
    SI_OBSERVED
  );
}

function shipFinderPosition(): VesselSourceObservation {
  return observation(
    VesselObservationType.POSITION,
    VesselSource.SHIPFINDER,
    SF_FETCHED,
    {
      lat: 33.74968333333333,
      lng: -118.20891666666667,
      speed: 0,
      course: 0.9,
      heading: 58,
      navStatus: { code: null, text: "Moored" },
      latLngApproximate: false,
      receivedAt: SF_OBSERVED,
    },
    SF_OBSERVED
  );
}

interface Harness {
  observations: InMemoryVesselObservationRepository;
  current: InMemoryCurrentVesselRepository;
  useCase: ResolveAndStoreCurrentVessel;
  setClock: (at: Date) => void;
}

function harness(): Harness {
  let clock = NOW;
  const now = () => clock;
  const observations = new InMemoryVesselObservationRepository({ now });
  const current = new InMemoryCurrentVesselRepository({ now });
  const useCase = new ResolveAndStoreCurrentVessel({
    resolve: new ResolveCurrentVessel({ repository: observations, now }),
    repository: current,
  });
  return {
    observations,
    current,
    useCase,
    setClock: (at) => {
      clock = at;
    },
  };
}

// ---- CREATE ---------------------------------------------------------------

test("CREATE · có observation -> ghi đúng một document, status CREATED", async () => {
  const h = harness();
  await h.observations.save(
    observation(VesselObservationType.IDENTITY, VesselSource.SHIPFINDER, SF_FETCHED, {
      imo: IMO,
      name: "AGIA DOXA",
      callsign: "D5OC7",
    })
  );
  await h.observations.save(shipFinderPosition());

  const result = await h.useCase.execute({ mmsi: MMSI });

  assert.equal(result.status, ResolveAndStoreStatus.CREATED);
  assert.equal(h.current.size, 1);
  assert.equal(result.vessel?.identity?.name?.value, "AGIA DOXA");
  assert.ok(result.contentHash);

  const stored = await h.current.findByMmsi(MMSI);
  assert.equal(stored?.position?.source, VesselSource.SHIPFINDER);
});

// ---- UPDATE ---------------------------------------------------------------

test("UPDATE · thêm observation TƯƠI hơn -> đổi nguồn vị trí, KHÔNG tạo bản thứ hai", async () => {
  const h = harness();
  // Ban đầu chỉ có ShipInfo, vị trí trễ 14.49 giờ.
  await h.observations.save(shipInfoPosition());
  const first = await h.useCase.execute({ mmsi: MMSI });

  assert.equal(first.status, ResolveAndStoreStatus.CREATED);
  assert.equal(first.vessel?.position?.source, VesselSource.SHIPINFO);

  // Sau đó ShipFinder cho vị trí mới hơn hẳn.
  await h.observations.save(shipFinderPosition());
  h.setClock(new Date("2026-08-14T17:05:00.000Z"));
  const second = await h.useCase.execute({ mmsi: MMSI });

  assert.equal(second.status, ResolveAndStoreStatus.UPDATED);
  assert.equal(h.current.size, 1, "cùng con tàu -> vẫn một document");
  assert.equal(second.id, first.id);

  const stored = await h.current.findByMmsi(MMSI);
  assert.equal(stored?.position?.source, VesselSource.SHIPFINDER);
  assert.equal(stored?.position?.observedAt?.getTime(), SF_OBSERVED.getTime());
  // ShipInfo không biến mất — nó thành kẻ bị loại, có ghi lý do.
  assert.deepEqual(
    stored?.position?.rejected.map((r) => r.source),
    [VesselSource.SHIPINFO]
  );
});

// ---- UPDATE BÙ TRỪ --------------------------------------------------------

test("UPDATE bù trừ · nguồn thứ hai THÊM field, không đè field của nguồn đầu", async () => {
  const h = harness();
  await h.observations.save(
    observation(VesselObservationType.PARTICULARS, VesselSource.SHIPFINDER, SF_FETCHED, {
      length: 179,
      beam: 29,
      draught: 5.9,
    })
  );
  const first = await h.useCase.execute({ mmsi: MMSI });
  assert.equal(first.status, ResolveAndStoreStatus.CREATED);
  assert.equal(first.vessel?.particulars?.builtYear, null);

  await h.observations.save(
    observation(VesselObservationType.PARTICULARS, VesselSource.SHIPINFO, SI_FETCHED, {
      builtYear: 2010,
      deadweight: 33261,
    })
  );
  h.setClock(new Date("2026-08-14T17:05:00.000Z"));
  const second = await h.useCase.execute({ mmsi: MMSI });

  assert.equal(second.status, ResolveAndStoreStatus.UPDATED);
  assert.equal(h.current.size, 1);

  const stored = await h.current.findByMmsi(MMSI);
  // Kích thước VẪN của ShipFinder — ShipInfo không có nên không thể đè.
  assert.equal(stored?.particulars?.length?.value, 179);
  assert.equal(stored?.particulars?.length?.source, VesselSource.SHIPFINDER);
  assert.equal(stored?.particulars?.beam?.source, VesselSource.SHIPFINDER);
  // Hai field mới đến từ ShipInfo.
  assert.equal(stored?.particulars?.builtYear?.value, 2010);
  assert.equal(stored?.particulars?.builtYear?.source, VesselSource.SHIPINFO);
  assert.equal(stored?.particulars?.deadweight?.value, 33261);
  assert.equal(stored?.particulars?.deadweight?.source, VesselSource.SHIPINFO);
});

// ---- IDEMPOTENT -----------------------------------------------------------

test("IDEMPOTENT · cùng observation, `resolvedAt` khác -> UNCHANGED", async () => {
  const h = harness();
  await h.observations.save(shipFinderPosition());
  await h.observations.save(
    observation(VesselObservationType.IDENTITY, VesselSource.SHIPFINDER, SF_FETCHED, {
      name: "AGIA DOXA",
    })
  );

  const first = await h.useCase.execute({ mmsi: MMSI });
  // Keep the resolved position in the same freshness bucket so `resolvedAt`
  // is the only intentionally changing part of the resolved view.
  h.setClock(new Date("2026-08-14T17:05:00.000Z"));
  const second = await h.useCase.execute({ mmsi: MMSI });

  assert.equal(first.status, ResolveAndStoreStatus.CREATED);
  assert.equal(second.status, ResolveAndStoreStatus.UNCHANGED);
  assert.equal(h.current.size, 1);

  // `resolvedAt` ĐÃ khác nhau — chứng minh nó bị bỏ khỏi phép so nội dung.
  assert.notEqual(
    second.vessel?.resolvedAt.getTime(),
    first.vessel?.resolvedAt.getTime()
  );
  assert.equal(second.contentHash, first.contentHash);
  assert.equal(second.updatedAt?.getTime(), first.updatedAt?.getTime());
});

test("IDEMPOTENT · chạy 5 lần vẫn đúng một document", async () => {
  const h = harness();
  await h.observations.save(shipFinderPosition());

  const statuses: string[] = [];
  for (let i = 0; i < 5; i++) {
    h.setClock(new Date(NOW.getTime() + i * 60_000));
    statuses.push((await h.useCase.execute({ mmsi: MMSI })).status);
  }

  assert.deepEqual(statuses, [
    ResolveAndStoreStatus.CREATED,
    ResolveAndStoreStatus.UNCHANGED,
    ResolveAndStoreStatus.UNCHANGED,
    ResolveAndStoreStatus.UNCHANGED,
    ResolveAndStoreStatus.UNCHANGED,
  ]);
  assert.equal(h.current.size, 1);
});

// ---- NO_DATA --------------------------------------------------------------

test("NO_DATA · không có observation -> KHÔNG gọi kho, không tạo bản rỗng", async () => {
  const h = harness();
  let upsertCalls = 0;
  const spy: ICurrentVesselRepository = {
    upsert: async (): Promise<CurrentVesselSaveResult> => {
      upsertCalls++;
      throw new Error("upsert KHÔNG được gọi khi không có dữ liệu");
    },
    findByMmsi: async (): Promise<ResolvedCurrentVessel | null> => null,
    findByImo: async (): Promise<ResolvedCurrentVessel | null> => null,
  };
  const useCase = new ResolveAndStoreCurrentVessel({
    resolve: new ResolveCurrentVessel({ repository: h.observations, now: () => NOW }),
    repository: spy,
  });

  const result = await useCase.execute({ mmsi: "000000000" });

  assert.equal(result.status, ResolveAndStoreStatus.NO_DATA);
  assert.equal(result.vessel, null);
  assert.equal(result.contentHash, undefined);
  assert.equal(upsertCalls, 0);
});

test("NO_DATA · observation quá cũ (ngoài mọi cửa sổ) -> NO_DATA", async () => {
  const h = harness();
  const longAgo = new Date(NOW.getTime() - 200 * 24 * 60 * 60 * 1000);
  await h.observations.save(
    observation(VesselObservationType.IDENTITY, VesselSource.SHIPFINDER, longAgo, {
      name: "AGIA DOXA",
    })
  );

  const result = await h.useCase.execute({ mmsi: MMSI });
  assert.equal(result.status, ResolveAndStoreStatus.NO_DATA);
  assert.equal(h.current.size, 0);
});

// ---- NHÓM THIẾU -----------------------------------------------------------

test("nhóm thiếu · chỉ có identity -> vẫn lưu, ba nhóm còn lại null", async () => {
  const h = harness();
  await h.observations.save(
    observation(VesselObservationType.IDENTITY, VesselSource.SHIPFINDER, SF_FETCHED, {
      imo: IMO,
      name: "AGIA DOXA",
    }, undefined, { mmsi: MMSI, imo: IMO })
  );

  const result = await h.useCase.execute({ mmsi: MMSI });
  assert.equal(result.status, ResolveAndStoreStatus.CREATED);

  const stored = await h.current.findByMmsi(MMSI);
  assert.ok(stored?.identity);
  assert.equal(stored?.position, null);
  assert.equal(stored?.particulars, null);
  assert.equal(stored?.voyage, null);
});

// ---- KHOÁ -----------------------------------------------------------------

test("khoá · IMO phân xử được -> tra bằng IMO cũng ra tàu đó", async () => {
  const h = harness();
  await h.observations.save(
    observation(VesselObservationType.IDENTITY, VesselSource.SHIPFINDER, SF_FETCHED, {
      imo: IMO,
      name: "AGIA DOXA",
    })
  );
  await h.useCase.execute({ mmsi: MMSI });

  const byImo = await h.current.findByImo(IMO);
  assert.equal(byImo?.vesselKey.mmsi, MMSI);
  assert.equal(byImo?.identity?.name?.value, "AGIA DOXA");
});

test("khoá · resolve bằng MMSI rồi bằng IMO KHÔNG sinh document thứ hai", async () => {
  const h = harness();
  await h.observations.save(
    observation(VesselObservationType.IDENTITY, VesselSource.SHIPFINDER, SF_FETCHED, {
      imo: IMO,
      name: "AGIA DOXA",
    }, undefined, { mmsi: MMSI, imo: IMO })
  );

  await h.useCase.execute({ mmsi: MMSI });
  h.setClock(new Date("2026-08-14T17:05:00.000Z"));
  const second = await h.useCase.execute({ imo: IMO });

  assert.equal(h.current.size, 1, "một con tàu, một document");
  assert.equal(second.status, ResolveAndStoreStatus.UPDATED);
});

// ---- KHÔNG ĐỤNG KHO OBSERVATION -------------------------------------------

test("use case KHÔNG ghi thêm gì vào kho observation", async () => {
  const h = harness();
  await h.observations.save(shipFinderPosition());
  const before = h.observations.size;

  await h.useCase.execute({ mmsi: MMSI });
  await h.useCase.execute({ mmsi: MMSI });

  assert.equal(h.observations.size, before, "resolve chỉ ĐỌC observation");
});
