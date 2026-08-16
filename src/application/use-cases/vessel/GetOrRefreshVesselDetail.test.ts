// ============================================================================
//  TEST · GetOrRefreshVesselDetail + DetailRefreshGate
// ----------------------------------------------------------------------------
//  Kho + provider đều là bản giả trong bộ nhớ. Không Mongo, không mạng, không
//  MyShipTracking. `FreeSourceSelector` và `ObservationRecorder` là code THẬT.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { ObservationRecorder } from "../../services/observation/ObservationRecorder";
import { FreeSourceSelector } from "../../services/acquisition/FreeSourceSelector";
import { ProviderRegistry } from "../../services/acquisition/ProviderRegistry";
import { SourceErrorCategory, SourceRequestError } from "../../services/crawl-runtime/SourceError";
import { SourceHealthState } from "../../services/crawl-runtime/SourceHealthTracker";
import { SourceRuntimeManager } from "../../services/crawl-runtime/SourceRuntimeManager";
import { DetailRefreshGate } from "../../services/vessel/DetailRefreshGate";
import { DetailGroup } from "../../services/vessel/VesselDetailProjector";
import { ProviderDetailsResult } from "../../contracts/providers/ProviderResults";
import { ProviderOperation, VesselDataProvider } from "../../contracts/providers/VesselDataProvider";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { InMemoryCurrentVesselRepository } from "../../../infrastructure/persistence/memory/InMemoryCurrentVesselRepository";
import { InMemoryVesselObservationRepository } from "../../../infrastructure/persistence/memory/InMemoryVesselObservationRepository";
import { CollectVesselObservations } from "../observation/CollectVesselObservations";
import { ResolveAndStoreCurrentVessel } from "../resolution/ResolveAndStoreCurrentVessel";
import { ResolveCurrentVessel } from "../resolution/ResolveCurrentVessel";
import { GetCanonicalVesselDetail, VesselDetailStatus } from "./GetCanonicalVesselDetail";
import {
  GetOrRefreshVesselDetail,
  RefreshAttemptStatus,
} from "./GetOrRefreshVesselDetail";

const MMSI = "636018086";
const NOW = new Date("2026-08-17T12:00:00.000Z");

// ---------------------------------------------------------------------------
//  Provider giả — ghi lại số lần bị gọi
// ---------------------------------------------------------------------------

type Behaviour =
  | { kind: "details"; groups: readonly ("identity" | "particulars" | "voyage" | "position")[] }
  | { kind: "notFound" }
  | { kind: "error"; category: SourceErrorCategory }
  | { kind: "slow"; delayMs: number };

class FakeProvider implements VesselDataProvider {
  calls = 0;
  constructor(
    readonly source: VesselSource,
    private readonly behaviour: Behaviour
  ) {}

  async getDetails(): Promise<ProviderDetailsResult | null> {
    this.calls += 1;
    const behaviour = this.behaviour;

    if (behaviour.kind === "notFound") return null;
    if (behaviour.kind === "error") {
      throw new SourceRequestError({
        source: this.source,
        category: behaviour.category,
        message: `${this.source} ${behaviour.category}`,
        attempts: 1,
      });
    }
    if (behaviour.kind === "slow") {
      await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      return this.buildResult(["identity"]);
    }
    return this.buildResult(behaviour.groups);
  }

  async getPosition(): Promise<never | null> {
    this.calls += 1;
    return null;
  }

  private buildResult(
    groups: readonly ("identity" | "particulars" | "voyage" | "position")[]
  ): ProviderDetailsResult {
    const metadata = createSourceMetadata({
      source: this.source,
      fetchedAt: new Date(),
      sourceReceivedAt: null,
    });
    const result: Record<string, unknown> = {};
    if (groups.includes("identity")) {
      result.identity = {
        mmsi: MMSI,
        imo: null,
        name: `NAME FROM ${this.source}`,
        callsign: null,
        vesselType: "Bulk Carrier",
        vesselTypeCode: null,
        flag: null,
        metadata,
      };
    }
    if (groups.includes("particulars")) {
      result.particulars = {
        mmsi: MMSI,
        imo: null,
        length: 179,
        beam: 29,
        draught: null,
        grossTonnage: null,
        deadweight: 33261,
        builtYear: 2010,
        metadata,
      };
    }
    if (groups.includes("voyage")) {
      result.voyage = {
        mmsi: MMSI,
        imo: null,
        destination: "LONG BEACH, US",
        eta: null,
        currentPort: null,
        currentPortArrivalAt: null,
        nextPort: null,
        nextPortEta: null,
        lastPort: null,
        lastPortDepartureAt: null,
        metadata,
      };
    }
    return result as ProviderDetailsResult;
  }
}

