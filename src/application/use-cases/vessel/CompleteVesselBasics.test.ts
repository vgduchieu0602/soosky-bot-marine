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
