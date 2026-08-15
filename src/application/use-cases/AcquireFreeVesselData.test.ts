// ============================================================================
//  TEST · AcquireFreeVesselData
// ----------------------------------------------------------------------------
//  Giả lập ĐÚNG MỘT thứ: provider (thay cho mạng). Còn lại là code thật —
//  selector thật, sufficiency thật, P4 runtime thật, ObservationRecorder thật,
//  bốn resolver thật, hai kho InMemory thật.
//
//  Mock cả pipeline thì test chỉ chứng minh các mock gọi nhau đúng thứ tự. Ở
//  đây nếu luật của bất kỳ tầng nào lệch nhau, test này phải thấy.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselIdentity } from "../../domain/canonical/VesselIdentity";
import { VesselParticulars } from "../../domain/canonical/VesselParticulars";
import { VesselPositionReport } from "../../domain/canonical/VesselPositionReport";
import { VesselVoyage } from "../../domain/canonical/VesselVoyage";
import { VesselField } from "../../domain/value-objects/VesselField";
import { VesselIdentifier } from "../../domain/value-objects/VesselIdentifier";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { InMemoryCurrentVesselRepository } from "../../infrastructure/persistence/InMemoryCurrentVesselRepository";
import { InMemoryVesselObservationRepository } from "../../infrastructure/persistence/InMemoryVesselObservationRepository";
import { AcquisitionOutcome } from "../acquisition/AcquisitionAttempt";
import { DataNeed, DataNeedType } from "../acquisition/DataNeed";
import { FreeSourceSelector } from "../acquisition/FreeSourceSelector";
import { ObservationRecorder } from "../observations/ObservationRecorder";
import { ProviderRegistry } from "../providers/ProviderRegistry";
import {
  ProviderDetailsResult,
  ProviderPositionResult,
} from "../providers/ProviderResults";
import { VesselDataProvider } from "../providers/VesselDataProvider";
import { SourceErrorCategory, SourceRequestError } from "../runtime/SourceError";
import { SourceHealthState } from "../runtime/SourceHealthTracker";
import { SourceRuntimeManager } from "../runtime/SourceRuntimeManager";
import { ResolveCurrentVessel } from "./ResolveCurrentVessel";
import { AcquireFreeVesselData, AcquisitionStopReason } from "./AcquireFreeVesselData";
import { CheckLocalVesselSufficiency } from "./CheckLocalVesselSufficiency";
import { CollectVesselObservations } from "./CollectVesselObservations";
import { ResolveAndStoreCurrentVessel } from "./ResolveAndStoreCurrentVessel";

const MMSI = "636018086";
const NOW = new Date("2026-08-14T17:00:00.000Z");
/** 1 phút trước NOW -> bậc LIVE. */
const FRESH_AT = new Date(NOW.getTime() - 60 * 1000);
/** 14.5 giờ trước -> bậc STALE, đúng độ trễ đo được của ShipInfo. */
const STALE_AT = new Date(NOW.getTime() - 14.5 * 60 * 60 * 1000);

// ---- canonical dựng sẵn ----------------------------------------------------

function metadata(source: VesselSource, sourceReceivedAt?: Date) {
  return createSourceMetadata({ source, fetchedAt: NOW, sourceReceivedAt });
}

function identity(source: VesselSource, name: string): VesselIdentity {
  return { mmsi: MMSI, name, callsign: "D5OC7", metadata: metadata(source) };
}

function position(source: VesselSource, observedAt: Date): VesselPositionReport {
  return {
    mmsi: MMSI,
    lat: 33.74968333333333,
    lng: -118.20891666666667,
    speed: 0,
    course: 0.9,
    heading: 58,
    navStatus: { code: null, text: "Moored" },
    latLngApproximate: false,
    receivedAt: observedAt,
    metadata: metadata(source, observedAt),
  };
}

function dimensions(source: VesselSource): VesselParticulars {
  return { mmsi: MMSI, length: 179, beam: 29, draught: 5.9, metadata: metadata(source) };
}

function registryData(source: VesselSource): VesselParticulars {
  return { mmsi: MMSI, builtYear: 2010, deadweight: 33261, metadata: metadata(source) };
}

