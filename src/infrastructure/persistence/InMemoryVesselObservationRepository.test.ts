// ============================================================================
//  TEST · Observation repository — dedupe theo cửa sổ, KHÔNG nguồn nào đè nguồn nào
// ----------------------------------------------------------------------------
//  Chạy trên bản InMemory: cùng hợp đồng với bản Mongo, không cần MongoDB sống.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OBSERVATION_DEDUPE_CONFIG,
  dedupeWindowMs,
} from "../../application/observations/ObservationPolicy";
import { ObservationSaveStatus } from "../../application/observations/IVesselObservationRepository";
import { ObservationValidationStatus } from "../../domain/observations/ObservationValidation";
import {
  PositionObservation,
  VesselObservationType,
  createObservationKey,
} from "../../domain/observations/VesselObservation";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { InMemoryVesselObservationRepository } from "./InMemoryVesselObservationRepository";

const MMSI = "305803000";
const IMO = "9074729";
const T0 = new Date("2026-08-14T10:00:00.000Z");

function position(props: {
  source?: VesselSource;
  fetchedAt?: Date;
  lat?: number;
  status?: ObservationValidationStatus;
  mmsi?: string;
  imo?: string;
}): PositionObservation {
  const source = props.source ?? VesselSource.VESSELFINDER;
  const fetchedAt = props.fetchedAt ?? T0;
  const mmsi = props.mmsi ?? MMSI;
  return {
    source,
    type: VesselObservationType.POSITION,
    vesselKey: createObservationKey({ mmsi, imo: props.imo }),
    fetchedAt,
    sourceReceivedAt: null,
    validation: { status: props.status ?? ObservationValidationStatus.VALID, errors: [] },
    data: {
      mmsi,
      lat: props.lat ?? 1.5,
      lng: 103.5,
      receivedAt: fetchedAt,
      metadata: createSourceMetadata({ source, fetchedAt }),
    },
  };
}

/** Repo với đồng hồ điều khiển tay. */
function repoAt(clock: { current: Date }): InMemoryVesselObservationRepository {
  return new InMemoryVesselObservationRepository({ now: () => clock.current });
}

test("save trả SAVED kèm id và vân tay", async () => {
  const clock = { current: T0 };
  const repo = repoAt(clock);

  const result = await repo.save(position({}));
  assert.equal(result.status, ObservationSaveStatus.SAVED);
  assert.ok(result.id);
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(repo.size, 1);
});

test("bản ghi trùng TRONG cửa sổ bị bỏ qua", async () => {
  const clock = { current: T0 };
  const repo = repoAt(clock);

  await repo.save(position({ fetchedAt: T0 }));

  // 4 phút sau, nguồn nói y hệt -> cửa sổ POSITION là 5 phút.
  clock.current = new Date(T0.getTime() + 4 * 60 * 1000);
  const again = await repo.save(position({ fetchedAt: clock.current }));

  assert.equal(again.status, ObservationSaveStatus.SKIPPED_DUPLICATE);
  assert.equal(again.id, undefined);
  assert.equal(repo.size, 1);
});

test("bản ghi trùng NGOÀI cửa sổ được lưu", async () => {
  const clock = { current: T0 };
  const repo = repoAt(clock);
  const window = dedupeWindowMs(VesselObservationType.POSITION);
  assert.equal(window, 5 * 60 * 1000);

  await repo.save(position({ fetchedAt: T0 }));
  clock.current = new Date(T0.getTime() + window + 1000);
  const later = await repo.save(position({ fetchedAt: clock.current }));

  assert.equal(later.status, ObservationSaveStatus.SAVED);
  assert.equal(repo.size, 2);
});

test("dữ liệu đổi -> lưu ngay dù trong cửa sổ", async () => {
  const clock = { current: T0 };
  const repo = repoAt(clock);

  await repo.save(position({ lat: 1.5 }));
  clock.current = new Date(T0.getTime() + 60_000);
  const moved = await repo.save(position({ lat: 1.501, fetchedAt: clock.current }));

  assert.equal(moved.status, ObservationSaveStatus.SAVED);
  assert.equal(repo.size, 2);
});

test("nguồn A KHÔNG đè nguồn B — cả hai cùng tồn tại", async () => {
  const repo = repoAt({ current: T0 });

  await repo.save(position({ source: VesselSource.VESSELFINDER, lat: 1.5 }));
  await repo.save(position({ source: VesselSource.SHIPINFO, lat: 1.9 }));

  const found = await repo.findRecentByVessel({ mmsi: MMSI });
  assert.equal(found.length, 2);
  assert.deepEqual(
    found.map((o) => o.source).sort(),
    [VesselSource.SHIPINFO, VesselSource.VESSELFINDER].sort()
  );
  // Không có bước hợp nhất nào: hai lat khác nhau cùng nằm đó.
  assert.deepEqual(
    found.map((o) => (o.data as { lat: number }).lat).sort(),
    [1.5, 1.9]
  );
});