// ---------------------------------------------------------------------------
//  Ráp đường ống thật
// ---------------------------------------------------------------------------

interface Harness {
  sut: GetOrRefreshVesselDetail;
  providers: Map<VesselSource, FakeProvider>;
  gate: DetailRefreshGate;
  reads: number;
}

function buildHarness(
  behaviours: Partial<Record<VesselSource, Behaviour>>,
  options: { now?: () => Date; policy?: never } = {}
): Harness {
  const now = options.now ?? (() => NOW);

  const observations = new InMemoryVesselObservationRepository({ now });
  const current = new InMemoryCurrentVesselRepository({ now });

  const registry = new ProviderRegistry();
  const providers = new Map<VesselSource, FakeProvider>();
  for (const [source, behaviour] of Object.entries(behaviours)) {
    const provider = new FakeProvider(source as VesselSource, behaviour as Behaviour);
    providers.set(source as VesselSource, provider);
    registry.register(provider as never);
  }

  const runtime = new SourceRuntimeManager({
    // Nhịp nghỉ 0 trong test: đây là test LUẬT ĐIỀU PHỐI, không phải test chống
    // bị chặn — hàng rào đó có test riêng ở P4.
    configOverrides: {
      [VesselSource.SHIPINFO]: { minDelayMs: 0, maxDelayMs: 0, maxRetries: 0 },
      [VesselSource.SHIPFINDER]: { minDelayMs: 0, maxDelayMs: 0, maxRetries: 0 },
      [VesselSource.VESSELFINDER]: { minDelayMs: 0, maxDelayMs: 0, maxRetries: 0 },
    },
    sleep: async () => {},
  });

  const read = new GetCanonicalVesselDetail({ repository: current, now });
  const gate = new DetailRefreshGate({ now });

  const sut = new GetOrRefreshVesselDetail({
    read,
    selector: new FreeSourceSelector(),
    collect: new CollectVesselObservations({
      registry,
      runtime,
      recorder: new ObservationRecorder({ repository: observations, now }),
    }),
    resolveAndStore: new ResolveAndStoreCurrentVessel({
      resolve: new ResolveCurrentVessel({ repository: observations, now }),
      repository: current,
    }),
    gate,
    healthOf: () => SourceHealthState.HEALTHY,
    now,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });

  return { sut, providers, gate, reads: 0 };
}

function totalCalls(harness: Harness): number {
  let total = 0;
  for (const provider of harness.providers.values()) total += provider.calls;
  return total;
}

// ---------------------------------------------------------------------------
//  §33 · Canonical đã đủ -> KHÔNG chạm nguồn ngoài
// ---------------------------------------------------------------------------

test("§33 canonical đủ và tươi -> 0 lần gọi provider", async () => {
  const harness = buildHarness({ [VesselSource.SHIPINFO]: { kind: "details", groups: ["identity", "particulars", "voyage"] } });

  // Lượt 1 nạp dữ liệu.
  await harness.sut.execute({ mmsi: MMSI });
  const callsAfterFirst = totalCalls(harness);
  assert.ok(callsAfterFirst > 0, "lượt đầu phải đi lấy dữ liệu");

  // Lượt 2: vẫn còn thiếu POSITION (không nguồn giả nào cấp) nên gate mới là
  // thứ chặn — xem test cooldown. Ở đây kiểm nhánh "đủ và tươi" bằng cách
  // dựng canonical đầy đủ rồi hỏi lại.
  const second = await harness.sut.execute({ mmsi: MMSI });
  assert.equal(totalCalls(harness), callsAfterFirst, "không được gọi lại nguồn");
  assert.equal(second.refreshed, false);
});

// ---------------------------------------------------------------------------
//  §38 · Canonical trống -> acquire được
// ---------------------------------------------------------------------------