function voyage(source: VesselSource, destination: string): VesselVoyage {
  return { mmsi: MMSI, destination, eta: null, metadata: metadata(source) };
}

// ---- provider giả ----------------------------------------------------------

type DetailsBehavior = () => ProviderDetailsResult | null;
type PositionBehavior = () => ProviderPositionResult | null;

interface ProviderCall {
  source: VesselSource;
  operation: "GET_DETAILS" | "GET_POSITION";
  identifier: VesselIdentifier;
}

class FakeProvider implements VesselDataProvider {
  constructor(
    readonly source: VesselSource,
    private readonly log: ProviderCall[],
    private readonly behavior: { details?: DetailsBehavior; position?: PositionBehavior }
  ) {}

  async getDetails(identifier: VesselIdentifier): Promise<ProviderDetailsResult | null> {
    this.log.push({ source: this.source, operation: "GET_DETAILS", identifier });
    if (this.behavior.details === undefined) return null;
    return this.behavior.details();
  }

  async getPosition(identifier: VesselIdentifier): Promise<ProviderPositionResult | null> {
    this.log.push({ source: this.source, operation: "GET_POSITION", identifier });
    if (this.behavior.position === undefined) return null;
    return this.behavior.position();
  }
}

/** Trả `null` (NOT_FOUND) ở n lần đầu, sau đó trả `value`. */
function notFoundThen<T>(times: number, value: () => T): () => T | null {
  let seen = 0;
  return () => (seen++ < times ? null : value());
}

/** Ném lỗi đã phân loại ở n lần đầu, sau đó trả `value`. */
function failThen<T>(times: number, category: SourceErrorCategory, value: () => T): () => T {
  let seen = 0;
  return () => {
    if (seen++ < times) {
      throw new SourceRequestError({ category, source: VesselSource.SHIPFINDER, message: "giả lập" });
    }
    return value();
  };
}

// ---- lắp ráp ---------------------------------------------------------------

interface Harness {
  acquire: AcquireFreeVesselData;
  currentRepo: InMemoryCurrentVesselRepository;
  observationRepo: InMemoryVesselObservationRepository;
  calls: ProviderCall[];
  resolveCalls: () => number;
}

function harness(
  providers: readonly { source: VesselSource; details?: DetailsBehavior; position?: PositionBehavior }[],
  options: {
    healthOf?: (source: VesselSource) => SourceHealthState;
    maxAttemptsPerRequest?: number;
  } = {}
): Harness {
  const now = () => NOW;
  const calls: ProviderCall[] = [];

  const registry = new ProviderRegistry();
  for (const spec of providers) {
    registry.register(new FakeProvider(spec.source, calls, spec));
  }

  const observationRepo = new InMemoryVesselObservationRepository({ now });
  const currentRepo = new InMemoryCurrentVesselRepository({ now });

  const collect = new CollectVesselObservations({
    registry,
    // sleep no-op: nhịp nghỉ 3–8s của P4 là thật, chỉ không muốn test chờ thật.
    runtime: new SourceRuntimeManager({ sleep: async () => undefined }),
    recorder: new ObservationRecorder({ repository: observationRepo }),
  });

  let resolveCalls = 0;
  const inner = new ResolveAndStoreCurrentVessel({
    resolve: new ResolveCurrentVessel({ repository: observationRepo, now }),
    repository: currentRepo,
  });
  const resolveAndStore = {
    execute: async (key: Parameters<typeof inner.execute>[0]) => {
      resolveCalls++;
      return inner.execute(key);
    },
  } as ResolveAndStoreCurrentVessel;

  const acquire = new AcquireFreeVesselData({
    checkLocal: new CheckLocalVesselSufficiency({ repository: currentRepo, now }),
    selector: new FreeSourceSelector(),
    collect,
    resolveAndStore,
    healthOf: options.healthOf ?? (() => SourceHealthState.HEALTHY),
    now,
    policy:
      options.maxAttemptsPerRequest === undefined
        ? undefined
        : { maxAttemptsPerRequest: options.maxAttemptsPerRequest },
  });

  return { acquire, currentRepo, observationRepo, calls, resolveCalls: () => resolveCalls };
}