test("findLatestByVesselAndType trả bản mới nhất", async () => {
  const clock = { current: T0 };
  const repo = repoAt(clock);

  await repo.save(position({ fetchedAt: T0, lat: 1.5 }));
  clock.current = new Date(T0.getTime() + 10 * 60 * 1000);
  await repo.save(position({ fetchedAt: clock.current, lat: 2.5 }));

  const latest = await repo.findLatestByVesselAndType(
    { mmsi: MMSI },
    VesselObservationType.POSITION
  );
  assert.equal((latest?.data as { lat: number }).lat, 2.5);

  // Nhóm chưa có bản ghi nào -> null.
  assert.equal(
    await repo.findLatestByVesselAndType({ mmsi: MMSI }, VesselObservationType.VOYAGE),
    null
  );
});

test("INVALID bị loại khỏi truy vấn mặc định, includeInvalid=true mới thấy", async () => {
  const repo = repoAt({ current: T0 });

  await repo.save(position({ lat: 1.5 }));
  await repo.save(position({ lat: 99, status: ObservationValidationStatus.INVALID }));
  assert.equal(repo.size, 2, "bản hỏng VẪN được lưu để debug parser");

  const usable = await repo.findRecentByVessel({ mmsi: MMSI });
  assert.equal(usable.length, 1);
  assert.equal(usable[0].validation.status, ObservationValidationStatus.VALID);

  const all = await repo.findRecentByVessel({ mmsi: MMSI }, { includeInvalid: true });
  assert.equal(all.length, 2);
});

test("tìm theo IMO khi observation chỉ có IMO", async () => {
  const repo = repoAt({ current: T0 });
  await repo.save(position({ mmsi: MMSI, imo: IMO }));

  assert.equal((await repo.findRecentByVessel({ imo: IMO })).length, 1);
  assert.equal((await repo.findRecentByVessel({ mmsi: MMSI })).length, 1);
  assert.equal((await repo.findRecentByVessel({ imo: "9384198" })).length, 0);
  // Khoá rỗng -> không trả gì, không quét cả kho.
  assert.equal((await repo.findRecentByVessel({})).length, 0);
});

test("findRecentBySource + since + limit", async () => {
  const clock = { current: T0 };
  const repo = repoAt(clock);

  for (let i = 0; i < 3; i += 1) {
    clock.current = new Date(T0.getTime() + i * 10 * 60 * 1000);
    await repo.save(position({ fetchedAt: clock.current, lat: 1.5 + i }));
  }

  const all = await repo.findRecentBySource(VesselSource.VESSELFINDER);
  assert.equal(all.length, 3);
  // Mới nhất trước.
  assert.equal((all[0].data as { lat: number }).lat, 3.5);

  assert.equal((await repo.findRecentBySource(VesselSource.VESSELFINDER, { limit: 2 })).length, 2);
  assert.equal(
    (
      await repo.findRecentBySource(VesselSource.VESSELFINDER, {
        since: new Date(T0.getTime() + 15 * 60 * 1000),
      })
    ).length,
    1
  );
  assert.equal((await repo.findRecentBySource(VesselSource.SHIPINFO)).length, 0);
});

test("saveMany giữ đúng thứ tự và tự dedupe TRONG cùng một mẻ", async () => {
  const repo = repoAt({ current: T0 });

  const results = await repo.saveMany([
    position({ lat: 1.5 }),
    position({ lat: 1.5 }), // trùng bản trước ngay trong mẻ
    position({ lat: 2.5 }),
  ]);

  assert.deepEqual(
    results.map((r) => r.status),
    [
      ObservationSaveStatus.SAVED,
      ObservationSaveStatus.SKIPPED_DUPLICATE,
      ObservationSaveStatus.SAVED,
    ]
  );
  assert.equal(repo.size, 2);
});

test("cửa sổ dedupe: IDENTITY/PARTICULARS dài hơn POSITION", () => {
  const config = DEFAULT_OBSERVATION_DEDUPE_CONFIG;
  assert.equal(config.windowMsByType[VesselObservationType.POSITION], 5 * 60 * 1000);
  assert.equal(config.windowMsByType[VesselObservationType.IDENTITY], 24 * 60 * 60 * 1000);
  assert.equal(config.windowMsByType[VesselObservationType.PARTICULARS], 24 * 60 * 60 * 1000);
  assert.equal(config.windowMsByType[VesselObservationType.VOYAGE], 30 * 60 * 1000);
});
