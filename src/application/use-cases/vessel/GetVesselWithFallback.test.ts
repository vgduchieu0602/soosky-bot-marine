// ============================================================================
//  TEST · GetVesselWithFallback — LOCAL → FREE → PAID
// ----------------------------------------------------------------------------
//  Hai làn bên dưới là bản giả ĐẾM SỐ LẦN GỌI: điều phải chứng minh ở đây là
//  "khi nào gọi ra ngoài", không phải "nguồn parse thế nào".
//
//  ⛔ Không mạng, không Mongo, không request trả tiền thật.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import { DetailRefreshGate } from "../../services/vessel/DetailRefreshGate";
import {
  CanonicalVesselDetail,
  DetailGroup,
  projectVesselDetail,
} from "../../services/vessel/VesselDetailProjector";
import { PositionFreshness } from "../../services/resolution/PositionResolverPolicy";
import { ResolvedCurrentVessel } from "../../services/resolution/ResolvedCurrentVessel";
import { PaidTrackingStatus } from "../tracking/TrackVesselCurrentPosition";
import { VesselDetailStatus } from "./GetCanonicalVesselDetail";
import { RefreshAttemptStatus } from "./GetOrRefreshVesselDetail";
import {
  FallbackSourceUsed,
  FallbackStatus,
  GetVesselWithFallback,
  PaidSkipReason,
  VesselNeed,
} from "./GetVesselWithFallback";

const MMSI = "636018086";
const NOW = new Date("2026-08-17T12:00:00.000Z");
const FRESH = new Date(NOW.getTime() - 60_000);
const STALE = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
//  Dựng canonical
// ---------------------------------------------------------------------------

function field<T>(value: T) {
  return {
    value,
    source: VesselSource.SHIPINFO,
    observedAt: null,
    fetchedAt: NOW,
    reason: "ONLY_AVAILABLE_VALUE",
    rejected: [],
  } as never;
}

interface Shape {
  position?: Date | null;
  identity?: boolean;
  particulars?: boolean;
  voyage?: boolean;
}

function vessel(shape: Shape): ResolvedCurrentVessel {
  const observedAt = shape.position === undefined ? FRESH : shape.position;
  let position: ResolvedCurrentVessel["position"] = null;
  if (observedAt !== null) {
    const report: VesselPositionReport = {
      mmsi: MMSI,
      imo: null,
      lat: 10,
      lng: 106,
      speed: 12,
      course: 90,
      heading: null,
      navStatus: null,
      latLngApproximate: false,
      receivedAt: observedAt,
      metadata: createSourceMetadata({
        source: VesselSource.AISSTREAM,
        fetchedAt: NOW,
        sourceReceivedAt: observedAt,
      }),
    };
    position = {
      position: report,
      source: VesselSource.AISSTREAM,
      observedAt,
      fetchedAt: NOW,
      freshness: PositionFreshness.LIVE,
      reason: "ONLY_AVAILABLE_VALUE",
      rejected: [],
    } as never;
  }

  return {
    vesselKey: { mmsi: MMSI },
    position,
    identity:
      shape.identity === false
        ? null
        : ({
            mmsi: MMSI,
            imo: field("9074729"),
            name: field("AGIA DOXA"),
            callsign: field("5LAB9"),
            vesselType: field("Bulk Carrier"),
            vesselTypeCode: field(70),
            flagCode: field("LR"),
            flagName: field("Liberia"),
          } as never),
    particulars:
      shape.particulars === false
        ? null
        : ({
            mmsi: MMSI,
            length: field(179),
            beam: field(29),
            draught: field(5.9),
            grossTonnage: null,
            deadweight: field(33261),
            builtYear: field(2010),
          } as never),
    voyage:
      shape.voyage === false
        ? null
        : ({
            mmsi: MMSI,
            destination: field("LONG BEACH, US"),
            eta: null,
            currentPort: null,
            nextPort: null,
            lastPort: null,
            lastPortDepartureAt: null,
          } as never),
    resolvedAt: NOW,
  };
}

