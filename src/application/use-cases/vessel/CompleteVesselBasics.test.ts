// ============================================================================
//  TEST · CompleteVesselBasics — gọi ÍT nhất có thể, và không làm mất dữ liệu
// ----------------------------------------------------------------------------
//  Không mạng, không Mongo: repository và collect đều giả lập, nhưng luật "đủ
//  hay chưa" vẫn là `LocalDataSufficiencyChecker` thật.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CompleteBasicsStatus,
  CompleteVesselBasics,
} from "./CompleteVesselBasics";
import { CollectStatus } from "../observation/CollectVesselObservations";
import { ICurrentVesselRepository } from "../../contracts/repositories/ICurrentVesselRepository";
import { ResolvedCurrentVessel } from "../../services/resolution/ResolvedCurrentVessel";
import { PositionFreshness } from "../../services/resolution/PositionResolverPolicy";
import { ResolutionReason } from "../../services/resolution/ResolverTypes";
import { SourceUnavailableError } from "../../services/crawl-runtime/SourceError";
import { VesselSource } from "../../../domain/enums/VesselSource";

const MMSI = "232007487";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const RECENT = new Date(NOW.getTime() - 2 * 60 * 1000);

function field<T>(value: T, fetchedAt: Date = RECENT) {
  return {
    value,
    source: VesselSource.SHIPFINDER,
    observationId: "obs-1",
    observedAt: RECENT,
    fetchedAt,
    reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
    rejected: [],
  };
}

/** Canonical "đầy đủ VesselBasics và còn tươi". */
function completeVessel(overrides: Partial<any> = {}): ResolvedCurrentVessel {
  return {
    mmsi: MMSI,
    imo: "9074729",
    identity: {
      mmsi: MMSI,
      imo: field("9074729"),
      name: field("TEST SHIP"),
      callsign: null,
      vesselType: field("Tug"),
      vesselTypeCode: field(52),
      flagCode: null,
      flagName: null,
    },
    position: {
      position: { mmsi: MMSI, lat: 51.2, lng: 1.2, receivedAt: RECENT, metadata: {} as never },
      source: VesselSource.SHIPFINDER,
      observationId: "obs-p",
      observedAt: RECENT,
      fetchedAt: RECENT,
      freshness: PositionFreshness.LIVE,
      reason: ResolutionReason.ONLY_AVAILABLE_VALUE,
      rejected: [],
      motion: {
        speed: 0,
        course: 0,
        heading: null,
        navStatus: { code: 0, text: "Under way using engine" },
        source: VesselSource.SHIPFINDER,
        observationId: "obs-p",
        observedAt: RECENT,
        fetchedAt: RECENT,
        freshness: PositionFreshness.LIVE,
      },
    },
    particulars: null,
    voyage: null,
    resolvedAt: NOW,
    ...overrides,
  } as never;
}

function repositoryOf(sequence: (ResolvedCurrentVessel | null)[]): {
  repo: ICurrentVesselRepository;
  reads: number;
} {
  const state = { reads: 0 };
  const repo = {
    async findByMmsi() {
      const index = Math.min(state.reads, sequence.length - 1);
      state.reads += 1;
      return sequence[index];
    },
    async findByImo() { return null; },
    async upsert() { return { status: "CREATED" } as never; },
  } as unknown as ICurrentVesselRepository;
  return { repo, get reads() { return state.reads; } } as never;
}

function collectorOf(behaviour: (source: VesselSource) => unknown) {
  const calls: VesselSource[] = [];
  return {
    calls,
    collect: {
      async execute({ source }: { source: VesselSource }) {
        calls.push(source);
        const outcome = behaviour(source);
        if (outcome instanceof Error) throw outcome;
        return { status: outcome, source, operation: "GET_DETAILS", observations: [] };
      },
    } as never,
  };
}

const resolveAndStore = { async execute() { return {} as never; } } as never;

