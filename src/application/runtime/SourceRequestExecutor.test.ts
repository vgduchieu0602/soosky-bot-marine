// ============================================================================
//  TEST · SourceRequestExecutor — ghép cooldown + limiter + retry + health
// ----------------------------------------------------------------------------
//  Không mạng thật, không ngủ thật. Timeout dùng giá trị vài ms nên vẫn nhanh.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { Errors } from "../../domain/errors/AppError";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import {
  SourceErrorCategory,
  SourceRequestError,
  SourceUnavailableError,
  parseError,
} from "./SourceError";
import { SourceHealthState, SourceHealthTracker } from "./SourceHealthTracker";
import { SourceRequestExecutor } from "./SourceRequestExecutor";
import { SourceRequestLimiter } from "./SourceRequestLimiter";
import { RETRY_RATE_LIMITED_POLICY } from "./retryPolicy";
import { DEFAULT_CRAWL_RUNTIME_CONFIG, SourceRuntimeConfig } from "./SourceRuntimeConfig";

const SOURCE = VesselSource.SHIPINFO;

interface Harness {
  executor: SourceRequestExecutor;
  health: SourceHealthTracker;
  sleeps: number[];
  advance: (ms: number) => void;
}

function harness(overrides: Partial<SourceRuntimeConfig> = {}): Harness {
  const config: SourceRuntimeConfig = {
    ...DEFAULT_CRAWL_RUNTIME_CONFIG,
    minDelayMs: 0,
    maxDelayMs: 0,
    ...overrides,
  };

  let current = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    current += ms;
  };
  const nowMs = (): number => current;

  const health = new SourceHealthTracker({
    source: SOURCE,
    config,
    now: () => new Date(current),
  });
  const limiter = new SourceRequestLimiter({ source: SOURCE, config, sleep, now: nowMs });
  const executor = new SourceRequestExecutor({
    source: SOURCE,
    config,
    limiter,
    health,
    sleep,
    now: nowMs,
    random: () => 0,
  });

  return {
    executor,
    health,
    sleeps,
    advance: (ms) => {
      current += ms;
    },
  };
}

/** Task hỏng `times` lần đầu rồi thành công. Đếm số lần được gọi. */
function flaky(error: unknown, times: number): { task: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    task: async () => {
      calls += 1;
      if (calls <= times) throw error;
      return "ok";
    },
  };
}

test("request thành công: trả giá trị + cập nhật health", async () => {
  const { executor, health } = harness();

  const value = await executor.execute(async () => "payload");
  assert.equal(value, "payload");

  const snapshot = health.snapshot();
  assert.equal(snapshot.successCount, 1);
  assert.equal(snapshot.totalRequests, 1);
  assert.equal(snapshot.failureCount, 0);
  assert.equal(snapshot.state, SourceHealthState.HEALTHY);
  assert.ok(snapshot.lastSuccessAt instanceof Date);
});

test("độ trễ được ghi lại", async () => {
  const { executor, health, advance } = harness();

  await executor.execute(async () => {
    advance(250); // giả lập nguồn phản hồi sau 250ms
    return "ok";
  });

  assert.equal(health.snapshot().averageLatencyMs, 250);
});

test("TIMEOUT được thử lại, backoff nhân đôi", async () => {
  const timeout = new Error("hết giờ");
  timeout.name = "TimeoutError";
  const { executor, health, sleeps } = harness({
    maxRetries: 2,
    initialBackoffMs: 100,
    maxBackoffMs: 10_000,
  });
  const { task, calls } = flaky(timeout, 2);

  assert.equal(await executor.execute(task), "ok");
  assert.equal(calls(), 3, "1 lần đầu + 2 lần thử lại");
  assert.deepEqual(sleeps, [100, 200]);
  assert.equal(health.snapshot().timeoutCount, 2);
  assert.equal(health.snapshot().successCount, 1);
});

test("NETWORK_ERROR được thử lại", async () => {
  const { executor, health } = harness({ maxRetries: 1, initialBackoffMs: 10 });
  const { task, calls } = flaky(new TypeError("fetch failed"), 1);

  assert.equal(await executor.execute(task), "ok");
  assert.equal(calls(), 2);
  assert.equal(health.snapshot().networkErrorCount, 1);
});

test("SERVER_ERROR (5xx) được thử lại", async () => {
  const { executor, health } = harness({ maxRetries: 1, initialBackoffMs: 10 });
  const { task, calls } = flaky({ status: 503, message: "quá tải" }, 1);

  assert.equal(await executor.execute(task), "ok");
  assert.equal(calls(), 2);
  assert.equal(health.snapshot().serverErrorCount, 1);
});

test("hết lượt thử -> ném SourceRequestError kèm category và số lần đã thử", async () => {
  const { executor } = harness({ maxRetries: 2, initialBackoffMs: 10 });
  const { task, calls } = flaky({ status: 500, message: "nổ" }, 99);

  const err = await executor
    .execute(task, { operation: "getDetails" })
    .then(() => null)
    .catch((e: unknown) => e as SourceRequestError);

  assert.equal(err instanceof SourceRequestError, true);
  assert.equal(err?.category, SourceErrorCategory.SERVER_ERROR);
  assert.equal(err?.attempts, 3);
  assert.equal(err?.source, SOURCE);
  assert.match(err?.message ?? "", /getDetails/);
  assert.equal(calls(), 3);
});

