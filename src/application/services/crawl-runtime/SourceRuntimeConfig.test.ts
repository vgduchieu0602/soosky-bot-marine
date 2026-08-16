// ============================================================================
//  TEST · SourceRuntimeConfig — config sai phải chết lúc dựng, không lúc chạy
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselSource } from "../../../domain/enums/VesselSource";
import {
  DEFAULT_CRAWL_RUNTIME_CONFIG,
  SourceRuntimeConfig,
  resolveSourceRuntimeConfig,
  usesCrawlRuntime,
  validateSourceRuntimeConfig,
} from "./SourceRuntimeConfig";

function configWith(overrides: Partial<SourceRuntimeConfig>): SourceRuntimeConfig {
  return { ...DEFAULT_CRAWL_RUNTIME_CONFIG, ...overrides };
}

test("mặc định bảo thủ: 1 request/lần, có nghỉ, có cooldown", () => {
  assert.equal(DEFAULT_CRAWL_RUNTIME_CONFIG.maxConcurrency, 1);
  assert.ok(DEFAULT_CRAWL_RUNTIME_CONFIG.minDelayMs > 0);
  assert.ok(DEFAULT_CRAWL_RUNTIME_CONFIG.cooldownMs > 0);
  assert.equal(Object.isFrozen(DEFAULT_CRAWL_RUNTIME_CONFIG), true);
});

test("maxConcurrency không hợp lệ bị từ chối", () => {
  assert.throws(() => validateSourceRuntimeConfig(configWith({ maxConcurrency: 0 })), /maxConcurrency/);
  assert.throws(() => validateSourceRuntimeConfig(configWith({ maxConcurrency: -1 })), /maxConcurrency/);
  assert.throws(() => validateSourceRuntimeConfig(configWith({ maxConcurrency: 1.5 })), /maxConcurrency/);
  assert.throws(
    () => validateSourceRuntimeConfig(configWith({ maxConcurrency: Number.NaN })),
    /số hữu hạn/
  );
});

test("maxDelayMs < minDelayMs bị từ chối", () => {
  assert.throws(
    () => validateSourceRuntimeConfig(configWith({ minDelayMs: 5000, maxDelayMs: 1000 })),
    /maxDelayMs \(1000\) phải >= minDelayMs \(5000\)/
  );
  // Bằng nhau thì hợp lệ (nhịp cố định, không jitter).
  validateSourceRuntimeConfig(configWith({ minDelayMs: 1000, maxDelayMs: 1000 }));
});

test("maxBackoffMs < initialBackoffMs bị từ chối", () => {
  assert.throws(
    () => validateSourceRuntimeConfig(configWith({ initialBackoffMs: 5000, maxBackoffMs: 1000 })),
    /maxBackoffMs/
  );
});

test("các ràng buộc còn lại", () => {
  assert.throws(() => validateSourceRuntimeConfig(configWith({ minDelayMs: -1 })), /minDelayMs/);
  assert.throws(() => validateSourceRuntimeConfig(configWith({ timeoutMs: 0 })), /timeoutMs/);
  assert.throws(() => validateSourceRuntimeConfig(configWith({ maxRetries: -1 })), /maxRetries/);
  assert.throws(
    () => validateSourceRuntimeConfig(configWith({ consecutiveFailuresBeforeCooldown: 0 })),
    /consecutiveFailuresBeforeCooldown/
  );
  assert.throws(() => validateSourceRuntimeConfig(configWith({ cooldownMs: -1 })), /cooldownMs/);
});

test("resolve ghép default + override theo nguồn + override người gọi", () => {
  const config = resolveSourceRuntimeConfig(VesselSource.VESSELFINDER, { maxConcurrency: 2 });
  assert.equal(config.maxConcurrency, 2);
  assert.equal(config.timeoutMs, DEFAULT_CRAWL_RUNTIME_CONFIG.timeoutMs);
  assert.equal(Object.isFrozen(config), true);

  // MyShipTracking là API trả tiền -> không áp nhịp nghỉ chống-ban.
  const paid = resolveSourceRuntimeConfig(VesselSource.MYSHIPTRACKING);
  assert.equal(paid.minDelayMs, 0);
  assert.equal(paid.maxDelayMs, 0);
});

test("resolve vẫn validate — override rác không lọt", () => {
  assert.throws(
    () => resolveSourceRuntimeConfig(VesselSource.SHIPINFO, { maxConcurrency: 0 }),
    /maxConcurrency/
  );
});

test("AISStream và UNKNOWN không dùng crawl runtime", () => {
  assert.equal(usesCrawlRuntime(VesselSource.AISSTREAM), false);
  assert.equal(usesCrawlRuntime(VesselSource.UNKNOWN), false);
  assert.equal(usesCrawlRuntime(VesselSource.VESSELFINDER), true);
  assert.equal(usesCrawlRuntime(VesselSource.SHIPINFO), true);
});
