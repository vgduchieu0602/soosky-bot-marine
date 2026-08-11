// ============================================================================
//  TEST · SourceMetadata — invariant provenance
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSourceMetadata, isValidConfidence, isValidDate } from "./SourceMetadata";
import { VesselSource } from "./VesselSource";

const FETCHED_AT = new Date("2026-08-12T00:00:00.000Z");

test("field tuỳ chọn được chuẩn hoá về null, không để undefined lọt xuống dưới", () => {
  const meta = createSourceMetadata({
    source: VesselSource.VESSELFINDER,
    fetchedAt: FETCHED_AT,
  });
  assert.equal(meta.source, "vesselfinder");
  assert.equal(meta.fetchedAt.toISOString(), "2026-08-12T00:00:00.000Z");
  assert.equal(meta.sourceReceivedAt, null);
  assert.equal(meta.confidence, null);
});

test("giữ được 2 mốc thời gian tách biệt: bot fetch vs nguồn nhận tín hiệu", () => {
  const sourceReceivedAt = new Date("2026-08-11T23:55:00.000Z");
  const meta = createSourceMetadata({
    source: VesselSource.AISSTREAM,
    fetchedAt: FETCHED_AT,
    sourceReceivedAt,
    confidence: 0.9,
  });
  assert.equal(meta.sourceReceivedAt?.toISOString(), "2026-08-11T23:55:00.000Z");
  assert.notEqual(meta.sourceReceivedAt?.getTime(), meta.fetchedAt.getTime());
  assert.equal(meta.confidence, 0.9);
});

test("Invalid Date bị chặn ngay lúc dựng", () => {
  assert.throws(
    () =>
      createSourceMetadata({
        source: VesselSource.VESSELFINDER,
        fetchedAt: new Date("khong-phai-ngay"),
      }),
    /fetchedAt/
  );
  assert.throws(
    () =>
      createSourceMetadata({
        source: VesselSource.VESSELFINDER,
        fetchedAt: FETCHED_AT,
        sourceReceivedAt: new Date("rac"),
      }),
    /sourceReceivedAt/
  );
});

test("confidence phải nằm trong [0, 1]", () => {
  assert.equal(isValidConfidence(0), true);
  assert.equal(isValidConfidence(1), true);
  assert.equal(isValidConfidence(1.01), false);
  assert.equal(isValidConfidence(-0.1), false);
  assert.equal(isValidConfidence(NaN), false);
  assert.throws(
    () =>
      createSourceMetadata({
        source: VesselSource.VESSELFINDER,
        fetchedAt: FETCHED_AT,
        confidence: 2,
      }),
    /confidence/
  );
});

test("isValidDate phân biệt Date hợp lệ với Invalid Date", () => {
  assert.equal(isValidDate(FETCHED_AT), true);
  assert.equal(isValidDate(new Date("x")), false);
  assert.equal(isValidDate("2026-08-12T00:00:00.000Z"), false);
});
