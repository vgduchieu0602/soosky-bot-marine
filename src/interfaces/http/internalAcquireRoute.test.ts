// ============================================================================
//  TEST · POST /internal/vessels/:id/acquire — biên LỆNH nội bộ
// ----------------------------------------------------------------------------
//  Server HTTP thật + fetch thật; use case bị thay bằng bản ĐẾM.
//  Token trong file này là giá trị bịa, không phải bí mật thật.
//
//  ⛔ Không mạng ra ngoài, không Mongo, không credit thật.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { Express } from "express";
import { createApp } from "./createApp";
import { createInternalAcquireRouter } from "./internalAcquireRoute";
import {
  FallbackSourceUsed,
  FallbackStatus,
  GetVesselWithFallbackInput,
  VesselNeed,
} from "../../application/use-cases/vessel/GetVesselWithFallback";

const TOKEN = "internal-test-token";
const HEADERS = { "X-Internal-Token": TOKEN };
const MMSI = "636018086";
const IMO = "9074729";
const NOW = new Date("2026-08-17T12:00:00.000Z");

/** Bản đếm: ghi lại đúng những gì route đã truyền xuống Application layer. */
class SpyUseCase {
  readonly seen: GetVesselWithFallbackInput[] = [];

  async execute(input: GetVesselWithFallbackInput) {
    this.seen.push(input);
    return {
      status: FallbackStatus.LOCAL_HIT,
      sourceUsed: FallbackSourceUsed.LOCAL,
      need: input.need,
      detail: null,
      externalAttempted: false,
      dataUpdated: false,
      fallbackUsed: false,
      freeAttempts: [],
      remainingMissingGroups: [],
      remainingStaleGroups: [],
      durationMs: 1,
    };
  }
}

interface Harness {
  app: Express;
  spy: SpyUseCase;
}

