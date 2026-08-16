// ============================================================================
//  TEST · ObservationRetentionPolicy
// ----------------------------------------------------------------------------
//  Không đồng hồ thật: mọi mốc đều tính từ `fetchedAt` truyền vào.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselObservationType } from "../../../domain/entities/VesselObservation";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { DEFAULT_IDENTITY_RESOLVER_POLICY, DEFAULT_PARTICULARS_RESOLVER_POLICY, DEFAULT_VOYAGE_RESOLVER_POLICY } from "../resolution/StaticResolverPolicy";
import { DEFAULT_POSITION_RESOLVER_POLICY } from "../resolution/PositionResolverPolicy";
import {
  DEFAULT_OBSERVATION_RETENTION_CONFIG,
  observationExpiresAt,
  retentionMsFor,
} from "./ObservationRetentionPolicy";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FETCHED_AT = new Date("2026-08-16T12:00:00.000Z");

function retention(
  source: VesselSource,
  type: VesselObservationType,
  status: ObservationValidationStatus = ObservationValidationStatus.VALID
): number | null {
  return retentionMsFor({ source, type, validationStatus: status });
}

// ---------------------------------------------------------------------------
//  §5 · AIS position bị chặn ngắn hơn hẳn
// ---------------------------------------------------------------------------

test("§5 AISSTREAM POSITION giữ 48 giờ — ngoại lệ duy nhất theo nguồn", () => {
  assert.equal(retention(VesselSource.AISSTREAM, VesselObservationType.POSITION), 48 * HOUR);
});

test("§6 nguồn crawl KHÔNG dùng chung policy với AIS", () => {
  for (const source of [
    VesselSource.SHIPFINDER,
    VesselSource.SHIPINFO,
    VesselSource.VESSELFINDER,
    VesselSource.MYSHIPTRACKING,
  ]) {
    assert.equal(retention(source, VesselObservationType.POSITION), 7 * DAY, source);
  }
});

// ---------------------------------------------------------------------------
//  §7–§9 · Nhóm tĩnh và voyage
// ---------------------------------------------------------------------------

test("§7–§9 identity/particulars giữ 90 ngày, voyage 30 ngày", () => {
  assert.equal(retention(VesselSource.AISSTREAM, VesselObservationType.IDENTITY), 90 * DAY);
  assert.equal(retention(VesselSource.SHIPINFO, VesselObservationType.IDENTITY), 90 * DAY);
  assert.equal(retention(VesselSource.SHIPINFO, VesselObservationType.PARTICULARS), 90 * DAY);
  assert.equal(retention(VesselSource.SHIPFINDER, VesselObservationType.VOYAGE), 30 * DAY);
});

// ---------------------------------------------------------------------------
//  §14 · Bản ghi hỏng chỉ sống đủ để debug parser
// ---------------------------------------------------------------------------

test("§14 INVALID giữ 7 ngày, ĐÈ mọi luật theo nguồn/nhóm", () => {
  for (const type of [
    VesselObservationType.POSITION,
    VesselObservationType.IDENTITY,
    VesselObservationType.PARTICULARS,
    VesselObservationType.VOYAGE,
  ]) {
    assert.equal(
      retention(VesselSource.SHIPINFO, type, ObservationValidationStatus.INVALID),
      7 * DAY,
      type
    );
  }
  // Kể cả nhóm có retention NGẮN hơn 7 ngày cũng bị luật INVALID thay thế.
  assert.equal(
    retention(VesselSource.AISSTREAM, VesselObservationType.POSITION, ObservationValidationStatus.INVALID),
    7 * DAY
  );
});

test("PARTIAL KHÔNG bị rút ngắn — lõi vẫn dùng được và resolver vẫn nhận", () => {
  assert.equal(
    retention(VesselSource.AISSTREAM, VesselObservationType.POSITION, ObservationValidationStatus.PARTIAL),
    48 * HOUR
  );
  assert.equal(
    retention(VesselSource.SHIPINFO, VesselObservationType.IDENTITY, ObservationValidationStatus.PARTIAL),
    90 * DAY
  );
});