test("VesselBasics còn đủ và còn tươi -> KHÔNG chạm mạng", async () => {
  const { repo } = repositoryOf([completeVessel()]);
  const { calls, collect } = collectorOf(() => CollectStatus.RECORDED);

  const result = await new CompleteVesselBasics({
    currentVesselRepository: repo,
    collect,
    resolveAndStore,
    now: () => NOW,
  }).execute(MMSI);

  assert.equal(result.status, CompleteBasicsStatus.ALREADY_SUFFICIENT);
  assert.equal(result.requests, 0);
  assert.deepEqual(calls, [], "không được gọi nguồn nào");
});

test("thiếu field -> CÓ gọi nguồn, và dừng ngay khi đã đủ", async () => {
  // Lần đọc đầu: chưa có tàu. Lần đọc sau: đã đầy đủ.
  const { repo } = repositoryOf([null, completeVessel(), completeVessel()]);
  const { calls, collect } = collectorOf(() => CollectStatus.RECORDED);

  const result = await new CompleteVesselBasics({
    currentVesselRepository: repo,
    collect,
    resolveAndStore,
    now: () => NOW,
  }).execute(MMSI);

  assert.equal(result.status, CompleteBasicsStatus.COMPLETED);
  assert.ok(result.missingBefore.length > 0);
  assert.deepEqual(result.missingAfter, []);
  // ShipFinder đứng đầu thứ tự đo được -> phải là nguồn được thử trước.
  assert.equal(calls[0], VesselSource.SHIPFINDER);
  // Đã đủ sau nguồn đầu -> KHÔNG gọi thêm VesselFinder/ShipInfo.
  assert.equal(calls.length, 1);
});

test("nguồn không lấp được field đang thiếu thì KHÔNG được gọi", async () => {
  // Chỉ thiếu vType (mã AIS số). ShipFinder/ShipInfo không có field này.
  const withoutTypeCode = completeVessel();
  (withoutTypeCode.identity as any).vesselTypeCode = null;
  const { repo } = repositoryOf([withoutTypeCode]);
  const { calls, collect } = collectorOf(() => CollectStatus.RECORDED);

  await new CompleteVesselBasics({
    currentVesselRepository: repo,
    collect,
    resolveAndStore,
    now: () => NOW,
  }).execute(MMSI);

  assert.deepEqual(calls, [VesselSource.VESSELFINDER], "chỉ VesselFinder có mã AIS số");
});

test("nguồn bị chặn -> ghi nhận rồi đi tiếp, KHÔNG ném", async () => {
  const { repo } = repositoryOf([null, null, null, null]);
  const { calls, collect } = collectorOf((source) =>
    source === VesselSource.SHIPFINDER
      ? new SourceUnavailableError({ code: "SOURCE_COOLDOWN", source, retryAt: NOW })
      : CollectStatus.NOT_FOUND
  );

  const result = await new CompleteVesselBasics({
    currentVesselRepository: repo,
    collect,
    resolveAndStore,
    now: () => NOW,
  }).execute(MMSI);

  assert.equal(result.status, CompleteBasicsStatus.NO_SOURCE_AVAILABLE);
  assert.equal(result.attempts[0].outcome, "UNAVAILABLE");
  // Một nguồn hỏng không được chặn các nguồn còn lại.
  assert.ok(calls.includes(VesselSource.VESSELFINDER));
});

test("giá trị 0 được coi là CÓ dữ liệu, không phải thiếu", async () => {
  // speed=0, course=0, navStatus code 0 — tàu buộc bến.
  const { repo } = repositoryOf([completeVessel()]);
  const { calls, collect } = collectorOf(() => CollectStatus.RECORDED);

  const result = await new CompleteVesselBasics({
    currentVesselRepository: repo,
    collect,
    resolveAndStore,
    now: () => NOW,
  }).execute(MMSI);

  // `speed || missing` sẽ làm test này đỏ ngay.
  assert.equal(result.status, CompleteBasicsStatus.ALREADY_SUFFICIENT);
  assert.deepEqual(calls, []);
});

