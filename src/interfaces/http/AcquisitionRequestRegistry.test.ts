import assert from "node:assert/strict";
import test from "node:test";
import { AcquisitionRequestRegistry } from "./AcquisitionRequestRegistry";

test("same acquisitionRequestId reuses the original in-flight/completed command", async () => {
  const registry = new AcquisitionRequestRegistry({ ttlMs: 60_000, maxEntries: 10 });
  let calls = 0;
  const run = async () => { calls += 1; return "once"; };
  const [a, b] = await Promise.all([registry.run("request-12345678", run), registry.run("request-12345678", run)]);
  assert.equal(a, "once");
  assert.equal(b, "once");
  assert.equal(calls, 1);
});