// ---------------------------------------------------------------------------
//  Ràng buộc CỨNG: retention >= cửa sổ nạp ứng viên của resolver
// ---------------------------------------------------------------------------

test("retention của nguồn crawl KHÔNG được ngắn hơn cửa sổ resolver", () => {
  // Ngắn hơn -> TTL xoá mất chính ứng viên resolver đang hỏi, và canonical bị
  // ghi đè bằng nhóm rỗng. Test này là hàng rào cho số trong config.
  const cases: Array<[VesselObservationType, number]> = [
    [VesselObservationType.POSITION, DEFAULT_POSITION_RESOLVER_POLICY.candidateWindowMs],
    [VesselObservationType.IDENTITY, DEFAULT_IDENTITY_RESOLVER_POLICY.candidateWindowMs],
    [VesselObservationType.PARTICULARS, DEFAULT_PARTICULARS_RESOLVER_POLICY.candidateWindowMs],
    [VesselObservationType.VOYAGE, DEFAULT_VOYAGE_RESOLVER_POLICY.candidateWindowMs],
  ];
  for (const [type, windowMs] of cases) {
    const value = retention(VesselSource.SHIPFINDER, type);
    assert.ok(
      value === null || value >= windowMs,
      `${type}: retention ${value} < cửa sổ resolver ${windowMs}`
    );
  }
});

test("AIS position là NGOẠI LỆ ĐƯỢC BIẾT: ngắn hơn cửa sổ resolver, có chủ ý", () => {
  const value = retention(VesselSource.AISSTREAM, VesselObservationType.POSITION);
  assert.ok(value !== null && value < DEFAULT_POSITION_RESOLVER_POLICY.candidateWindowMs);
  // Nhưng vẫn phải gấp đôi ngưỡng "hết hạn" 24h mà hệ thống đang dùng.
  assert.equal(value, 2 * DAY);
});

// ---------------------------------------------------------------------------
//  §11 · expiresAt
// ---------------------------------------------------------------------------

test("§11 expiresAt = fetchedAt + retention, KHÔNG dùng sourceReceivedAt", () => {
  const expires = observationExpiresAt({
    source: VesselSource.AISSTREAM,
    type: VesselObservationType.POSITION,
    validationStatus: ObservationValidationStatus.VALID,
    fetchedAt: FETCHED_AT,
  });
  assert.equal(expires?.toISOString(), "2026-08-18T12:00:00.000Z");
});

test("retention null -> KHÔNG có expiresAt (giữ vô thời hạn)", () => {
  const keepForever = {
    ...DEFAULT_OBSERVATION_RETENTION_CONFIG,
    byType: { ...DEFAULT_OBSERVATION_RETENTION_CONFIG.byType, [VesselObservationType.IDENTITY]: null },
  };
  assert.equal(
    retentionMsFor(
      {
        source: VesselSource.SHIPINFO,
        type: VesselObservationType.IDENTITY,
        validationStatus: ObservationValidationStatus.VALID,
      },
      keepForever
    ),
    null
  );
  assert.equal(
    observationExpiresAt(
      {
        source: VesselSource.SHIPINFO,
        type: VesselObservationType.IDENTITY,
        validationStatus: ObservationValidationStatus.VALID,
        fetchedAt: FETCHED_AT,
      },
      keepForever
    ),
    null
  );
});

test("mọi nhóm đều có giá trị — thiếu một nhóm là quên, không phải 'vô hạn'", () => {
  for (const type of Object.values(VesselObservationType)) {
    assert.notEqual(
      DEFAULT_OBSERVATION_RETENTION_CONFIG.byType[type],
      undefined,
      `thiếu retention cho ${type}`
    );
  }
});