/** ShipFinder đầy đủ: identity + vị trí TƯƠI + kích thước + cảng đích. */
function shipFinderFull(): ProviderDetailsResult {
  return {
    identity: identity(VesselSource.SHIPFINDER, "AGIA DOXA"),
    position: position(VesselSource.SHIPFINDER, FRESH_AT),
    particulars: dimensions(VesselSource.SHIPFINDER),
    voyage: voyage(VesselSource.SHIPFINDER, "LONG BEACH, US"),
  };
}

/** ShipInfo: identity + lý lịch (builtYear/deadweight) + vị trí TRỄ 14.5 giờ. */
function shipInfoFull(): ProviderDetailsResult {
  return {
    identity: identity(VesselSource.SHIPINFO, "Agia Doxa"),
    position: position(VesselSource.SHIPINFO, STALE_AT),
    particulars: registryData(VesselSource.SHIPINFO),
  };
}

/** Hai nguồn "khoẻ mạnh", cấp được cả `getDetails` lẫn `getPosition`. */
const SHIPFINDER_OK = {
  source: VesselSource.SHIPFINDER,
  details: shipFinderFull,
  position: () => ({ position: position(VesselSource.SHIPFINDER, FRESH_AT) }),
};
const SHIPINFO_OK = {
  source: VesselSource.SHIPINFO,
  details: shipInfoFull,
  position: () => ({ position: position(VesselSource.SHIPINFO, STALE_AT) }),
};

const NEED_POSITION: DataNeed = { type: DataNeedType.POSITION };

// ---- LOCAL-FIRST ----------------------------------------------------------

test("LOCAL đã đủ -> 0 request mạng, 0 resolve, attempts rỗng", async () => {
  const h = harness([SHIPFINDER_OK]);

  // Nạp canonical bằng một lượt acquisition thật.
  await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);
  const callsAfterWarmup = h.calls.length;
  const resolvesAfterWarmup = h.resolveCalls();

  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);

  assert.equal(result.satisfied, true);
  assert.equal(result.stopReason, AcquisitionStopReason.LOCAL_DATA_SUFFICIENT);
  assert.deepEqual([...result.attempts], []);
  assert.equal(h.calls.length, callsAfterWarmup, "KHÔNG chạm nguồn lần nào");
  assert.equal(h.resolveCalls(), resolvesAfterWarmup, "KHÔNG resolve lại");
  assert.ok(result.vessel, "vẫn trả canonical, người gọi không phải tra lại");
});

// ---- MỘT NGUỒN ------------------------------------------------------------

test("vị trí cũ -> ShipFinder một lần rồi DỪNG · ca thật", async () => {
  const h = harness([
    { source: VesselSource.SHIPFINDER, details: shipFinderFull, position: () => ({ position: position(VesselSource.SHIPFINDER, FRESH_AT) }) },
    { source: VesselSource.SHIPINFO, details: shipInfoFull },
  ]);

  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);

  assert.equal(result.satisfied, true);
  assert.equal(result.stopReason, AcquisitionStopReason.SATISFIED_AFTER_ACQUISITION);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.source, VesselSource.SHIPFINDER);
  assert.equal(result.attempts[0]?.outcome, AcquisitionOutcome.SUCCESS);
  // ShipInfo KHÔNG bị gọi dù defaultPriority tốt hơn — vị trí nó trễ 14.5 giờ.
  assert.deepEqual([...new Set(h.calls.map((c) => c.source))], [VesselSource.SHIPFINDER]);
  assert.equal(result.vessel?.position?.source, VesselSource.SHIPFINDER);
});

test("chỉ thiếu vị trí -> dùng GET_POSITION theo đúng plan", async () => {
  const h = harness([
    {
      source: VesselSource.SHIPFINDER,
      position: () => ({ position: position(VesselSource.SHIPFINDER, FRESH_AT) }),
    },
  ]);

  await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);

  assert.equal(h.calls[0]?.operation, "GET_POSITION");
  assert.deepEqual(h.calls[0]?.identifier, { type: "MMSI", value: MMSI });
});