function detailOf(shape: Shape): CanonicalVesselDetail {
  return projectVesselDetail(vessel(shape), NOW);
}

// ---------------------------------------------------------------------------
//  Bản giả cho hai làn
// ---------------------------------------------------------------------------

class FakeRead {
  calls = 0;
  constructor(public detail: CanonicalVesselDetail | null) {}
  async execute() {
    this.calls += 1;
    return this.detail === null
      ? { status: VesselDetailStatus.NOT_FOUND, detail: null }
      : { status: VesselDetailStatus.FOUND, detail: this.detail };
  }
}

class FakeFree {
  calls = 0;
  constructor(
    private readonly read: FakeRead,
    /** Nhóm mà làn free "lấp được"; đặt shape mới cho canonical. */
    private readonly after: Shape | null,
    private readonly attemptStatus: RefreshAttemptStatus = RefreshAttemptStatus.SUCCESS,
    private readonly attemptCount = 1
  ) {}

  async execute() {
    this.calls += 1;
    if (this.after !== null) this.read.detail = detailOf(this.after);
    const refreshed = this.after !== null;
    return {
      detail: this.read.detail,
      status:
        this.read.detail === null ? VesselDetailStatus.NOT_FOUND : VesselDetailStatus.FOUND,
      refreshed: true,
      requestedGroups: [],
      refreshedGroups: refreshed ? [DetailGroup.IDENTITY] : [],
      remainingMissingGroups: this.read.detail?.missingGroups ?? [],
      remainingStaleGroups: this.read.detail?.staleGroups ?? [],
      attempts: Array.from({ length: this.attemptCount }, (_, index) => ({
        source: index === 0 ? VesselSource.SHIPFINDER : VesselSource.SHIPINFO,
        status: this.attemptStatus,
        durationMs: 5,
      })),
    } as never;
  }
}

class FakePaid {
  calls = 0;
  constructor(
    private readonly read: FakeRead,
    private readonly status: PaidTrackingStatus = PaidTrackingStatus.UPDATED,
    private readonly after: Shape | null = { position: FRESH },
    private readonly credit: number | undefined = 1
  ) {}

  async execute() {
    this.calls += 1;
    if (this.status === PaidTrackingStatus.UPDATED && this.after !== null) {
      this.read.detail = detailOf(this.after);
    }
    return {
      status: this.status,
      source: VesselSource.MYSHIPTRACKING,
      expectedCreditCost: 1,
      ...(this.credit === undefined ? {} : { actualCreditCharged: this.credit }),
      observationsSaved: this.status === PaidTrackingStatus.UPDATED ? 1 : 0,
      requestSent: true,
    } as never;
  }
}

interface Harness {
  sut: GetVesselWithFallback;
  read: FakeRead;
  free: FakeFree;
  paid: FakePaid;
  gate: DetailRefreshGate;
}

function buildHarness(options: {
  local: CanonicalVesselDetail | null;
  freeAfter?: Shape | null;
  freeStatus?: RefreshAttemptStatus;
  freeAttempts?: number;
  paidStatus?: PaidTrackingStatus;
  paidAfter?: Shape | null;
  now?: () => Date;
}): Harness {
  const now = options.now ?? (() => NOW);
  const read = new FakeRead(options.local);
  const free = new FakeFree(
    read,
    options.freeAfter ?? null,
    options.freeStatus,
    options.freeAttempts
  );
  const paid = new FakePaid(
    read,
    options.paidStatus ?? PaidTrackingStatus.UPDATED,
    options.paidAfter === undefined ? { position: FRESH } : options.paidAfter
  );
  const gate = new DetailRefreshGate({ now });

  return {
    sut: new GetVesselWithFallback({
      read: read as never,
      free: free as never,
      paid: paid as never,
      gate,
      now,
    }),
    read,
    free,
    paid,
    gate,
  };
}

// ---------------------------------------------------------------------------
//  §40 · LOCAL HIT
// ---------------------------------------------------------------------------

