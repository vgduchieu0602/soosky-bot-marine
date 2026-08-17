import { test } from "node:test";
import assert from "node:assert/strict";
import { ProductionRuntime } from "./ProductionRuntime";

test("runtime start and stop are idempotent and preserve shutdown order", async () => {
  const calls: string[] = [];
  const worker = {
    start: () => { calls.push("ais:start"); },
    stop: async () => { calls.push("ais:stop"); },
    health: () => ({ connected: true, pending: 0 }),
  };
  const scheduler = {
    start: () => { calls.push("scheduler:start"); },
    stop: async () => { calls.push("scheduler:stop"); },
  };
  const runtime = new ProductionRuntime({
    connectMongo: async () => { calls.push("mongo:connect"); },
    buildWorkers: async () => ({ ais: worker, schedulers: [scheduler] }),
    disconnectMongo: async () => { calls.push("mongo:disconnect"); },
    shutdownTimeoutMs: 100,
    logger: { info: () => {}, warn: () => {} },
  });

  await Promise.all([runtime.start(), runtime.start()]);
  await Promise.all([runtime.stop(), runtime.stop()]);

  assert.deepEqual(calls, [
    "mongo:connect",
    "ais:start",
    "scheduler:start",
    "scheduler:stop",
    "ais:stop",
    "mongo:disconnect",
  ]);
  assert.equal(runtime.health().status, "STOPPED");
});

test("runtime reports degraded while configured AIS is disconnected", async () => {
  const runtime = new ProductionRuntime({
    connectMongo: async () => {},
    buildWorkers: async () => ({
      ais: {
        start: () => {},
        stop: async () => {},
        health: () => ({ connected: false, pending: 7 }),
      },
      schedulers: [],
    }),
    disconnectMongo: async () => {},
    shutdownTimeoutMs: 100,
    logger: { info: () => {}, warn: () => {} },
  });

  await runtime.start();
  assert.equal(runtime.health().status, "DEGRADED");
  assert.equal(runtime.health().ais.pending, 7);
  await runtime.stop();
});
