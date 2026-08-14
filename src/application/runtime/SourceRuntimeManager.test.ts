// ============================================================================
//  TEST · SourceRuntimeManager — mỗi nguồn một bộ, tuyệt đối không dùng chung
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { SourceUnavailableError } from "./SourceError";
import { SourceHealthState } from "./SourceHealthTracker";
import { SourceRuntimeManager } from "./SourceRuntimeManager";

function manager(): SourceRuntimeManager {
  return new SourceRuntimeManager({ sleep: async () => undefined });
}

test("executor được tạo LƯỜI và tái sử dụng cho cùng một nguồn", () => {
  const runtime = manager();
  assert.deepEqual([...runtime.getInitializedSources()], []);

  const first = runtime.getExecutor(VesselSource.SHIPINFO);
  const second = runtime.getExecutor(VesselSource.SHIPINFO);

  assert.equal(first, second, "cùng nguồn phải dùng chung limiter/health");
  assert.deepEqual([...runtime.getInitializedSources()], [VesselSource.SHIPINFO]);
});

test("hai nguồn = hai bộ runtime tách rời", async () => {
  const runtime = manager();
  const shipinfo = runtime.getExecutor(VesselSource.SHIPINFO);
  const boatnerd = runtime.getExecutor(VesselSource.BOATNERD);

  assert.notEqual(shipinfo, boatnerd);

  // Đẩy ShipInfo vào cooldown.
  runtime.getHealthTracker(VesselSource.SHIPINFO).enterCooldown(60_000);

  await assert.rejects(() => shipinfo.execute(async () => "x"), SourceUnavailableError);
  // BoatNerd hoàn toàn không bị ảnh hưởng.
  assert.equal(await boatnerd.execute(async () => "vẫn chạy"), "vẫn chạy");
  assert.equal(runtime.getHealth(VesselSource.BOATNERD).state, SourceHealthState.HEALTHY);
  assert.equal(runtime.getHealth(VesselSource.SHIPINFO).state, SourceHealthState.COOLDOWN);
});

test("config override đi vào từ composition root", () => {
  const runtime = new SourceRuntimeManager({
    configOverrides: { [VesselSource.SHIPINFO]: { maxConcurrency: 4, timeoutMs: 30_000 } },
    sleep: async () => undefined,
  });

  const config = runtime.getConfig(VesselSource.SHIPINFO);
  assert.equal(config.maxConcurrency, 4);
  assert.equal(config.timeoutMs, 30_000);
  // Nguồn khác không bị lây.
  assert.equal(runtime.getConfig(VesselSource.BOATNERD).maxConcurrency, 1);
});

test("từ chối nguồn không dùng crawl runtime", () => {
  const runtime = manager();
  assert.throws(() => runtime.getExecutor(VesselSource.AISSTREAM), /không dùng crawl runtime/);
  assert.throws(() => runtime.getExecutor(VesselSource.UNKNOWN), /không dùng crawl runtime/);
});

test("getAllHealth chỉ trả nguồn ĐÃ dùng, mảng đóng băng", async () => {
  const runtime = manager();
  await runtime.getExecutor(VesselSource.VESSELFINDER).execute(async () => "ok");

  const all = runtime.getAllHealth();
  assert.equal(all.length, 1);
  assert.equal(all[0].source, VesselSource.VESSELFINDER);
  assert.equal(all[0].successCount, 1);
  assert.equal(Object.isFrozen(all), true);
});