test("NOT_FOUND: KHÔNG thử lại, KHÔNG tính vào chuỗi hỏng", async () => {
  const { executor, health } = harness({ maxRetries: 3, consecutiveFailuresBeforeCooldown: 2 });
  const { task, calls } = flaky(Errors.SHIP_NOT_FOUND("9074729"), 99);

  await assert.rejects(() => executor.execute(task), /NOT_FOUND/);
  assert.equal(calls(), 1);

  const snapshot = health.snapshot();
  assert.equal(snapshot.notFoundCount, 1);
  assert.equal(snapshot.consecutiveFailures, 0);
  assert.equal(snapshot.failureCount, 0);
  assert.equal(snapshot.state, SourceHealthState.HEALTHY);
});

test("PARSE_ERROR: mặc định KHÔNG thử lại (tải lại vẫn hỏng y hệt)", async () => {
  const { executor, health } = harness({ maxRetries: 3 });
  const { task, calls } = flaky(parseError(SOURCE, "selector đổi"), 99);

  await assert.rejects(() => executor.execute(task), /PARSE_ERROR/);
  assert.equal(calls(), 1);
  assert.equal(health.snapshot().parseErrorCount, 1);
});

test("403 BLOCKED: KHÔNG thử lại ngay", async () => {
  const { executor, health } = harness({ maxRetries: 3, consecutiveFailuresBeforeCooldown: 10 });
  const { task, calls } = flaky({ status: 403, message: "cấm" }, 99);

  await assert.rejects(() => executor.execute(task), /BLOCKED/);
  assert.equal(calls(), 1, "403 mà gửi tiếp chỉ làm tình hình tệ hơn");
  assert.equal(health.snapshot().blockedCount, 1);
});

test("429 RATE_LIMITED: KHÔNG thử lại ngay (mặc định)", async () => {
  const { executor, health } = harness({ maxRetries: 3, consecutiveFailuresBeforeCooldown: 10 });
  const { task, calls } = flaky({ status: 429, message: "quá nhiều" }, 99);

  await assert.rejects(() => executor.execute(task), /RATE_LIMITED/);
  assert.equal(calls(), 1);
  assert.equal(health.snapshot().rateLimitedCount, 1);
});

test("429 CÓ thể thử lại khi policy nói rõ như vậy", async () => {
  const config: SourceRuntimeConfig = {
    ...DEFAULT_CRAWL_RUNTIME_CONFIG,
    minDelayMs: 0,
    maxDelayMs: 0,
    maxRetries: 1,
    initialBackoffMs: 10,
  };
  const health = new SourceHealthTracker({ source: SOURCE, config });
  const executor = new SourceRequestExecutor({
    source: SOURCE,
    config,
    limiter: new SourceRequestLimiter({ source: SOURCE, config, sleep: async () => undefined }),
    health,
    retryPolicy: RETRY_RATE_LIMITED_POLICY,
    sleep: async () => undefined,
  });

  const { task, calls } = flaky({ status: 429, message: "quá nhiều" }, 1);
  assert.equal(await executor.execute(task), "ok");
  assert.equal(calls(), 2);
});

test("hỏng đủ ngưỡng -> COOLDOWN -> request sau FAIL FAST, không chạm mạng", async () => {
  const { executor, health } = harness({
    maxRetries: 0,
    consecutiveFailuresBeforeCooldown: 2,
    cooldownMs: 60_000,
  });

  await assert.rejects(() => executor.execute(async () => Promise.reject({ status: 500 })));
  await assert.rejects(() => executor.execute(async () => Promise.reject({ status: 500 })));
  assert.equal(health.getState(), SourceHealthState.COOLDOWN);

  let called = false;
  const err = await executor
    .execute(async () => {
      called = true;
      return "không bao giờ tới đây";
    })
    .then(() => null)
    .catch((e: unknown) => e as SourceUnavailableError);

  assert.equal(called, false, "cooldown phải chặn TRƯỚC khi chạy task");
  assert.equal(err instanceof SourceUnavailableError, true);
  assert.equal(err?.code, "SOURCE_COOLDOWN");
  assert.ok(err?.retryAt instanceof Date);
  // Fail fast không được tính thành một lần hỏng nữa (cooldown sẽ tự kéo dài mãi).
  assert.equal(health.snapshot().failureCount, 2);
});

test("hết cooldown -> được thử lại; thành công -> HEALTHY", async () => {
  const { executor, health, advance } = harness({
    maxRetries: 0,
    consecutiveFailuresBeforeCooldown: 1,
    cooldownMs: 30_000,
  });

  await assert.rejects(() => executor.execute(async () => Promise.reject({ status: 500 })));
  await assert.rejects(() => executor.execute(async () => "x"), SourceUnavailableError);

  advance(30_000);
  assert.equal(await executor.execute(async () => "lại chạy"), "lại chạy");
  assert.equal(health.getState(), SourceHealthState.HEALTHY);
});

test("nguồn bị tắt tay -> SOURCE_DISABLED", async () => {
  const { executor, health } = harness();
  health.disable();

  const err = await executor
    .execute(async () => "x")
    .then(() => null)
    .catch((e: unknown) => e as SourceUnavailableError);

  assert.equal(err?.code, "SOURCE_DISABLED");
});

test("task quá hạn -> TIMEOUT, và AbortSignal được bắn", async () => {
  const { executor, health } = harness({ timeoutMs: 5, maxRetries: 0 });
  let aborted = false;

  await assert.rejects(
    () =>
      executor.execute(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("bị huỷ"));
            });
          })
      ),
    /TIMEOUT/
  );

  assert.equal(aborted, true);
  assert.equal(health.snapshot().timeoutCount, 1);
});

test("getHealth trả snapshot đóng băng", async () => {
  const { executor } = harness();
  await executor.execute(async () => "ok");
  const snapshot = executor.getHealth();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.source, SOURCE);
});