test("§12 — nguồn vừa được hỏi thì KHÔNG hỏi lại ở chu kỳ sau", async () => {
  // Canonical vẫn thiếu vType (không nguồn nào ngoài VesselFinder có), nhưng
  // VesselFinder VỪA được hỏi cách đây 1 phút -> không được hỏi lại.
  const withoutTypeCode = completeVessel();
  (withoutTypeCode.identity as any).vesselTypeCode = null;
  const { repo } = repositoryOf([withoutTypeCode, withoutTypeCode]);
  const { calls, collect } = collectorOf(() => CollectStatus.RECORDED);

  const observationRepository = {
    async findRecentByVessel() {
      return [{ source: VesselSource.VESSELFINDER, fetchedAt: new Date(NOW.getTime() - 60_000) }];
    },
  } as never;

  const result = await new CompleteVesselBasics({
    currentVesselRepository: repo,
    observationRepository,
    collect,
    resolveAndStore,
    now: () => NOW,
  }).execute(MMSI);

  assert.deepEqual(calls, [], "không được bắn request nào");
  assert.equal(result.requests, 0);
  assert.equal(result.attempts[0].outcome, "RECENTLY_ASKED");
});

// ---------------------------------------------------------------------------
//  Ngữ nghĩa lat/lng và navStatus — khối TỒN TẠI không đồng nghĩa CÓ GIÁ TRỊ
// ---------------------------------------------------------------------------

/** Canonical đầy đủ, nhưng cho phép bẻ riêng phần toạ độ / navStatus. */
function vesselWith(overrides: { lat?: unknown; lng?: unknown; navStatus?: unknown }): ResolvedCurrentVessel {
  const v = completeVessel();
  if ("lat" in overrides) (v.position as any).position.lat = overrides.lat;
  if ("lng" in overrides) (v.position as any).position.lng = overrides.lng;
  if ("navStatus" in overrides) (v.position as any).motion.navStatus = overrides.navStatus;
  return v;
}

/** Field nào còn thiếu, nhìn qua đúng đường mà use-case dùng. */
async function missingOf(vessel: ResolvedCurrentVessel): Promise<string[]> {
  const { repo } = repositoryOf([vessel]);
  const { collect } = collectorOf(() => CollectStatus.NOT_FOUND);
  const result = await new CompleteVesselBasics({
    currentVesselRepository: repo,
    collect,
    resolveAndStore,
    now: () => NOW,
  }).execute(MMSI);
  return [...result.missingBefore] as string[];
}

test("A. có lat, thiếu lng -> chỉ lng bị coi là thiếu", async () => {
  const missing = await missingOf(vesselWith({ lat: 51.2, lng: null }));
  assert.equal(missing.includes("lat"), false, "lat có giá trị -> không thiếu");
  assert.equal(missing.includes("lng"), true, "lng null -> phải thiếu");
});

test("B. có lng, thiếu lat -> chỉ lat bị coi là thiếu", async () => {
  const missing = await missingOf(vesselWith({ lat: undefined, lng: 1.2 }));
  assert.equal(missing.includes("lng"), false, "lng có giá trị -> không thiếu");
  assert.equal(missing.includes("lat"), true, "lat vắng -> phải thiếu");
});

test("C. navStatus { code: null, text: 'Unknown' } -> THIẾU", async () => {
  const missing = await missingOf(vesselWith({ navStatus: { code: null, text: "Unknown" } }));
  assert.equal(missing.includes("navStatus"), true, "'Unknown' là ô trống, không phải trạng thái");
});

test("D. navStatus { code: 0, text: null } -> CÓ", async () => {
  const missing = await missingOf(vesselWith({ navStatus: { code: 0, text: null } }));
  // `code || text` sẽ làm assert này đỏ: 0 là falsy nhưng là giá trị THẬT.
  assert.equal(missing.includes("navStatus"), false, "mã 0 là giá trị hợp lệ");
});

test("E. navStatus { code: null, text: 'Moored' } -> CÓ", async () => {
  const missing = await missingOf(vesselWith({ navStatus: { code: null, text: "Moored" } }));
  assert.equal(missing.includes("navStatus"), false, "chữ có nghĩa vẫn là dữ liệu");
});

test("navStatus các dạng ô trống khác cũng bị coi là thiếu", async () => {
  for (const text of ["", "-", "--", "---", "n/a", "  UNKNOWN  "]) {
    const missing = await missingOf(vesselWith({ navStatus: { code: null, text } }));
    assert.equal(missing.includes("navStatus"), true, `nhãn ${JSON.stringify(text)} phải là thiếu`);
  }
});
