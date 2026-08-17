// ============================================================================
//  TEST · Làn theo dõi TRẢ TIỀN
// ----------------------------------------------------------------------------
//  ⛔ KHÔNG request thật nào tới MyShipTracking. Transport là bản giả.
//  Client · mapper · gate · observation · resolver đều là code THẬT.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { PaidFallbackGate } from "../../services/acquisition/PaidFallbackGate";
import { PaidBudgetSnapshot } from "../../services/acquisition/PaidFallbackPolicy";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import { InMemoryCurrentVesselRepository } from "../../../infrastructure/persistence/memory/InMemoryCurrentVesselRepository";
import { InMemoryVesselObservationRepository } from "../../../infrastructure/persistence/memory/InMemoryVesselObservationRepository";
import {
  MyShipTrackingClient,
  MyShipTrackingTransport,
} from "../../../infrastructure/integrations/myshiptracking/MyShipTrackingClient";
import { MyShipTrackingProvider } from "../../../infrastructure/integrations/myshiptracking/MyShipTrackingProvider";
import { detailsResultToObservations } from "../../services/observation/providerResultToObservation";
import { ResolveAndStoreCurrentVessel } from "../resolution/ResolveAndStoreCurrentVessel";
import { ResolveCurrentVessel } from "../resolution/ResolveCurrentVessel";
import {
  InvalidTrackingIdentifierError,
  PaidTrackingStatus,
  TrackVesselCurrentPosition,
} from "./TrackVesselCurrentPosition";

const MMSI = "636018086";
const IMO = "9074729";
const NOW = new Date("2026-08-17T12:10:00.000Z");
const RECEIVED = "2026-08-17T12:05:00Z";

const BUDGET: PaidBudgetSnapshot = { enabled: true, remainingCalls: 100 };

/** Transport giả: ghi lại mọi request, trả response đã dựng sẵn. */
class FakeTransport implements MyShipTrackingTransport {
  urls: string[] = [];
  headers: Record<string, string>[] = [];
  constructor(
    private readonly responses: Array<{
      status: number;
      headers?: Record<string, string>;
      body: string;
    }>
  ) {}

  async request(url: string, headers: Record<string, string>) {
    this.urls.push(url);
    this.headers.push(headers);
    const response = this.responses[Math.min(this.urls.length - 1, this.responses.length - 1)];
    return { status: response.status, headers: response.headers ?? {}, body: response.body };
  }
}

function successBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "success",
    duration: "0.02s",
    timestamp: NOW.toISOString(),
    data: {
      vessel_name: "AGIA DOXA",
      mmsi: Number(MMSI),
      imo: Number(IMO),
      vtype: 70,
      lat: 10.5,
      lng: 106.5,
      course: 87,
      speed: 12.3,
      nav_status: "Under way using engine",
      received: RECEIVED,
      ...overrides,
    },
  });
}

function errorBody(code: string): string {
  return JSON.stringify({ status: "error", code, message: "…" });
}

interface Harness {
  sut: TrackVesselCurrentPosition;
  transport: FakeTransport;
  observations: InMemoryVesselObservationRepository;
  current: InMemoryCurrentVesselRepository;
}

function buildHarness(
  responses: Array<{ status: number; headers?: Record<string, string>; body: string }>,
  budget: PaidBudgetSnapshot = BUDGET
): Harness {
  const now = () => NOW;
  const transport = new FakeTransport(responses);
  const client = new MyShipTrackingClient({ apiKey: "secret-key-do-not-log", transport });
  const provider = new MyShipTrackingProvider({ client, now });
  const observations = new InMemoryVesselObservationRepository({ now });
  const current = new InMemoryCurrentVesselRepository({ now });

  const sut = new TrackVesselCurrentPosition({
    source: {
      fetchCurrentPosition: (query) => provider.fetchCurrentPosition(query),
      toProviderResult: (data, fetchedAt) => provider.toProviderResult(data, fetchedAt),
    },
    gate: new PaidFallbackGate(),
    observations,
    resolveAndStore: new ResolveAndStoreCurrentVessel({
      resolve: new ResolveCurrentVessel({ repository: observations, now }),
      repository: current,
    }),
    budget: () => budget,
    now,
  });

  return { sut, transport, observations, current };
}