function buildHarness(options: { paidFallbackEnabled?: boolean; token?: string } = {}): Harness {
  const spy = new SpyUseCase();
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use(
    createInternalAcquireRouter({
      useCase: spy as never,
      token: options.token ?? TOKEN,
      paidFallbackEnabled: options.paidFallbackEnabled ?? false,
      now: () => NOW,
    })
  );
  app.use((_req, res) => res.status(404).json({ error: "no route" }));
  return { app, spy };
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function post(
  app: Express,
  pathname: string,
  options: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<HttpResult> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const { port } = server.address() as AddressInfo;
    const headers: Record<string, string> = { ...options.headers, "Content-Type": "application/json" };
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
//  Khoá
// ---------------------------------------------------------------------------

test("thiếu token -> 401 và KHÔNG chạm use case", async () => {
  const harness = buildHarness();
  const result = await post(harness.app, `/internal/vessels/${MMSI}/acquire`, {
    body: { need: VesselNeed.POSITION },
  });
  assert.equal(result.status, 401);
  assert.equal(harness.spy.seen.length, 0);
});

test("token rỗng trong cấu hình -> chặn TẤT CẢ, kể cả request gửi chuỗi rỗng", async () => {
  const harness = buildHarness({ token: "" });
  for (const headers of [{}, { "X-Internal-Token": "" }, HEADERS]) {
    const result = await post(harness.app, `/internal/vessels/${MMSI}/acquire`, {
      headers,
      body: { need: VesselNeed.POSITION },
    });
    assert.equal(result.status, 401);
  }
  assert.equal(harness.spy.seen.length, 0);
});

test("createApp KHÔNG khai internalAcquire -> route không tồn tại", async () => {
  const app = createApp({
    getVesselDetails: {} as never,
    manageWatchlist: {} as never,
    repository: {} as never,
    apiKey: "x",
    positionStaleAfterMs: 1000,
  });
  const result = await post(app, `/internal/vessels/${MMSI}/acquire`, {
    headers: HEADERS,
    body: { need: VesselNeed.POSITION },
  });
  assert.equal(result.status, 404);
});

// ---------------------------------------------------------------------------
//  Định danh + body
// ---------------------------------------------------------------------------

test("định danh rác -> 400 trước khi bất kỳ nguồn nào bị gọi", async () => {
  const harness = buildHarness();
  for (const id of ["0", "abc", "12345", "99999999999", "%20"]) {
    const result = await post(harness.app, `/internal/vessels/${id}/acquire`, {
      headers: HEADERS,
      body: { need: VesselNeed.POSITION },
    });
    assert.equal(result.status, 400, id);
    assert.equal(result.body.code, "BAD_IDENTIFIER", id);
  }
  assert.equal(harness.spy.seen.length, 0, "không lượt crawl nào từ định danh chưa kiểm");
});

test("MMSI vào ô mmsi, IMO vào ô imo — không nhét lẫn", async () => {
  const harness = buildHarness();
  await post(harness.app, `/internal/vessels/${MMSI}/acquire`, {
    headers: HEADERS,
    body: { need: VesselNeed.POSITION },
  });
  await post(harness.app, `/internal/vessels/${IMO}/acquire`, {
    headers: HEADERS,
    body: { need: VesselNeed.DETAIL },
  });

  assert.deepEqual(harness.spy.seen[0], {
    mmsi: MMSI,
    need: VesselNeed.POSITION,
    allowPaidFallback: false,
  });
  assert.deepEqual(harness.spy.seen[1], {
    imo: IMO,
    need: VesselNeed.DETAIL,
    allowPaidFallback: false,
  });
});

test("need sai hoặc thiếu -> 400", async () => {
  const harness = buildHarness();
  for (const body of [{}, { need: "FULL" }, { need: "position" }, { need: 1 }]) {
    const result = await post(harness.app, `/internal/vessels/${MMSI}/acquire`, {
      headers: HEADERS,
      body,
    });
    assert.equal(result.status, 400, JSON.stringify(body));
  }
  assert.equal(harness.spy.seen.length, 0);
});

test("Marine gửi kèm tên nguồn -> 400, Bot tự chọn nguồn", async () => {
  const harness = buildHarness();
  for (const key of ["source", "sources", "provider", "useMyShipTracking"]) {
    const result = await post(harness.app, `/internal/vessels/${MMSI}/acquire`, {
      headers: HEADERS,
      body: { need: VesselNeed.POSITION, [key]: "MYSHIPTRACKING" },
    });
    assert.equal(result.status, 400, key);
    assert.match(String(result.body.error), /nguồn/);
  }
  assert.equal(harness.spy.seen.length, 0);
});

test("allowPaidFallback không phải boolean -> 400", async () => {
  const harness = buildHarness({ paidFallbackEnabled: true });
  const result = await post(harness.app, `/internal/vessels/${MMSI}/acquire`, {
    headers: HEADERS,
    body: { need: VesselNeed.POSITION, allowPaidFallback: "true" },
  });
  assert.equal(result.status, 400);
  assert.equal(harness.spy.seen.length, 0, '"true" dạng chuỗi KHÔNG được thành true');
});

// ---------------------------------------------------------------------------
//  Công tắc server VÀ cờ người gọi
// ---------------------------------------------------------------------------

test("người gọi xin paid nhưng server TẮT -> chạy free, nói thẳng là đã từ chối", async () => {
  const harness = buildHarness({ paidFallbackEnabled: false });
  const result = await post(harness.app, `/internal/vessels/${MMSI}/acquire`, {
    headers: HEADERS,
    body: { need: VesselNeed.POSITION, allowPaidFallback: true },
  });

  assert.equal(result.status, 200);
  assert.equal(harness.spy.seen[0].allowPaidFallback, false, "cờ của Marine KHÔNG tự bật paid");
  assert.equal(result.body.paidRequestedButDisabled, true);
});

test("server BẬT + người gọi xin -> mới truyền allowPaidFallback=true", async () => {
  const harness = buildHarness({ paidFallbackEnabled: true });
  const result = await post(harness.app, `/internal/vessels/${MMSI}/acquire`, {
    headers: HEADERS,
    body: { need: VesselNeed.POSITION, allowPaidFallback: true },
  });
  assert.equal(harness.spy.seen[0].allowPaidFallback, true);
  assert.equal(result.body.paidRequestedButDisabled, false);
});

test("server BẬT nhưng người gọi KHÔNG xin -> vẫn false", async () => {
  const harness = buildHarness({ paidFallbackEnabled: true });
  await post(harness.app, `/internal/vessels/${MMSI}/acquire`, {
    headers: HEADERS,
    body: { need: VesselNeed.POSITION },
  });
  assert.equal(harness.spy.seen[0].allowPaidFallback, false);
});

// ---------------------------------------------------------------------------
//  Rate limit
// ---------------------------------------------------------------------------

test("quá 3 lệnh/phút cho một tàu -> 429, và use case không bị gọi thêm", async () => {
  const harness = buildHarness();
  const statuses: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const result = await post(harness.app, `/internal/vessels/${MMSI}/acquire`, {
      headers: HEADERS,
      body: { need: VesselNeed.POSITION },
    });
    statuses.push(result.status);
  }

  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  assert.equal(harness.spy.seen.length, 3);
});

test("trần theo TÀU không chặn tàu khác", async () => {
  const harness = buildHarness();
  for (let index = 0; index < 3; index += 1) {
    await post(harness.app, `/internal/vessels/${MMSI}/acquire`, {
      headers: HEADERS,
      body: { need: VesselNeed.POSITION },
    });
  }
  const other = await post(harness.app, "/internal/vessels/305803000/acquire", {
    headers: HEADERS,
    body: { need: VesselNeed.POSITION },
  });
  assert.equal(other.status, 200);
});

// ---------------------------------------------------------------------------
//  Phản hồi
// ---------------------------------------------------------------------------

test("phản hồi KHÔNG mang khoá, HTML thô hay dấu vết nguồn trả tiền", async () => {
  const harness = buildHarness({ paidFallbackEnabled: true });
  const result = await post(harness.app, `/internal/vessels/${MMSI}/acquire`, {
    headers: HEADERS,
    body: { need: VesselNeed.POSITION, allowPaidFallback: true },
  });

  const serialized = JSON.stringify(result.body).toLowerCase();
  for (const banned of [TOKEN.toLowerCase(), "<html", "bearer", "apikey", "x-credit-charged"]) {
    assert.equal(serialized.includes(banned), false, banned);
  }
});
