// ============================================================================
//  TEST · Vân tay observation — ổn định với thứ tự khoá, độc lập với fetchedAt
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { ObservationValidationStatus } from "../../domain/observations/ObservationValidation";
import {
  PositionObservation,
  VesselObservationType,
  createObservationKey,
} from "../../domain/observations/VesselObservation";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { observationFingerprint, stableSerialize } from "./observationFingerprint";

const MMSI = "305803000";
const FETCHED_AT = new Date("2026-08-14T10:00:00.000Z");

function position(
  overrides: {
    source?: VesselSource;
    fetchedAt?: Date;
    sourceReceivedAt?: Date | null;
    mmsi?: string;
    data?: Partial<PositionObservation["data"]>;
  } = {}
): PositionObservation {
  const source = overrides.source ?? VesselSource.VESSELFINDER;
  const fetchedAt = overrides.fetchedAt ?? FETCHED_AT;
  const mmsi = overrides.mmsi ?? MMSI;
  return {
    source,
    type: VesselObservationType.POSITION,
    vesselKey: createObservationKey({ mmsi }),
    fetchedAt,
    sourceReceivedAt: overrides.sourceReceivedAt ?? null,
    validation: { status: ObservationValidationStatus.VALID, errors: [] },
    data: {
      mmsi,
      lat: 1.5,
      lng: 103.5,
      speed: 12,
      receivedAt: fetchedAt,
      metadata: createSourceMetadata({ source, fetchedAt }),
      ...overrides.data,
    },
  };
}

test("cùng nguồn + cùng dữ liệu -> cùng vân tay", () => {
  assert.equal(observationFingerprint(position()), observationFingerprint(position()));
});

test("fetchedAt khác -> vân tay VẪN GIỐNG", () => {
  // Đây là điều kiện sống còn của dedupe: crawl lại 5 phút sau, nguồn nói y hệt.
  const first = observationFingerprint(position({ fetchedAt: FETCHED_AT }));
  const second = observationFingerprint(
    position({ fetchedAt: new Date("2026-08-14T10:04:00.000Z") })
  );
  assert.equal(first, second);
});

test("data.receivedAt bị loại: nguồn không có timestamp thì đó là đồng hồ của BOT", () => {
  // mp2 của VesselFinder không kèm mốc thời gian -> provider đặt
  // receivedAt = fetchedAt. Giữ nó trong vân tay thì mỗi vòng quét sinh một
  // bản ghi mới và dedupe vô tác dụng.
  const a = position({ data: { receivedAt: new Date("2026-08-14T10:00:00Z") } });
  const b = position({ data: { receivedAt: new Date("2026-08-14T10:30:00Z") } });
  assert.equal(observationFingerprint(a), observationFingerprint(b));

  // Mốc thời gian THẬT của nguồn vẫn tách được hai quan sát ra.
  assert.notEqual(
    observationFingerprint(position({ sourceReceivedAt: new Date("2026-08-14T09:50:00Z") })),
    observationFingerprint(position({ sourceReceivedAt: new Date("2026-08-14T09:55:00Z") }))
  );
});

test("nguồn khác -> vân tay khác", () => {
  assert.notEqual(
    observationFingerprint(position({ source: VesselSource.VESSELFINDER })),
    observationFingerprint(position({ source: VesselSource.SHIPINFO }))
  );
});

test("vị trí khác -> vân tay khác (KHÔNG làm tròn toạ độ)", () => {
  const base = observationFingerprint(position());
  assert.notEqual(base, observationFingerprint(position({ data: { lat: 10 } })));
  // 0.001 độ ~ 111m: tàu đã đi, đây là quan sát MỚI.
  assert.notEqual(base, observationFingerprint(position({ data: { lat: 1.501 } })));
  assert.notEqual(base, observationFingerprint(position({ data: { speed: 13 } })));
});

test("tàu khác -> vân tay khác", () => {
  assert.notEqual(
    observationFingerprint(position({ mmsi: MMSI })),
    observationFingerprint(position({ mmsi: "305803001" }))
  );
});

test("sourceReceivedAt khác -> vân tay khác", () => {
  assert.notEqual(
    observationFingerprint(position({ sourceReceivedAt: null })),
    observationFingerprint(position({ sourceReceivedAt: new Date("2026-08-14T09:58:00Z") }))
  );
});

test("thứ tự thuộc tính khác -> vân tay VẪN GIỐNG", () => {
  const source = VesselSource.VESSELFINDER;
  const metadata = createSourceMetadata({ source, fetchedAt: FETCHED_AT });

  const a = position();
  const b: PositionObservation = {
    ...a,
    // Cùng nội dung, khai theo thứ tự ngược lại.
    data: {
      metadata,
      receivedAt: FETCHED_AT,
      speed: 12,
      lng: 103.5,
      lat: 1.5,
      mmsi: MMSI,
    },
  };

  assert.equal(observationFingerprint(a), observationFingerprint(b));
});

test("field null và field vắng mặt là MỘT", () => {
  const withNull = position({ data: { course: null } });
  const withoutField = position();
  assert.equal(observationFingerprint(withNull), observationFingerprint(withoutField));
});

test("metadata bị loại khỏi vân tay (bên trong có fetchedAt)", () => {
  const a = position();
  const b: PositionObservation = {
    ...a,
    data: {
      ...a.data,
      metadata: createSourceMetadata({
        source: VesselSource.VESSELFINDER,
        fetchedAt: new Date("2030-01-01T00:00:00Z"),
        confidence: 0.9,
      }),
    },
  };
  assert.equal(observationFingerprint(a), observationFingerprint(b));
});

test("validation / rawPayload / parserVersion không đổi vân tay", () => {
  const a = position();
  const b: PositionObservation = {
    ...a,
    validation: {
      status: ObservationValidationStatus.PARTIAL,
      errors: [{ code: "INVALID_SPEED", message: "x" }],
    },
    rawPayload: "<html>...</html>",
    parserVersion: "vesselfinder-html-v2",
  };
  assert.equal(observationFingerprint(a), observationFingerprint(b));
});

test("stableSerialize: khoá được sắp xếp, Date -> ISO, rỗng bị loại", () => {
  assert.equal(stableSerialize({ b: 1, a: 2 }), stableSerialize({ a: 2, b: 1 }));
  assert.equal(stableSerialize({ at: new Date("2026-01-01T00:00:00Z") }), '{"at":"2026-01-01T00:00:00.000Z"}');
  assert.equal(stableSerialize({ a: 1, b: null, c: undefined }), '{"a":1}');
  assert.equal(stableSerialize({ n: Number.NaN }), "{}");
  assert.equal(stableSerialize([1, null, 2]), "[1,null,2]");
});

test("vân tay là SHA-256 hex", () => {
  assert.match(observationFingerprint(position()), /^[0-9a-f]{64}$/);
});