test("§40 canonical đủ + tươi -> 0 free, 0 paid", async () => {
  const harness = buildHarness({ local: detailOf({}) });
  const result = await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.DETAIL,
    allowPaidFallback: true,
  });

  assert.equal(result.status, FallbackStatus.LOCAL_HIT);
  assert.equal(result.sourceUsed, FallbackSourceUsed.LOCAL);
  assert.equal(harness.free.calls, 0, "không được chạm làn free");
  assert.equal(harness.paid.calls, 0, "không được chạm làn trả tiền");
  assert.equal(result.externalAttempted, false);
  assert.equal(result.fallbackUsed, false);
});

test("need=POSITION chỉ cần vị trí tươi, particulars thiếu KHÔNG kéo theo crawl", async () => {
  const harness = buildHarness({
    local: detailOf({ particulars: false, voyage: false }),
  });
  const result = await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.POSITION,
    allowPaidFallback: true,
  });

  assert.equal(result.status, FallbackStatus.LOCAL_HIT);
  assert.equal(harness.free.calls, 0);
  assert.equal(harness.paid.calls, 0);
});

// ---------------------------------------------------------------------------
//  §41 + §42 · FREE thành công
// ---------------------------------------------------------------------------

test("§41 free lấp được nhu cầu -> 0 paid", async () => {
  const harness = buildHarness({
    local: detailOf({ identity: false, particulars: false, voyage: false }),
    freeAfter: {},
  });
  const result = await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.DETAIL,
    allowPaidFallback: true,
  });

  assert.equal(result.status, FallbackStatus.FREE_UPDATED);
  assert.equal(result.sourceUsed, FallbackSourceUsed.FREE);
  assert.equal(harness.free.calls, 1);
  assert.equal(harness.paid.calls, 0, "free đủ thì KHÔNG tiêu tiền");
  assert.equal(result.dataUpdated, true);
  assert.equal(result.paidSkipReason, PaidSkipReason.NEED_SATISFIED);
});

test("§42 nguồn free thứ nhất hỏng, thứ hai thành công -> vẫn 0 paid", async () => {
  // Làn free tự lo chuyện đổi nguồn (trần 2 nguồn); ở đây chỉ khẳng định
  // orchestrator KHÔNG nhảy sang tiền khi làn free cuối cùng vẫn ra dữ liệu.
  const harness = buildHarness({
    local: detailOf({ identity: false }),
    freeAfter: {},
    freeAttempts: 2,
  });
  const result = await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.DETAIL,
    allowPaidFallback: true,
  });

  assert.equal(result.freeAttempts.length, 2);
  assert.equal(harness.paid.calls, 0);
  assert.equal(result.status, FallbackStatus.FREE_UPDATED);
});

// ---------------------------------------------------------------------------
//  §43 · Mọi free hỏng + paid TẮT
// ---------------------------------------------------------------------------

test("§43 free hỏng hết + không bật paid -> 0 paid, trả phần đang có", async () => {
  const harness = buildHarness({
    local: detailOf({ particulars: false }),
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.TIMEOUT,
  });

  const result = await harness.sut.execute({ mmsi: MMSI, need: VesselNeed.DETAIL });

  assert.equal(harness.paid.calls, 0);
  assert.equal(result.status, FallbackStatus.PARTIAL);
  assert.equal(result.paidSkipReason, PaidSkipReason.NOT_ALLOWED);
  assert.notEqual(result.detail, null, "vẫn trả dữ liệu cũ");
});

test("allowPaidFallback vắng mặt = TẮT (không phải bật ngầm)", async () => {
  const harness = buildHarness({
    local: null,
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.NOT_FOUND,
  });
  const result = await harness.sut.execute({ mmsi: MMSI, need: VesselNeed.POSITION });
  assert.equal(harness.paid.calls, 0);
  assert.equal(result.paidSkipReason, PaidSkipReason.NOT_ALLOWED);
});

// ---------------------------------------------------------------------------
//  §44 · Mọi free hỏng + paid BẬT
// ---------------------------------------------------------------------------