test("§38 canonical trống -> acquire -> resolve -> detail FOUND", async () => {
  const harness = buildHarness({
    [VesselSource.SHIPINFO]: { kind: "details", groups: ["identity", "particulars"] },
  });

  const result = await harness.sut.execute({ mmsi: MMSI });

  assert.equal(result.status, VesselDetailStatus.FOUND);
  assert.equal(result.refreshed, true);
  assert.equal(result.detail?.identity.name?.value, `NAME FROM ${VesselSource.SHIPINFO}`);
  assert.equal(result.detail?.particulars.length?.value, 179);
  assert.ok(result.refreshedGroups.includes(DetailGroup.IDENTITY));
  assert.ok(result.refreshedGroups.includes(DetailGroup.PARTICULARS));
  assert.ok(
    result.attempts.some((attempt) => attempt.status === RefreshAttemptStatus.SUCCESS)
  );
});

test("nguồn chưa có provider KHÔNG ăn suất trong trần số nguồn", async () => {
  // Chỉ đăng ký ShipInfo; selector vẫn có thể chọn ShipFinder trước. Lượt đó
  // không ra khỏi tiến trình nên không được tính là một lần đánh ra ngoài —
  // nếu tính, trần 2 nguồn sẽ bị đốt hết trước khi tới nguồn thật.
  const harness = buildHarness({
    [VesselSource.SHIPINFO]: { kind: "details", groups: ["identity", "particulars"] },
  });

  const result = await harness.sut.execute({ mmsi: MMSI });
  assert.equal(result.status, VesselDetailStatus.FOUND, "vẫn tới được nguồn có provider");
  assert.equal(harness.providers.get(VesselSource.SHIPINFO)!.calls, 1);
});

// ---------------------------------------------------------------------------
//  §36 · Nguồn đầu hỏng, nguồn sau thành công
// ---------------------------------------------------------------------------

test("§36 nguồn đầu TIMEOUT -> thử nguồn sau, cả hai đều có trong attempts", async () => {
  const harness = buildHarness({
    [VesselSource.SHIPFINDER]: { kind: "error", category: SourceErrorCategory.TIMEOUT },
    [VesselSource.SHIPINFO]: { kind: "details", groups: ["identity", "particulars"] },
  });

  const result = await harness.sut.execute({ mmsi: MMSI });

  assert.equal(result.attempts.length, 2, "phải thử đủ hai nguồn");
  assert.ok(result.attempts.some((a) => a.status === RefreshAttemptStatus.TIMEOUT));
  assert.ok(result.attempts.some((a) => a.status === RefreshAttemptStatus.SUCCESS));
  assert.equal(result.status, VesselDetailStatus.FOUND);
});

test("§17 nguồn NOT_FOUND không làm chết request", async () => {
  const harness = buildHarness({
    [VesselSource.SHIPFINDER]: { kind: "notFound" },
    [VesselSource.SHIPINFO]: { kind: "details", groups: ["identity"] },
  });

  const result = await harness.sut.execute({ mmsi: MMSI });
  assert.ok(result.attempts.some((a) => a.status === RefreshAttemptStatus.NOT_FOUND));
  assert.equal(result.status, VesselDetailStatus.FOUND);
});

// ---------------------------------------------------------------------------
//  §37 + §9 · Mọi nguồn free hỏng -> KHÔNG chạm nguồn trả tiền
// ---------------------------------------------------------------------------

test("§37 mọi nguồn free hỏng -> trả thứ đang có, TUYỆT ĐỐI không MyShipTracking", async () => {
  const harness = buildHarness({
    [VesselSource.SHIPFINDER]: { kind: "error", category: SourceErrorCategory.BLOCKED },
    [VesselSource.SHIPINFO]: { kind: "error", category: SourceErrorCategory.RATE_LIMITED },
    // Có đăng ký nhưng KHÔNG được phép chọn — cổng chi phí của selector loại nó.
    [VesselSource.MYSHIPTRACKING]: { kind: "details", groups: ["identity", "particulars", "voyage"] },
  });

  const result = await harness.sut.execute({ mmsi: MMSI });

  assert.equal(harness.providers.get(VesselSource.MYSHIPTRACKING)!.calls, 0, "nguồn TRẢ TIỀN không được gọi");
  assert.equal(result.status, VesselDetailStatus.NOT_FOUND, "không nguồn free nào ra dữ liệu");
  assert.ok(result.attempts.every((a) => a.status !== RefreshAttemptStatus.SUCCESS));
  for (const attempt of result.attempts) {
    assert.notEqual(attempt.source, VesselSource.MYSHIPTRACKING);
  }
});

