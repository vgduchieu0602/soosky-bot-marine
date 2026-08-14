// ============================================================================
//  TEST · ResolveCurrentPosition — đường ĐỌC: kho -> resolver -> kết quả
// ----------------------------------------------------------------------------
//  Dùng repository THẬT (InMemory) chứ không mock, để chứng minh method truy vấn
//  mới và resolver ăn khớp nhau.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselPositionReport } from "../../domain/canonical/VesselPositionReport";
import { ObservationValidationStatus } from "../../domain/observations/ObservationValidation";
import {
  PositionObservation,
  VesselObservationType,
} from "../../domain/observations/VesselObservation";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { InMemoryVesselObservationRepository } from "../../infrastructure/persistence/InMemoryVesselObservationRepository";
import { DEFAULT_POSITION_RESOLVER_POLICY } from "../resolver/PositionResolverPolicy";
import { ResolutionReason } from "../resolver/ResolverTypes";
import { ResolveCurrentPosition } from "./ResolveCurrentPosition";

const MMSI = "636018086";
const NOW = new Date("2026-08-14T16:40:41.985Z");

function position(props: {
  source: VesselSource;
  sourceReceivedAt: Date | null;
  fetchedAt: Date;
  lat?: number;
  invalid?: boolean;
}): PositionObservation {
  const data: VesselPositionReport = {
    mmsi: MMSI,
    lat: props.lat ?? 33.749683,
    lng: -118.208917,
    latLngApproximate: false,
    receivedAt: props.sourceReceivedAt ?? props.fetchedAt,
    metadata: createSourceMetadata({
      source: props.source,
      fetchedAt: props.fetchedAt,
      sourceReceivedAt: props.sourceReceivedAt,
    }),
  };
  return {
    source: props.source,
    type: VesselObservationType.POSITION,
    vesselKey: { mmsi: MMSI },
    fetchedAt: props.fetchedAt,
    sourceReceivedAt: props.sourceReceivedAt,
    validation: {
      status: props.invalid
        ? ObservationValidationStatus.INVALID
        : ObservationValidationStatus.VALID,
      errors: [],
    },
    data,
  };
}

function harness(): { repo: InMemoryVesselObservationRepository; useCase: ResolveCurrentPosition } {
  const repo = new InMemoryVesselObservationRepository({ now: () => NOW });
  return {
    repo,
    useCase: new ResolveCurrentPosition({ repository: repo, now: () => NOW }),
  };
}

test("CA THẬT · đọc từ kho -> ShipFinder thắng vì mốc nguồn tươi hơn", async () => {
  const { repo, useCase } = harness();

  await repo.save(
    position({
      source: VesselSource.SHIPINFO,
      sourceReceivedAt: new Date("2026-08-13T20:11:07.000Z"),
      fetchedAt: new Date("2026-08-14T10:40:13.307Z"),
      lat: 33.74833,
    })
  );
  await repo.save(
    position({
      source: VesselSource.SHIPFINDER,
      sourceReceivedAt: new Date("2026-08-14T16:39:41.000Z"),
      fetchedAt: new Date("2026-08-14T16:40:41.985Z"),
      lat: 33.74968333333333,
    })
  );

  const resolved = await useCase.execute({ mmsi: MMSI });

  assert.ok(resolved);
  assert.equal(resolved.source, VesselSource.SHIPFINDER);
  assert.equal(resolved.reason, ResolutionReason.FRESHER_SOURCE_TIMESTAMP);
  assert.equal(resolved.position.lat, 33.74968333333333);
  assert.ok(resolved.observationId, "provenance trỏ về bản ghi gốc");
  assert.equal(resolved.rejected.length, 1);
});

test("tàu chưa có observation nào -> null, KHÔNG gọi nguồn để lấy thêm", async () => {
  const { useCase } = harness();
  assert.equal(await useCase.execute({ mmsi: "999999999" }), null);
});

test("chỉ có observation INVALID -> null", async () => {
  const { repo, useCase } = harness();
  await repo.save(
    position({
      source: VesselSource.SHIPFINDER,
      sourceReceivedAt: NOW,
      fetchedAt: NOW,
      invalid: true,
    })
  );
  assert.equal(await useCase.execute({ mmsi: MMSI }), null);
});

test("cửa sổ nạp ứng viên rộng hơn STALE -> bản ghi EXPIRED vẫn là phao cuối", async () => {
  const { repo, useCase } = harness();
  const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);

  await repo.save(
    position({ source: VesselSource.SHIPINFO, sourceReceivedAt: threeDaysAgo, fetchedAt: threeDaysAgo })
  );

  // Cắt đúng 24h thì bản ghi này biến mất; cửa sổ 7 ngày giữ nó lại.
  assert.ok(DEFAULT_POSITION_RESOLVER_POLICY.candidateWindowMs > 3 * 24 * 60 * 60 * 1000);

  const resolved = await useCase.execute({ mmsi: MMSI });
  assert.equal(resolved?.source, VesselSource.SHIPINFO);
  assert.equal(resolved?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
  assert.equal(resolved?.freshness, "EXPIRED");
});

test("bản ghi ngoài cửa sổ nạp bị bỏ qua", async () => {
  const { repo, useCase } = harness();
  const longAgo = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

  await repo.save(
    position({ source: VesselSource.SHIPINFO, sourceReceivedAt: longAgo, fetchedAt: longAgo })
  );
  assert.equal(await useCase.execute({ mmsi: MMSI }), null);
});

test("use case KHÔNG ghi gì vào kho", async () => {
  const { repo, useCase } = harness();
  await repo.save(
    position({ source: VesselSource.SHIPFINDER, sourceReceivedAt: NOW, fetchedAt: NOW })
  );
  const before = repo.size;

  await useCase.execute({ mmsi: MMSI });
  await useCase.execute({ mmsi: MMSI });

  assert.equal(repo.size, before, "resolver chỉ ĐỌC");
});