// ---------------------------------------------------------------------------
//  §41 + §42 · Hình dạng request
// ---------------------------------------------------------------------------

test("§41 GET /api/v2/vessel · response=simple · ĐÚNG MỘT định danh · có auth", async () => {
  const harness = buildHarness([{ status: 200, body: successBody() }]);
  await harness.sut.execute({ mmsi: MMSI });

  assert.equal(harness.transport.urls.length, 1, "đúng MỘT request cho một lượt");
  const url = new URL(harness.transport.urls[0]);
  assert.equal(url.pathname, "/api/v2/vessel");
  assert.equal(url.searchParams.get("response"), "simple");
  assert.equal(url.searchParams.get("mmsi"), MMSI);
  assert.equal(url.searchParams.get("imo"), null, "KHÔNG gửi cả hai định danh");
  assert.equal(harness.transport.headers[0].authorization, "Bearer secret-key-do-not-log");
});

test("§42 TUYỆT ĐỐI không gửi response=extended (3 credit)", async () => {
  const harness = buildHarness([{ status: 200, body: successBody() }]);
  await harness.sut.execute({ mmsi: MMSI });
  assert.equal(harness.transport.urls[0].includes("extended"), false);
});

test("chỉ có IMO -> tra bằng imo; có cả hai -> ưu tiên MMSI", async () => {
  const byImo = buildHarness([{ status: 200, body: successBody() }]);
  await byImo.sut.execute({ imo: IMO });
  assert.equal(new URL(byImo.transport.urls[0]).searchParams.get("imo"), IMO);

  const both = buildHarness([{ status: 200, body: successBody() }]);
  await both.sut.execute({ mmsi: MMSI, imo: IMO });
  const params = new URL(both.transport.urls[0]).searchParams;
  assert.equal(params.get("mmsi"), MMSI);
  assert.equal(params.get("imo"), null);
});

test("định danh sai -> ném TRƯỚC khi gửi request nào", async () => {
  const harness = buildHarness([{ status: 200, body: successBody() }]);
  for (const input of [{}, { mmsi: "12345" }, { imo: "9074728" }]) {
    await assert.rejects(() => harness.sut.execute(input), InvalidTrackingIdentifierError);
  }
  assert.equal(harness.transport.urls.length, 0, "không tiêu credit cho định danh rác");
});

// ---------------------------------------------------------------------------
//  §43 + §48 · Chuẩn hoá và đường observation
// ---------------------------------------------------------------------------

test("§43 response hợp lệ -> identity + position, source = MYSHIPTRACKING", async () => {
  const harness = buildHarness([{ status: 200, body: successBody() }]);
  const result = await harness.sut.execute({ mmsi: MMSI });

  assert.equal(result.status, PaidTrackingStatus.UPDATED);
  assert.equal(result.source, VesselSource.MYSHIPTRACKING);
  // §13: mốc NGUỒN, không phải giờ gọi.
  assert.equal(result.sourceReceivedAt?.toISOString(), "2026-08-17T12:05:00.000Z");
  assert.notEqual(result.sourceReceivedAt?.getTime(), NOW.getTime());

  const stored = await harness.current.findByMmsi(MMSI);
  assert.equal(stored?.position?.source, VesselSource.MYSHIPTRACKING);
  assert.equal(stored?.position?.position.lat, 10.5);
  assert.equal(stored?.position?.position.lng, 106.5);
  assert.equal(stored?.identity?.name?.value, "AGIA DOXA");
  // Response KHÔNG có heading — nguồn trả tiền thua ShipFinder đúng field này.
  assert.equal(stored?.position?.position.heading, null);
});