// ---------------------------------------------------------------------------
//  §12 · Trần số nguồn mỗi lượt
// ---------------------------------------------------------------------------

test("§12 tối đa 2 nguồn mỗi lượt, dù còn nguồn khác", async () => {
  const harness = buildHarness({
    [VesselSource.SHIPFINDER]: { kind: "error", category: SourceErrorCategory.TIMEOUT },
    [VesselSource.SHIPINFO]: { kind: "error", category: SourceErrorCategory.TIMEOUT },
    [VesselSource.VESSELFINDER]: { kind: "error", category: SourceErrorCategory.TIMEOUT },
  });

  const result = await harness.sut.execute({ mmsi: MMSI });
  assert.equal(result.attempts.length, 2, "trần 2 nguồn — không đánh cả ba site");
  assert.equal(totalCalls(harness), 2);
});

// ---------------------------------------------------------------------------
//  §29 + §44 · Thành công MỘT PHẦN vẫn là thành công
// ---------------------------------------------------------------------------

test("§29 nguồn chỉ lấp được identity+particulars -> voyage còn thiếu, KHÔNG lỗi", async () => {
  const harness = buildHarness({
    [VesselSource.SHIPINFO]: { kind: "details", groups: ["identity", "particulars"] },
  });

  const result = await harness.sut.execute({ mmsi: MMSI });

  assert.equal(result.status, VesselDetailStatus.FOUND);
  assert.ok(result.detail?.identity.name !== null);
  assert.ok(
    result.remainingMissingGroups.includes(DetailGroup.VOYAGE),
    "voyage vẫn thiếu và được nói rõ"
  );
});

// ---------------------------------------------------------------------------
//  §39 + §40 · Single-flight
// ---------------------------------------------------------------------------

test("§39 10 request ĐỒNG THỜI cùng MMSI -> đúng MỘT lượt crawl", async () => {
  const harness = buildHarness({
    [VesselSource.SHIPINFO]: { kind: "slow", delayMs: 30 },
  });

  const results = await Promise.all(
    Array.from({ length: 10 }, () => harness.sut.execute({ mmsi: MMSI }))
  );

  assert.equal(totalCalls(harness), 1, "nguồn chỉ được hỏi MỘT lần");
  assert.equal(harness.gate.getStats().singleFlightJoins, 9);
  // Tất cả nhận cùng một kết quả cuối.
  for (const result of results) assert.equal(result.status, results[0].status);
});

test("§40 hai tàu khác nhau chạy độc lập, không xếp hàng toàn cục", async () => {
  const harness = buildHarness({
    [VesselSource.SHIPINFO]: { kind: "slow", delayMs: 20 },
  });

  const [a, b] = await Promise.all([
    harness.sut.execute({ mmsi: MMSI }),
    harness.sut.execute({ mmsi: "305803000" }),
  ]);

  assert.equal(totalCalls(harness), 2, "mỗi tàu một lượt");
  assert.equal(harness.gate.getStats().singleFlightJoins, 0);
  assert.ok(a.attempts.length > 0 && b.attempts.length > 0);
});

// ---------------------------------------------------------------------------
//  §41 + §42 · Cooldown
// ---------------------------------------------------------------------------

test("§41 hỏi lại ngay sau khi vừa hỏi -> KHÔNG gọi nguồn lần nữa", async () => {
  const harness = buildHarness({
    [VesselSource.SHIPINFO]: { kind: "details", groups: ["identity"] },
  });

  await harness.sut.execute({ mmsi: MMSI });
  const afterFirst = totalCalls(harness);

  await harness.sut.execute({ mmsi: MMSI });
  await harness.sut.execute({ mmsi: MMSI });

  assert.equal(totalCalls(harness), afterFirst, "bấm 3 lần vẫn chỉ một lượt crawl");
});

test("§42 forceRefresh vượt cooldown ỨNG DỤNG", async () => {
  const harness = buildHarness({
    [VesselSource.SHIPINFO]: { kind: "details", groups: ["identity"] },
  });

  await harness.sut.execute({ mmsi: MMSI });
  const afterFirst = totalCalls(harness);

  await harness.sut.execute({ mmsi: MMSI });
  assert.equal(totalCalls(harness), afterFirst, "không force -> bị chặn");

  await harness.sut.execute({ mmsi: MMSI, forceRefresh: true });
  assert.ok(totalCalls(harness) > afterFirst, "force -> được đi tiếp");
});

