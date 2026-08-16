// ============================================================================
//  TEST · Phân loại lỗi + retry policy
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { Errors } from "../../../domain/errors/AppError";
import { VesselSource } from "../../../domain/enums/VesselSource";
import {
  SourceErrorCategory,
  SourceRequestError,
  classifyError,
  classifyHttpStatus,
  networkError,
  notFoundError,
  parseError,
} from "./SourceError";
import {
  DEFAULT_RETRY_POLICY,
  RETRY_RATE_LIMITED_POLICY,
  backoffDelayMs,
  isRetryableCategory,
} from "./retryPolicy";
import { DEFAULT_CRAWL_RUNTIME_CONFIG } from "./SourceRuntimeConfig";

test("status HTTP -> category", () => {
  assert.equal(classifyHttpStatus(404), SourceErrorCategory.NOT_FOUND);
  assert.equal(classifyHttpStatus(403), SourceErrorCategory.BLOCKED);
  assert.equal(classifyHttpStatus(429), SourceErrorCategory.RATE_LIMITED);
  assert.equal(classifyHttpStatus(500), SourceErrorCategory.SERVER_ERROR);
  assert.equal(classifyHttpStatus(503), SourceErrorCategory.SERVER_ERROR);
  assert.equal(classifyHttpStatus(418), SourceErrorCategory.UNKNOWN);
});

test("status trên lỗi được ưu tiên hơn mọi manh mối khác", () => {
  assert.equal(classifyError({ status: 429 }), SourceErrorCategory.RATE_LIMITED);
  assert.equal(classifyError({ statusCode: 403 }), SourceErrorCategory.BLOCKED);
  assert.equal(classifyError({ response: { status: 502 } }), SourceErrorCategory.SERVER_ERROR);
  // 403 và 429 tách được KHI có status — điều mà mã AppError cũ không làm được.
  const blocked = Object.assign(Errors.SCRAPE_BLOCKED(), { status: 429 });
  assert.equal(classifyError(blocked), SourceErrorCategory.RATE_LIMITED);
});

test("mã AppError cũ vẫn phân loại được (giới hạn đã biết)", () => {
  assert.equal(classifyError(Errors.SHIP_NOT_FOUND("9074729")), SourceErrorCategory.NOT_FOUND);
  assert.equal(classifyError(Errors.SCRAPE_TIMEOUT()), SourceErrorCategory.TIMEOUT);
  // E-2001 gộp cả 403 lẫn 429 -> không có status thì chỉ ra được BLOCKED.
  assert.equal(classifyError(Errors.SCRAPE_BLOCKED()), SourceErrorCategory.BLOCKED);
  // E-2002 dùng cho cả lỗi mạng lẫn parse fail -> không đoán bừa.
  assert.equal(classifyError(Errors.SOURCE_ERROR("gì đó")), SourceErrorCategory.UNKNOWN);
  assert.equal(classifyError(Errors.SCRAPE_PARSE_FAIL("gì đó")), SourceErrorCategory.UNKNOWN);
});

test("tên lỗi runtime: TimeoutError/AbortError -> TIMEOUT, fetch failed -> NETWORK_ERROR", () => {
  const timeout = new Error("hết giờ");
  timeout.name = "TimeoutError";
  assert.equal(classifyError(timeout), SourceErrorCategory.TIMEOUT);

  const aborted = new Error("bị huỷ");
  aborted.name = "AbortError";
  assert.equal(classifyError(aborted), SourceErrorCategory.TIMEOUT);

  const network = new TypeError("fetch failed");
  assert.equal(classifyError(network), SourceErrorCategory.NETWORK_ERROR);
});

test("không nhận ra -> UNKNOWN, không đoán", () => {
  assert.equal(classifyError(new Error("???")), SourceErrorCategory.UNKNOWN);
  assert.equal(classifyError("chuỗi trần"), SourceErrorCategory.UNKNOWN);
  assert.equal(classifyError(null), SourceErrorCategory.UNKNOWN);
});

test("SourceRequestError giữ nguyên category khi phân loại lại", () => {
  const err = parseError(VesselSource.VESSELFINDER, "mapper hỏng");
  assert.equal(err.category, SourceErrorCategory.PARSE_ERROR);
  assert.equal(classifyError(err), SourceErrorCategory.PARSE_ERROR);
  assert.equal(networkError(VesselSource.SHIPINFO, "x").category, SourceErrorCategory.NETWORK_ERROR);
  assert.equal(notFoundError(VesselSource.SHIPINFO, "x").category, SourceErrorCategory.NOT_FOUND);
  assert.equal(err instanceof SourceRequestError, true);
});

test("retry: CHỈ timeout / server error / network error", () => {
  assert.equal(isRetryableCategory(SourceErrorCategory.TIMEOUT), true);
  assert.equal(isRetryableCategory(SourceErrorCategory.SERVER_ERROR), true);
  assert.equal(isRetryableCategory(SourceErrorCategory.NETWORK_ERROR), true);
});

test("retry: KHÔNG cho NOT_FOUND / PARSE_ERROR / BLOCKED / RATE_LIMITED / UNKNOWN", () => {
  for (const category of [
    SourceErrorCategory.NOT_FOUND,
    SourceErrorCategory.PARSE_ERROR,
    SourceErrorCategory.BLOCKED,
    SourceErrorCategory.RATE_LIMITED,
    SourceErrorCategory.UNKNOWN,
  ]) {
    assert.equal(isRetryableCategory(category), false, category);
  }
});

test("policy nới lỏng cho phép 429 nhưng KHÔNG bao giờ cho 403", () => {
  assert.equal(
    isRetryableCategory(SourceErrorCategory.RATE_LIMITED, RETRY_RATE_LIMITED_POLICY),
    true
  );
  assert.equal(isRetryableCategory(SourceErrorCategory.BLOCKED, RETRY_RATE_LIMITED_POLICY), false);
  // Mặc định vẫn là policy chặt.
  assert.equal(DEFAULT_RETRY_POLICY.retryableCategories.has(SourceErrorCategory.RATE_LIMITED), false);
});

test("backoff nhân đôi, chặn trên maxBackoffMs, jitter <= +25%", () => {
  const config = {
    ...DEFAULT_CRAWL_RUNTIME_CONFIG,
    initialBackoffMs: 1000,
    maxBackoffMs: 4000,
  };
  const noJitter = () => 0;

  assert.equal(backoffDelayMs(0, config, noJitter), 1000);
  assert.equal(backoffDelayMs(1, config, noJitter), 2000);
  assert.equal(backoffDelayMs(2, config, noJitter), 4000);
  assert.equal(backoffDelayMs(3, config, noJitter), 4000, "phải bị chặn trên");
  assert.equal(backoffDelayMs(99, config, noJitter), 4000);

  // Jitter tối đa +25%.
  assert.equal(backoffDelayMs(0, config, () => 1), 1250);
});