test("official numeric nav_status is retained as an AIS status code", async () => {
  const harness = buildHarness([{ status: 200, body: successBody({ nav_status: 0 }) }]);
  await harness.sut.execute({ mmsi: MMSI });

  const stored = await harness.current.findByMmsi(MMSI);
  assert.deepEqual(stored?.position?.position.navStatus, { code: 0, text: null });
});

test("§48 dữ liệu đi qua observation, KHÔNG ghi thẳng canonical", async () => {
  const harness = buildHarness([{ status: 200, body: successBody() }]);
  const result = await harness.sut.execute({ mmsi: MMSI });

  assert.ok(result.observationsSaved > 0);
  const recorded = await harness.observations.findRecentByVessel({ mmsi: MMSI });
  assert.ok(recorded.length > 0, "phải có observation, không phải cập nhật thẳng");
  assert.ok(recorded.every((item) => item.source === VesselSource.MYSHIPTRACKING));
});

test("mốc `received` hỏng -> KHÔNG phát nhóm vị trí, và KHÔNG thay bằng now", async () => {
  const harness = buildHarness([{ status: 200, body: successBody({ received: "rác" }) }]);
  const result = await harness.sut.execute({ mmsi: MMSI });

  assert.equal(result.sourceReceivedAt, undefined);
  const stored = await harness.current.findByMmsi(MMSI);
  assert.equal(stored?.position, null, "không có mốc nguồn thì không có vị trí canonical");
  assert.notEqual(stored?.identity, null, "identity vẫn dùng được");
});

// ---------------------------------------------------------------------------
//  §44 → §47 · Lỗi và credit
// ---------------------------------------------------------------------------

test("§44 404 -> NOT_FOUND, không observation, không resolver", async () => {
  const harness = buildHarness([{ status: 404, body: errorBody("ERR_VESSEL_NOT_FOUND") }]);
  const result = await harness.sut.execute({ mmsi: MMSI });

  assert.equal(result.status, PaidTrackingStatus.NOT_FOUND);
  assert.equal(result.observationsSaved, 0);
  assert.equal(await harness.current.findByMmsi(MMSI), null);
  assert.equal(harness.transport.urls.length, 1, "KHÔNG retry");
});

test("§45 402 ERR_NO_CREDITS -> NO_CREDITS, KHÔNG retry", async () => {
  const harness = buildHarness([{ status: 402, body: errorBody("ERR_NO_CREDITS") }]);
  const result = await harness.sut.execute({ mmsi: MMSI });

  assert.equal(result.status, PaidTrackingStatus.NO_CREDITS);
  assert.equal(result.observationsSaved, 0);
  assert.equal(harness.transport.urls.length, 1, "hết tiền thì thử lại cũng vô nghĩa");
});

test("§46 429 -> UNAVAILABLE, không retry dồn dập", async () => {
  const harness = buildHarness([{ status: 429, body: errorBody("ERR_RATE_LIMIT") }]);
  const result = await harness.sut.execute({ mmsi: MMSI });
  assert.equal(result.status, PaidTrackingStatus.UNAVAILABLE);
  assert.equal(harness.transport.urls.length, 1);
});

test("§38 5xx cũng KHÔNG retry — không chắc đã bị trừ credit hay chưa", async () => {
  const harness = buildHarness([{ status: 500, body: errorBody("ERR_INTERNAL") }]);
  const result = await harness.sut.execute({ mmsi: MMSI });
  assert.equal(result.status, PaidTrackingStatus.UNAVAILABLE);
  assert.equal(harness.transport.urls.length, 1);
});