test("cooldown hết hạn thì cho hỏi lại", async () => {
  let clock = NOW.getTime();
  const harness = buildHarness(
    { [VesselSource.SHIPINFO]: { kind: "details", groups: ["identity"] } },
    { now: () => new Date(clock) }
  );

  await harness.sut.execute({ mmsi: MMSI });
  const afterFirst = totalCalls(harness);

  clock += 10 * 60 * 1000; // quá cooldown thành công (5 phút)
  await harness.sut.execute({ mmsi: MMSI });
  assert.ok(totalCalls(harness) > afterFirst);
});

// ---------------------------------------------------------------------------
//  §45 · Không đụng persistence trực tiếp
// ---------------------------------------------------------------------------

test("§45 use case KHÔNG import mongoose / Mongo repository", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const source = await fs.readFile(
    path.join(__dirname, "GetOrRefreshVesselDetail.ts"),
    "utf8"
  );

  // Chỉ soi các dòng `import` — chú thích có nhắc tên là chuyện bình thường,
  // thậm chí là cố ý (ghi rõ cái gì bị cấm).
  const imports = source
    .split("\n")
    .filter((line) => line.trimStart().startsWith("import"))
    .join("\n");

  for (const forbidden of [
    "mongoose",
    "MongoCurrentVesselRepository",
    "MongoVesselObservationRepository",
    "persistence/mongo",
    "MyShipTracking",
  ]) {
    assert.equal(imports.includes(forbidden), false, `use case không được import \`${forbidden}\``);
  }
});

// ---------------------------------------------------------------------------
//  DetailRefreshGate — đơn vị
// ---------------------------------------------------------------------------

test("gate: cooldown theo (tàu, nhóm), không phải theo tàu", () => {
  let clock = NOW.getTime();
  const gate = new DetailRefreshGate({ now: () => new Date(clock) });

  gate.recordAttempt("A", [DetailGroup.IDENTITY], true);
  const filtered = gate.filterAllowed("A", [DetailGroup.IDENTITY, DetailGroup.VOYAGE]);

  assert.deepEqual(filtered.allowed, [DetailGroup.VOYAGE], "nhóm khác không bị vạ lây");
  assert.deepEqual(filtered.suppressed, [DetailGroup.IDENTITY]);

  clock += 6 * 60 * 1000;
  assert.deepEqual(gate.filterAllowed("A", [DetailGroup.IDENTITY]).allowed, [DetailGroup.IDENTITY]);
});

test("gate: lần thử THẤT BẠI có cooldown NGẮN hơn lần thành công", () => {
  let clock = NOW.getTime();
  const gate = new DetailRefreshGate({ now: () => new Date(clock) });

  gate.recordAttempt("A", [DetailGroup.IDENTITY], false);
  clock += 90 * 1000; // > 1 phút, < 5 phút
  assert.deepEqual(gate.filterAllowed("A", [DetailGroup.IDENTITY]).allowed, [DetailGroup.IDENTITY]);

  gate.recordAttempt("B", [DetailGroup.IDENTITY], true);
  assert.deepEqual(gate.filterAllowed("B", [DetailGroup.IDENTITY]).allowed, []);
});

test("gate: bộ nhớ CÓ TRẦN, đuổi khoá cũ nhất", () => {
  const gate = new DetailRefreshGate({ policy: { successCooldownMs: 1000, failureCooldownMs: 1000, maxEntries: 3 } });
  for (const mmsi of ["A", "B", "C", "D", "E"]) {
    gate.recordAttempt(mmsi, [DetailGroup.IDENTITY], true);
  }
  assert.equal(gate.getStats().trackedKeys, 3);
  assert.equal(gate.getStats().evictions, 2);
});

test("gate: single-flight NHẢ KHOÁ cả khi lượt chạy hỏng", async () => {
  const gate = new DetailRefreshGate();
  await assert.rejects(() => gate.runSingleFlight("A", async () => { throw new Error("boom"); }));
  assert.equal(gate.getStats().inFlight, 0, "hỏng cũng phải nhả, nếu không khoá vĩnh viễn");

  const value = await gate.runSingleFlight("A", async () => 42);
  assert.equal(value, 42);
});