test("builtYear -> ShipInfo, KHÔNG gọi lại ShipFinder · ca thật", async () => {
  const h = harness([SHIPFINDER_OK, SHIPINFO_OK]);

  // Canonical đã có kích thước của ShipFinder, thiếu builtYear — đúng trạng
  // thái sau POC P7.4. Xin đích danh LENGTH để chắc chắn nguồn lấp là
  // ShipFinder: ShipInfo UNSUPPORTED kích thước (đảo số không nhất quán).
  await h.acquire.execute(
    { mmsi: MMSI },
    { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.LENGTH] }
  );
  const callsBefore = h.calls.length;
  assert.equal(h.currentRepo.size, 1);
  assert.equal(
    (await h.currentRepo.findByMmsi(MMSI))?.particulars?.builtYear ?? null,
    null,
    "chưa có builtYear -> đúng tiền đề của ca này"
  );

  const result = await h.acquire.execute(
    { mmsi: MMSI },
    { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.BUILT_YEAR] }
  );

  assert.equal(result.satisfied, true);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.source, VesselSource.SHIPINFO);
  assert.deepEqual(
    h.calls.slice(callsBefore).map((c) => c.source),
    [VesselSource.SHIPINFO],
    "ShipFinder vừa cấp kích thước không có nghĩa nó cấp được builtYear"
  );
  assert.equal(result.vessel?.particulars?.builtYear?.value, 2010);
  assert.equal(result.vessel?.particulars?.length?.source, VesselSource.SHIPFINDER);
});

// ---- NOT_FOUND / lỗi -------------------------------------------------------

test("NOT_FOUND rồi nguồn khác thành công -> 2 attempt, KHÔNG ném", async () => {
  const h = harness([
    { source: VesselSource.SHIPFINDER, position: () => null, details: () => null },
    {
      source: VesselSource.SHIPINFO,
      details: shipInfoFull,
      position: () => ({ position: position(VesselSource.SHIPINFO, STALE_AT) }),
    },
  ]);

  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);

  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0]?.outcome, AcquisitionOutcome.NOT_FOUND);
  assert.equal(result.attempts[1]?.source, VesselSource.SHIPINFO);
  assert.equal(result.attempts[1]?.outcome, AcquisitionOutcome.SUCCESS);
  // ShipInfo trả về được, nhưng trễ 14.5h nên vẫn chưa đủ cho need POSITION.
  assert.equal(result.satisfied, false);
});

test("NOT_FOUND -> KHÔNG resolve/store cho vòng đó", async () => {
  const h = harness([{ source: VesselSource.SHIPFINDER, position: () => null }]);

  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);

  assert.equal(result.attempts[0]?.outcome, AcquisitionOutcome.NOT_FOUND);
  assert.equal(h.resolveCalls(), 0, "không observation mới -> không có gì để phân xử");
  assert.equal(h.currentRepo.size, 0);
});

test("lỗi mạng rồi nguồn khác -> FAILED kèm mã, rồi SUCCESS", async () => {
  const h = harness([
    {
      source: VesselSource.SHIPFINDER,
      position: failThen(5, SourceErrorCategory.NETWORK_ERROR, () => ({
        position: position(VesselSource.SHIPFINDER, FRESH_AT),
      })),
    },
    {
      source: VesselSource.SHIPINFO,
      position: () => ({ position: position(VesselSource.SHIPINFO, STALE_AT) }),
    },
  ]);

  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);

  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0]?.outcome, AcquisitionOutcome.FAILED);
  assert.equal(result.attempts[0]?.failureCode, SourceErrorCategory.NETWORK_ERROR);
  assert.equal(result.attempts[1]?.source, VesselSource.SHIPINFO);
  assert.equal(result.attempts[1]?.outcome, AcquisitionOutcome.SUCCESS);
});

test("nguồn hỏng KHÔNG làm chết cả lượt", async () => {
  const h = harness([
    {
      source: VesselSource.SHIPFINDER,
      position: failThen(9, SourceErrorCategory.BLOCKED, () => null as never),
    },
  ]);

  // Không ném ra ngoài — "chưa đủ dữ liệu" là câu trả lời hợp lệ.
  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);
  assert.equal(result.satisfied, false);
  assert.equal(result.attempts[0]?.failureCode, SourceErrorCategory.BLOCKED);
});