test("401/403 -> UNAVAILABLE, một request", async () => {
  for (const [status, code] of [[401, "ERR_INVALID_KEY"], [403, "ERR_NOACCESS"]] as const) {
    const harness = buildHarness([{ status, body: errorBody(code) }]);
    const result = await harness.sut.execute({ mmsi: MMSI });
    assert.equal(result.status, PaidTrackingStatus.UNAVAILABLE, code);
    assert.equal(harness.transport.urls.length, 1);
  }
});

test("§47 X-Credit-Charged được ghi lại; vắng mặt -> undefined, KHÔNG bịa", async () => {
  const withHeader = buildHarness([
    { status: 200, headers: { "x-credit-charged": "1" }, body: successBody() },
  ]);
  const charged = await withHeader.sut.execute({ mmsi: MMSI });
  assert.equal(charged.actualCreditCharged, 1);
  assert.equal(charged.expectedCreditCost, 1);

  const without = buildHarness([{ status: 200, body: successBody() }]);
  const unknown = await without.sut.execute({ mmsi: MMSI });
  assert.equal(unknown.actualCreditCharged, undefined);
  assert.equal(unknown.expectedCreditCost, 1, "chi phí CÔNG BỐ vẫn nói được");
});

// ---------------------------------------------------------------------------
//  §24 + §25 · Cổng trả tiền
// ---------------------------------------------------------------------------

test("§25 ngân sách KHÔNG BIẾT -> DENIED, không gửi request nào", async () => {
  const harness = buildHarness([{ status: 200, body: successBody() }], {
    enabled: true,
    remainingCalls: null,
  });
  const result = await harness.sut.execute({ mmsi: MMSI });

  assert.equal(result.status, PaidTrackingStatus.DENIED);
  assert.equal(result.requestSent, false);
  assert.equal(harness.transport.urls.length, 0, "không biết còn bao nhiêu thì không tiêu");
});

test("ngân sách cạn / tắt -> DENIED", async () => {
  for (const budget of [
    { enabled: false, remainingCalls: 100 },
    { enabled: true, remainingCalls: 0 },
  ] as PaidBudgetSnapshot[]) {
    const harness = buildHarness([{ status: 200, body: successBody() }], budget);
    const result = await harness.sut.execute({ mmsi: MMSI });
    assert.equal(result.status, PaidTrackingStatus.DENIED);
    assert.equal(harness.transport.urls.length, 0);
  }
});

// ---------------------------------------------------------------------------
//  §49 + §50 · Trả tiền KHÔNG tự động thắng
// ---------------------------------------------------------------------------