test("§44 free hỏng hết + bật paid -> ĐÚNG MỘT lượt trả tiền, đọc lại canonical", async () => {
  const harness = buildHarness({
    local: detailOf({ position: null }),
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.TIMEOUT,
  });

  const result = await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.POSITION,
    allowPaidFallback: true,
  });

  assert.equal(harness.paid.calls, 1);
  assert.equal(result.status, FallbackStatus.PAID_UPDATED);
  assert.equal(result.sourceUsed, FallbackSourceUsed.PAID);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.paidAttempt?.status, PaidTrackingStatus.UPDATED);
  assert.equal(result.paidAttempt?.creditCharged, 1);
  // Đọc lại sau khi phân xử: local(1) + sau paid(1).
  assert.equal(harness.read.calls, 2);
});

// ---------------------------------------------------------------------------
//  §49 · Capability theo NHÓM — hàng rào tốn tiền
// ---------------------------------------------------------------------------

test("§49 chỉ thiếu PARTICULARS + free hỏng hết -> TUYỆT ĐỐI không gọi paid", async () => {
  const harness = buildHarness({
    local: detailOf({ particulars: false }),
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.NO_USEFUL_DATA,
  });

  const result = await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.DETAIL,
    allowPaidFallback: true,
  });

  assert.equal(harness.paid.calls, 0, "API vị trí không có particulars — gọi là tiêu tiền vô ích");
  assert.equal(result.paidSkipReason, PaidSkipReason.NO_PAID_CAPABILITY);
  assert.equal(result.status, FallbackStatus.PARTIAL);
  assert.ok(result.remainingMissingGroups.includes(DetailGroup.PARTICULARS));
});

test("§49 chỉ thiếu VOYAGE -> cũng không gọi paid", async () => {
  const harness = buildHarness({
    local: detailOf({ voyage: false }),
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.NOT_FOUND,
  });
  const result = await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.DETAIL,
    allowPaidFallback: true,
  });
  assert.equal(harness.paid.calls, 0);
  assert.equal(result.paidSkipReason, PaidSkipReason.NO_PAID_CAPABILITY);
});

test("thiếu POSITION -> paid ĐƯỢC gọi (nhóm nó lấp được)", async () => {
  const harness = buildHarness({
    local: detailOf({ position: STALE }),
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.TIMEOUT,
  });
  await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.DETAIL,
    allowPaidFallback: true,
  });
  assert.equal(harness.paid.calls, 1);
});

// ---------------------------------------------------------------------------
//  §26 + §48 · Paid hỏng -> KHÔNG quay lại free
// ---------------------------------------------------------------------------

test("§48 free hỏng + paid hỏng -> dừng, KHÔNG vòng lại free", async () => {
  for (const status of [
    PaidTrackingStatus.NO_CREDITS,
    PaidTrackingStatus.NOT_FOUND,
    PaidTrackingStatus.UNAVAILABLE,
  ]) {
    const harness = buildHarness({
      local: detailOf({ position: STALE }),
      freeAfter: null,
      freeStatus: RefreshAttemptStatus.BLOCKED,
      paidStatus: status,
      paidAfter: null,
    });

    const result = await harness.sut.execute({
      mmsi: MMSI,
      need: VesselNeed.POSITION,
      allowPaidFallback: true,
    });

    assert.equal(harness.free.calls, 1, `${status}: free chỉ một lượt, không vòng lại`);
    assert.equal(harness.paid.calls, 1);
    assert.equal(result.status, FallbackStatus.PARTIAL);
    assert.equal(result.paidAttempt?.status, status);
    assert.notEqual(result.detail, null, "vẫn trả dữ liệu cũ");
  }
});

// ---------------------------------------------------------------------------
//  §25 · Cooldown trả tiền
// ---------------------------------------------------------------------------

test("§25 vừa gọi paid -> lượt sau bị cooldown chặn", async () => {
  const harness = buildHarness({
    local: detailOf({ position: STALE }),
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.TIMEOUT,
    paidAfter: null,
  });

  await harness.sut.execute({ mmsi: MMSI, need: VesselNeed.POSITION, allowPaidFallback: true });
  assert.equal(harness.paid.calls, 1);

  const second = await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.POSITION,
    allowPaidFallback: true,
  });
  assert.equal(harness.paid.calls, 1, "không gọi lại nguồn trả tiền ngay");
  assert.equal(second.paidSkipReason, PaidSkipReason.COOLDOWN);
});