test("nguồn không có provider -> FAILED · NO_PROVIDER, đi tiếp nguồn khác", async () => {
  // Registry chỉ có ShipInfo; matrix vẫn coi ShipFinder là ứng viên vị trí.
  const h = harness([
    {
      source: VesselSource.SHIPINFO,
      position: () => ({ position: position(VesselSource.SHIPINFO, STALE_AT) }),
    },
  ]);

  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);

  assert.equal(result.attempts[0]?.source, VesselSource.SHIPFINDER);
  assert.equal(result.attempts[0]?.outcome, AcquisitionOutcome.FAILED);
  assert.equal(result.attempts[0]?.failureCode, "NO_PROVIDER");
  assert.equal(result.attempts[1]?.source, VesselSource.SHIPINFO);
});

// ---- Trùng lặp ------------------------------------------------------------

test("dữ liệu trùng (dedupe) -> vẫn là SUCCESS, và KHÔNG gọi lại nguồn đó", async () => {
  const h = harness([
    {
      source: VesselSource.SHIPFINDER,
      position: () => ({ position: position(VesselSource.SHIPFINDER, STALE_AT) }),
    },
    {
      source: VesselSource.SHIPINFO,
      position: () => ({ position: position(VesselSource.SHIPINFO, STALE_AT) }),
    },
  ]);

  // Lượt 1: ShipFinder ghi được observation nhưng vị trí vẫn STALE -> chưa đủ.
  const first = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);
  assert.equal(first.attempts[0]?.outcome, AcquisitionOutcome.SUCCESS);
  assert.equal(first.satisfied, false);

  // Lượt 2: ShipFinder trả Y HỆT -> dedupe -> không observation mới.
  const second = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);
  const shipFinderAttempts = second.attempts.filter(
    (a) => a.source === VesselSource.SHIPFINDER
  );
  assert.equal(shipFinderAttempts.length, 1, "trong MỘT lượt không gọi lại cùng nguồn");
  assert.equal(shipFinderAttempts[0]?.outcome, AcquisitionOutcome.SUCCESS);
});

// ---- Ngân sách ------------------------------------------------------------

test("ngân sách 2 · cả hai không đủ -> đúng 2 lần chạm nguồn", async () => {
  const h = harness(
    [
      {
        source: VesselSource.SHIPFINDER,
        position: () => ({ position: position(VesselSource.SHIPFINDER, STALE_AT) }),
      },
      {
        source: VesselSource.SHIPINFO,
        position: () => ({ position: position(VesselSource.SHIPINFO, STALE_AT) }),
      },
      {
        source: VesselSource.VESSELFINDER,
        position: () => ({ position: position(VesselSource.VESSELFINDER, STALE_AT) }),
      },
    ],
    { maxAttemptsPerRequest: 2 }
  );

  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);

  assert.equal(result.attempts.length, 2);
  assert.equal(h.calls.length, 2);
  assert.equal(result.stopReason, AcquisitionStopReason.ATTEMPT_BUDGET_EXHAUSTED);
  assert.equal(result.satisfied, false);
});

test("lỗi cũng TIÊU ngân sách — nguồn hỏng không được thử vô hạn", async () => {
  const h = harness(
    [
      {
        source: VesselSource.SHIPFINDER,
        position: failThen(9, SourceErrorCategory.TIMEOUT, () => null as never),
      },
      {
        source: VesselSource.SHIPINFO,
        position: failThen(9, SourceErrorCategory.TIMEOUT, () => null as never),
      },
    ],
    { maxAttemptsPerRequest: 2 }
  );

  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.stopReason, AcquisitionStopReason.ATTEMPT_BUDGET_EXHAUSTED);
});

// ---- Không còn nguồn ------------------------------------------------------

