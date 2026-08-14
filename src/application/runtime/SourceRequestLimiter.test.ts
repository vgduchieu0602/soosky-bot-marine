// ============================================================================
//  TEST · SourceRequestLimiter — concurrency + nhịp nghỉ, KHÔNG ngủ thật
// ----------------------------------------------------------------------------
//  sleep được tiêm: trả về ngay và ghi lại số ms đã yêu cầu. Test chạy tức thì
//  nhưng vẫn khẳng định được "đã xin nghỉ đúng khoảng".
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { SourceRequestLimiter } from "./SourceRequestLimiter";
import { DEFAULT_CRAWL_RUNTIME_CONFIG, SourceRuntimeConfig } from "./SourceRuntimeConfig";

interface FakeClock {
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** Đồng hồ giả: mỗi lần "ngủ" thì nhảy thời gian, không chờ thật. */
function fakeClock(): FakeClock {
  let current = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    now: () => current,
  };
}

function limiterWith(
  overrides: Partial<SourceRuntimeConfig>,
  clock: FakeClock,
  random = () => 0.5
): SourceRequestLimiter {
  return new SourceRequestLimiter({
    source: VesselSource.SHIPINFO,
    config: { ...DEFAULT_CRAWL_RUNTIME_CONFIG, ...overrides },
    sleep: clock.sleep,
    now: clock.now,
    random,
  });
}

/** Promise mở được từ bên ngoài — để giữ task đứng yên trong test. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("không bao giờ vượt maxConcurrency", async () => {
  const clock = fakeClock();
  const limiter = limiterWith({ maxConcurrency: 3, minDelayMs: 0, maxDelayMs: 0 }, clock);

  let active = 0;
  let peak = 0;
  const gate = deferred();

  const tasks = Array.from({ length: 10 }, () =>
    limiter.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    })
  );

  // Cho vòng lặp sự kiện chạy để mọi slot khả dụng được chiếm.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(peak, 3);
  assert.equal(limiter.activeCount, 3);
  assert.equal(limiter.pendingCount, 7);

  gate.resolve();
  await Promise.all(tasks);
  assert.equal(peak, 3);
  assert.equal(limiter.activeCount, 0);
});

test("concurrency=1 -> các request cùng nguồn chạy TUẦN TỰ, không đè nhau", async () => {
  const clock = fakeClock();
  const limiter = limiterWith({ maxConcurrency: 1, minDelayMs: 0, maxDelayMs: 0 }, clock);
  const order: string[] = [];

  await Promise.all(
    ["a", "b", "c"].map((id) =>
      limiter.run(async () => {
        order.push(`${id}:start`);
        await Promise.resolve();
        order.push(`${id}:end`);
      })
    )
  );

  assert.deepEqual(order, [
    "a:start",
    "a:end",
    "b:start",
    "b:end",
    "c:start",
    "c:end",
  ]);
});

test("hai nguồn khác nhau KHÔNG chặn nhau", async () => {
  const clock = fakeClock();
  const shipinfo = limiterWith({ maxConcurrency: 1, minDelayMs: 0, maxDelayMs: 0 }, clock);
  const boatnerd = new SourceRequestLimiter({
    source: VesselSource.BOATNERD,
    config: { ...DEFAULT_CRAWL_RUNTIME_CONFIG, maxConcurrency: 1, minDelayMs: 0, maxDelayMs: 0 },
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
  });

  const blocked = deferred();
  let boatnerdDone = false;

  // ShipInfo bị treo cứng...
  const stuck = shipinfo.run(async () => {
    await blocked.promise;
  });
  // ...BoatNerd vẫn phải chạy xong bình thường.
  await boatnerd.run(async () => {
    boatnerdDone = true;
  });

  assert.equal(boatnerdDone, true);
  assert.equal(shipinfo.activeCount, 1);

  blocked.resolve();
  await stuck;
});

test("nghỉ giữa 2 lần bắt đầu, jitter nằm trong [min, max]", async () => {
  const clock = fakeClock();
  const limiter = limiterWith(
    { maxConcurrency: 1, minDelayMs: 2000, maxDelayMs: 5000 },
    clock,
    () => 0.5 // giữa khoảng -> 3500ms
  );

  await limiter.run(async () => undefined);
  await limiter.run(async () => undefined);
  await limiter.run(async () => undefined);

  // Request đầu không phải chờ; 2 request sau mỗi cái chờ đúng nhịp đã đặt.
  assert.deepEqual(clock.sleeps, [3500, 3500]);
  for (const ms of clock.sleeps) {
    assert.ok(ms >= 2000 && ms <= 5000, `nhịp ${ms} ngoài [2000,5000]`);
  }
});

test("min === max -> nhịp cố định, không jitter", async () => {
  const clock = fakeClock();
  const limiter = limiterWith({ maxConcurrency: 1, minDelayMs: 1000, maxDelayMs: 1000 }, clock, () => 0.9);

  await limiter.run(async () => undefined);
  await limiter.run(async () => undefined);
  assert.deepEqual(clock.sleeps, [1000]);
});

test("task ném lỗi vẫn nhả slot", async () => {
  const clock = fakeClock();
  const limiter = limiterWith({ maxConcurrency: 1, minDelayMs: 0, maxDelayMs: 0 }, clock);

  await assert.rejects(
    limiter.run(async () => {
      throw new Error("hỏng");
    }),
    /hỏng/
  );
  assert.equal(limiter.activeCount, 0);

  // Slot còn dùng được.
  assert.equal(await limiter.run(async () => "ok"), "ok");
});