// ---------------------------------------------------------------------------
//  §51 + §52 · Single-flight NGOÀI
// ---------------------------------------------------------------------------

test("§51 10 request đồng thời cùng (MMSI, need) -> 1 free, 1 paid", async () => {
  const harness = buildHarness({
    local: detailOf({ position: STALE }),
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.TIMEOUT,
  });

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      harness.sut.execute({ mmsi: MMSI, need: VesselNeed.POSITION, allowPaidFallback: true })
    )
  );

  assert.equal(harness.free.calls, 1, "một lượt free cho cả mười người");
  assert.equal(harness.paid.calls, 1, "một credit cho cả mười người");
  assert.equal(harness.sut.getStats().singleFlightJoins, 9);
  for (const result of results) assert.equal(result.status, results[0].status);
});

test("§52 hai tàu khác nhau chạy độc lập, không khoá toàn cục", async () => {
  const harness = buildHarness({
    local: detailOf({ position: STALE }),
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.TIMEOUT,
  });

  await Promise.all([
    harness.sut.execute({ mmsi: MMSI, need: VesselNeed.POSITION, allowPaidFallback: true }),
    harness.sut.execute({ mmsi: "305803000", need: VesselNeed.POSITION, allowPaidFallback: true }),
  ]);

  assert.equal(harness.free.calls, 2);
  assert.equal(harness.sut.getStats().singleFlightJoins, 0);
});

test("cùng tàu nhưng KHÁC need -> hai lượt riêng", async () => {
  const harness = buildHarness({
    local: detailOf({ position: STALE, particulars: false }),
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.TIMEOUT,
  });

  await Promise.all([
    harness.sut.execute({ mmsi: MMSI, need: VesselNeed.POSITION }),
    harness.sut.execute({ mmsi: MMSI, need: VesselNeed.DETAIL }),
  ]);

  assert.equal(harness.free.calls, 2, "hai nhu cầu có định nghĩa 'đủ' khác nhau");
});

// ---------------------------------------------------------------------------
//  §53 · Ngân sách thời gian của CẢ LƯỢT
// ---------------------------------------------------------------------------

test("§53 làn free ăn hết ngân sách -> KHÔNG mở lượt trả tiền", async () => {
  let clock = NOW.getTime();
  const harness = buildHarness({
    local: detailOf({ position: STALE }),
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.TIMEOUT,
    now: () => new Date(clock),
  });

  // Làn free "tiêu" 14,5 giây trong ngân sách 15 giây -> còn 0,5s < minPaidSliceMs.
  const originalFree = harness.free.execute.bind(harness.free);
  harness.free.execute = async () => {
    clock += 14_500;
    return originalFree();
  };

  const result = await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.POSITION,
    allowPaidFallback: true,
  });

  assert.equal(harness.paid.calls, 0, "không mở request biết chắc sẽ bị cắt");
  assert.equal(result.paidSkipReason, PaidSkipReason.BUDGET_EXHAUSTED);
});

// ---------------------------------------------------------------------------
//  §27 + §28 · Hợp đồng kết quả
// ---------------------------------------------------------------------------

test("§28 ba cờ tách nhau: externalAttempted ≠ dataUpdated ≠ fallbackUsed", async () => {
  const harness = buildHarness({
    local: detailOf({ position: STALE }),
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.TIMEOUT,
    paidStatus: PaidTrackingStatus.NO_CREDITS,
    paidAfter: null,
  });

  const result = await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.POSITION,
    allowPaidFallback: true,
  });

  assert.equal(result.externalAttempted, true, "đã chạm nguồn ngoài");
  assert.equal(result.dataUpdated, false, "nhưng KHÔNG lấy thêm được gì");
  assert.equal(result.fallbackUsed, true, "và đã dùng tới làn trả tiền");
});