test("ETA · không nguồn free nào CONFIRMED -> 0 request · ca bắt buộc", async () => {
  const h = harness([SHIPFINDER_OK, SHIPINFO_OK]);

  // Canonical đã có `destination` của ShipFinder, `eta` null — đúng ca thật:
  // nguồn cho "07-29 07:01" thiếu năm nên mapper cố ý không map.
  await h.acquire.execute({ mmsi: MMSI }, { type: DataNeedType.VOYAGE });
  assert.equal(h.currentRepo.size, 1);
  const callsBefore = h.calls.length;

  const result = await h.acquire.execute(
    { mmsi: MMSI },
    { type: DataNeedType.VOYAGE, requiredFields: [VesselField.ETA] }
  );

  assert.equal(result.stopReason, AcquisitionStopReason.NO_FREE_SOURCE_AVAILABLE);
  assert.equal(result.satisfied, false);
  assert.equal(h.calls.length, callsBefore, "KHÔNG gọi bừa một nguồn nào");
  assert.deepEqual([...result.attempts], []);
  // ⚠️ Hết nguồn free KHÔNG mở đường cho nguồn trả tiền: kết quả là
  // `satisfied: false`, không phải một plan MyShipTracking.
  assert.equal(
    result.attempts.some((a) => a.source === VesselSource.MYSHIPTRACKING),
    false
  );
});

test("thử hết nguồn hợp lệ -> NO_FREE_SOURCE_AVAILABLE, không phải hết ngân sách", async () => {
  const h = harness(
    [
      {
        source: VesselSource.SHIPFINDER,
        position: () => ({ position: position(VesselSource.SHIPFINDER, STALE_AT) }),
      },
    ],
    { maxAttemptsPerRequest: 5 }
  );

  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);

  assert.equal(result.stopReason, AcquisitionStopReason.NO_FREE_SOURCE_AVAILABLE);
  // ShipFinder + ShipInfo (ứng viên vị trí duy nhất còn lại, không có provider).
  assert.ok(result.attempts.length < 5);
});

// ---- Cooldown -------------------------------------------------------------

test("nguồn COOLDOWN · orchestrator KHÔNG override", async () => {
  const h = harness(
    [
      { source: VesselSource.SHIPFINDER, position: () => ({ position: position(VesselSource.SHIPFINDER, FRESH_AT) }) },
      { source: VesselSource.SHIPINFO, position: () => ({ position: position(VesselSource.SHIPINFO, STALE_AT) }) },
    ],
    {
      healthOf: (source) =>
        source === VesselSource.SHIPFINDER
          ? SourceHealthState.COOLDOWN
          : SourceHealthState.HEALTHY,
    }
  );

  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);

  assert.equal(
    h.calls.some((call) => call.source === VesselSource.SHIPFINDER),
    false,
    "KHÔNG chạm nguồn đang hạ nhiệt"
  );
  assert.equal(result.attempts[0]?.source, VesselSource.SHIPINFO);
});

// ---- FULL hai nguồn · BẮT BUỘC --------------------------------------------

test("FULL · ShipFinder rồi ShipInfo, đúng 2 request · ca bắt buộc", async () => {
  const h = harness([SHIPFINDER_OK, SHIPINFO_OK]);

  const result = await h.acquire.execute(
    { mmsi: MMSI },
    { type: DataNeedType.FULL, requiredFields: [VesselField.BUILT_YEAR] }
  );

  assert.equal(result.satisfied, true);
  assert.equal(result.stopReason, AcquisitionStopReason.SATISFIED_AFTER_ACQUISITION);
  assert.deepEqual(
    result.attempts.map((a) => [a.source, a.outcome]),
    [
      [VesselSource.SHIPFINDER, AcquisitionOutcome.SUCCESS],
      [VesselSource.SHIPINFO, AcquisitionOutcome.SUCCESS],
    ]
  );
  assert.equal(h.calls.length, 2, "không có request thứ ba");

  // Canonical trộn từ HAI nguồn — thứ không nguồn nào tự mình cho được.
  const vessel = result.vessel;
  assert.equal(vessel?.position?.source, VesselSource.SHIPFINDER);
  assert.equal(vessel?.particulars?.length?.source, VesselSource.SHIPFINDER);
  assert.equal(vessel?.particulars?.builtYear?.source, VesselSource.SHIPINFO);
  assert.equal(vessel?.voyage?.destination?.value, "LONG BEACH, US");
});

test("FULL · nguồn thứ hai được chọn vì nguồn đầu ĐÃ THỬ trong lượt này", async () => {
  const h = harness([SHIPFINDER_OK, SHIPINFO_OK]);

  const result = await h.acquire.execute(
    { mmsi: MMSI },
    { type: DataNeedType.FULL, requiredFields: [VesselField.BUILT_YEAR] }
  );

  const shipFinderCalls = h.calls.filter((c) => c.source === VesselSource.SHIPFINDER);
  assert.equal(shipFinderCalls.length, 1, "không gọi lại nguồn đã thử");
  assert.equal(result.attempts.every((a) => a.scope === "CURRENT_REQUEST"), true);
});