async function seedAisPosition(
  harness: Harness,
  observedAt: Date,
  lat: number
): Promise<void> {
  const position: VesselPositionReport = {
    mmsi: MMSI,
    imo: null,
    lat,
    lng: 100,
    speed: 10,
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
  await harness.observations.saveMany(
    detailsResultToObservations({ position }, { now: NOW })
  );
}

test("§49 AIS MỚI HƠN -> canonical giữ AIS, dù vừa trả tiền", async () => {
  const harness = buildHarness([{ status: 200, body: successBody() }]);
  // AIS 12:06 mới hơn MyShipTracking 12:05.
  await seedAisPosition(harness, new Date("2026-08-17T12:06:00.000Z"), 1);

  const result = await harness.sut.execute({ mmsi: MMSI });
  assert.equal(result.status, PaidTrackingStatus.UPDATED, "vẫn ghi observation");

  const stored = await harness.current.findByMmsi(MMSI);
  assert.equal(
    stored?.position?.source,
    VesselSource.AISSTREAM,
    "tiền KHÔNG mua được quyền ghi đè dữ liệu mới hơn"
  );
});

test("§50 trả tiền MỚI HƠN -> thắng qua chính luật độ tươi, không hardcode", async () => {
  const harness = buildHarness([{ status: 200, body: successBody() }]);
  // AIS 12:04 cũ hơn MyShipTracking 12:05.
  await seedAisPosition(harness, new Date("2026-08-17T12:04:00.000Z"), 1);

  await harness.sut.execute({ mmsi: MMSI });
  const stored = await harness.current.findByMmsi(MMSI);
  assert.equal(stored?.position?.source, VesselSource.MYSHIPTRACKING);
  assert.equal(stored?.position?.position.lat, 10.5);
});

test("§32 lượt trả tiền CŨ HƠN không ghi đè AIS mới hơn", async () => {
  const harness = buildHarness([
    { status: 200, body: successBody({ received: "2026-08-17T11:59:00Z" }) },
  ]);
  await seedAisPosition(harness, new Date("2026-08-17T12:01:00.000Z"), 2);

  await harness.sut.execute({ mmsi: MMSI });
  const stored = await harness.current.findByMmsi(MMSI);
  assert.equal(stored?.position?.source, VesselSource.AISSTREAM);
  assert.equal(stored?.position?.position.lat, 2);
});

// ---------------------------------------------------------------------------
//  §51 · Single-flight — mỗi lượt là TIỀN THẬT
// ---------------------------------------------------------------------------

test("§51 10 request đồng thời cùng MMSI -> ĐÚNG MỘT request HTTP", async () => {
  const harness = buildHarness([{ status: 200, headers: { "x-credit-charged": "1" }, body: successBody() }]);

  const results = await Promise.all(
    Array.from({ length: 10 }, () => harness.sut.execute({ mmsi: MMSI }))
  );

  assert.equal(harness.transport.urls.length, 1, "10 người bấm ≠ 10 credit");
  assert.equal(harness.sut.getStats().singleFlightJoins, 9);
  for (const result of results) {
    assert.equal(result.status, PaidTrackingStatus.UPDATED);
    assert.equal(result.actualCreditCharged, 1, "một lần tính phí, không nhân theo số người gọi");
  }
});

test("hai tàu khác nhau -> hai request độc lập", async () => {
  const harness = buildHarness([{ status: 200, body: successBody() }]);
  await Promise.all([
    harness.sut.execute({ mmsi: MMSI }),
    harness.sut.execute({ mmsi: "305803000" }),
  ]);
  assert.equal(harness.transport.urls.length, 2);
});

test("lượt hỏng vẫn NHẢ khoá single-flight", async () => {
  const harness = buildHarness([{ status: 500, body: errorBody("ERR_INTERNAL") }]);
  await harness.sut.execute({ mmsi: MMSI });
  await harness.sut.execute({ mmsi: MMSI });
  assert.equal(harness.transport.urls.length, 2, "không bị khoá vĩnh viễn sau một lần lỗi");
});

// ---------------------------------------------------------------------------
//  §39 · Không rò khoá API
// ---------------------------------------------------------------------------

test("§39 log KHÔNG chứa API key", async () => {
  const lines: string[] = [];
  const transport = new FakeTransport([{ status: 200, body: successBody() }]);
  const client = new MyShipTrackingClient({ apiKey: "SUPER-SECRET", transport });
  const provider = new MyShipTrackingProvider({ client, now: () => NOW });
  const observations = new InMemoryVesselObservationRepository({ now: () => NOW });

  const sut = new TrackVesselCurrentPosition({
    source: {
      fetchCurrentPosition: (query) => provider.fetchCurrentPosition(query),
      toProviderResult: (data, fetchedAt) => provider.toProviderResult(data, fetchedAt),
    },
    gate: new PaidFallbackGate(),
    observations,
    resolveAndStore: new ResolveAndStoreCurrentVessel({
      resolve: new ResolveCurrentVessel({ repository: observations, now: () => NOW }),
      repository: new InMemoryCurrentVesselRepository({ now: () => NOW }),
    }),
    budget: () => BUDGET,
    now: () => NOW,
    logger: { info: (message) => lines.push(message) },
  });

  await sut.execute({ mmsi: MMSI });
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.equal(line.includes("SUPER-SECRET"), false);
    assert.equal(line.toLowerCase().includes("authorization"), false);
  }
});