test("§27 kết quả KHÔNG mang HTML thô / lỗi nguồn / khoá API", async () => {
  const harness = buildHarness({
    local: detailOf({ position: STALE }),
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.BLOCKED,
  });
  const result = await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.POSITION,
    allowPaidFallback: true,
  });

  const serialized = JSON.stringify(result);
  for (const banned of ["<html", "Bearer", "apiKey", "authorization", "stack"]) {
    assert.equal(serialized.toLowerCase().includes(banned.toLowerCase()), false, banned);
  }
});

test("canonical rỗng + không nguồn nào ra gì -> NOT_FOUND", async () => {
  const harness = buildHarness({
    local: null,
    freeAfter: null,
    freeStatus: RefreshAttemptStatus.NOT_FOUND,
    paidStatus: PaidTrackingStatus.NOT_FOUND,
    paidAfter: null,
  });

  const result = await harness.sut.execute({
    mmsi: MMSI,
    need: VesselNeed.POSITION,
    allowPaidFallback: true,
  });

  assert.equal(result.status, FallbackStatus.NOT_FOUND);
  assert.equal(result.detail, null);
});

// ---------------------------------------------------------------------------
//  Bản triển khai KHÔNG có làn trả tiền (mặc định của bootstrap hiện tại)
// ---------------------------------------------------------------------------

test("không nối làn paid -> LANE_UNAVAILABLE, không phải lỗi", async () => {
  const read = new FakeRead(detailOf({ position: STALE }));
  const free = new FakeFree(read, null, RefreshAttemptStatus.TIMEOUT);
  const sut = new GetVesselWithFallback({
    read: read as never,
    free: free as never,
    // paid: cố tình vắng.
    gate: new DetailRefreshGate({ now: () => NOW }),
    now: () => NOW,
  });

  const result = await sut.execute({
    mmsi: MMSI,
    need: VesselNeed.POSITION,
    allowPaidFallback: true,
  });

  assert.equal(result.paidSkipReason, PaidSkipReason.LANE_UNAVAILABLE);
  assert.equal(result.status, FallbackStatus.PARTIAL);
  assert.equal(result.fallbackUsed, false);
  assert.notEqual(result.detail, null, "vẫn trả dữ liệu local + free");
});

test("không nối làn paid + không xin paid -> vẫn là NOT_ALLOWED (rẻ trước)", async () => {
  const read = new FakeRead(detailOf({ position: STALE }));
  const free = new FakeFree(read, null, RefreshAttemptStatus.TIMEOUT);
  const sut = new GetVesselWithFallback({
    read: read as never,
    free: free as never,
    gate: new DetailRefreshGate({ now: () => NOW }),
    now: () => NOW,
  });

  const result = await sut.execute({ mmsi: MMSI, need: VesselNeed.POSITION });
  assert.equal(result.paidSkipReason, PaidSkipReason.NOT_ALLOWED);
});

// ---------------------------------------------------------------------------
//  §2 + §3 · Hai làn cũ KHÔNG bị lẫn vào nhau
// ---------------------------------------------------------------------------

test("§2 làn free KHÔNG import gì thuộc nguồn trả tiền", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const source = await fs.readFile(
    path.join(__dirname, "GetOrRefreshVesselDetail.ts"),
    "utf8"
  );
  const imports = source
    .split("\n")
    .filter((line) => line.trimStart().startsWith("import"))
    .join("\n");

  for (const banned of ["MyShipTracking", "TrackVesselCurrentPosition", "myshiptracking"]) {
    assert.equal(imports.includes(banned), false, `làn free không được biết \`${banned}\``);
  }
});

test("§3 làn paid KHÔNG import làn free", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const source = await fs.readFile(
    path.join(__dirname, "..", "tracking", "TrackVesselCurrentPosition.ts"),
    "utf8"
  );
  const imports = source
    .split("\n")
    .filter((line) => line.trimStart().startsWith("import"))
    .join("\n");

  for (const banned of ["GetOrRefreshVesselDetail", "FreeSourceSelector"]) {
    assert.equal(imports.includes(banned), false, `làn paid không được biết \`${banned}\``);
  }
});