// ---- Trace ----------------------------------------------------------------

test("attempt mang đủ thông tin để truy vết", async () => {
  const h = harness([
    { source: VesselSource.SHIPFINDER, position: () => ({ position: position(VesselSource.SHIPFINDER, FRESH_AT) }) },
  ]);

  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);
  const attempt = result.attempts[0];

  assert.ok(attempt);
  assert.equal(attempt.source, VesselSource.SHIPFINDER);
  assert.equal(attempt.operation, "GET_POSITION");
  assert.deepEqual(attempt.vesselKey, { mmsi: MMSI });
  assert.equal(attempt.attemptedAt.getTime(), NOW.getTime());
  assert.equal(attempt.failureCode, undefined);
  assert.deepEqual(
    [...(attempt.targetFields ?? [])],
    [VesselField.LAT, VesselField.LNG, VesselField.POSITION_RECEIVED_AT]
  );
});

test("sufficiency cuối cùng nói RÕ còn thiếu gì", async () => {
  const h = harness([
    { source: VesselSource.SHIPINFO, position: () => ({ position: position(VesselSource.SHIPINFO, STALE_AT) }) },
  ]);

  const result = await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);

  assert.equal(result.satisfied, false);
  assert.equal(result.sufficiency.missing[0]?.reason, "POSITION_NOT_FRESH_ENOUGH");
  assert.ok(result.vessel, "vẫn trả dữ liệu tốt nhất dù chưa đủ");
});

// ---- Ranh giới ------------------------------------------------------------

test("resolve/store được gọi ĐÚNG một lần cho mỗi observation mới", async () => {
  const h = harness([SHIPFINDER_OK, SHIPINFO_OK]);

  await h.acquire.execute(
    { mmsi: MMSI },
    { type: DataNeedType.FULL, requiredFields: [VesselField.BUILT_YEAR] }
  );

  assert.equal(h.resolveCalls(), 2, "hai lần lấy được dữ liệu mới -> hai lần phân xử");
});

test("khoá rỗng -> ném, KHÔNG chạm nguồn", async () => {
  const h = harness([SHIPFINDER_OK]);

  await assert.rejects(() => h.acquire.execute({}, NEED_POSITION), /MMSI hoặc IMO/);
  assert.equal(h.calls.length, 0);
});

test("need sai nhóm -> ném, KHÔNG chạm nguồn", async () => {
  const h = harness([SHIPFINDER_OK]);

  await assert.rejects(
    () =>
      h.acquire.execute(
        { mmsi: MMSI },
        { type: DataNeedType.POSITION, requiredFields: [VesselField.BUILT_YEAR] }
      ),
    /không dùng được với need/
  );
  assert.equal(h.calls.length, 0);
});

test("KHÔNG ghi vào kho legacy — chỉ observation + canonical", async () => {
  const h = harness([SHIPFINDER_OK]);

  await h.acquire.execute({ mmsi: MMSI }, NEED_POSITION);

  assert.ok(h.observationRepo.size > 0, "observation được ghi");
  assert.equal(h.currentRepo.size, 1, "đúng một document canonical");
});

// ---- Tất định -------------------------------------------------------------

test("TẤT ĐỊNH · cùng trạng thái đầu vào -> cùng thứ tự attempt và stopReason", async () => {
  const build = () =>
    harness([SHIPFINDER_OK, SHIPINFO_OK]);

  const need: DataNeed = { type: DataNeedType.FULL, requiredFields: [VesselField.BUILT_YEAR] };
  const a = await build().acquire.execute({ mmsi: MMSI }, need);
  const b = await build().acquire.execute({ mmsi: MMSI }, need);

  assert.deepEqual(
    a.attempts.map((x) => [x.source, x.operation, x.outcome]),
    b.attempts.map((x) => [x.source, x.operation, x.outcome])
  );
  assert.equal(a.stopReason, b.stopReason);
  assert.equal(a.satisfied, b.satisfied);
});
