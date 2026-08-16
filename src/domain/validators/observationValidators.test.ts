// ============================================================================
//  TEST · Observation model + validators
// ----------------------------------------------------------------------------
//  Ranh giới quan trọng nhất: field PHỤ hỏng -> PARTIAL (giữ phần tốt), field
//  LÕI hỏng -> INVALID.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSourceMetadata } from "../value-objects/SourceMetadata";
import { VesselSource } from "../enums/VesselSource";
import {
  ObservationIssueCode,
  ObservationValidationStatus,
  isUsable,
} from "../enums/ObservationValidation";
import {
  MIN_BUILT_YEAR,
  maxBuiltYear,
  validateObservation,
} from "./observationValidators";
import {
  IdentityObservation,
  ParticularsObservation,
  PositionObservation,
  VesselObservationType,
  VoyageObservation,
  createObservationKey,
  hasUsableIdentifier,
} from "../entities/VesselObservation";

const FETCHED_AT = new Date("2026-08-14T10:00:00.000Z");
const NOW = new Date("2026-08-14T10:00:05.000Z");
const MMSI = "305803000";
const IMO = "9074729";

const metadata = createSourceMetadata({
  source: VesselSource.VESSELFINDER,
  fetchedAt: FETCHED_AT,
});

function positionObservation(
  overrides: Partial<PositionObservation["data"]> = {},
  key = createObservationKey({ mmsi: MMSI })
): PositionObservation {
  return {
    source: VesselSource.VESSELFINDER,
    type: VesselObservationType.POSITION,
    vesselKey: key,
    fetchedAt: FETCHED_AT,
    sourceReceivedAt: null,
    validation: { status: ObservationValidationStatus.VALID, errors: [] },
    data: {
      mmsi: MMSI,
      lat: 1.5,
      lng: 103.5,
      receivedAt: FETCHED_AT,
      metadata,
      ...overrides,
    },
  };
}

function particularsObservation(
  overrides: Partial<ParticularsObservation["data"]> = {}
): ParticularsObservation {
  return {
    source: VesselSource.VESSELFINDER,
    type: VesselObservationType.PARTICULARS,
    vesselKey: createObservationKey({ mmsi: MMSI }),
    fetchedAt: FETCHED_AT,
    validation: { status: ObservationValidationStatus.VALID, errors: [] },
    data: { mmsi: MMSI, length: 134, beam: 22, metadata, ...overrides },
  };
}

test("observation phải có MMSI hoặc IMO", () => {
  assert.throws(() => createObservationKey({}), /ít nhất một trong MMSI hoặc IMO/);
  assert.throws(() => createObservationKey({ mmsi: "   ", imo: "" }), /ít nhất một/);

  // Chỉ IMO cũng hợp lệ: nguồn tra lý lịch có thể chưa biết MMSI.
  const imoOnly = createObservationKey({ imo: IMO });
  assert.equal(imoOnly.imo, IMO);
  assert.equal(imoOnly.mmsi, undefined);
  assert.equal(hasUsableIdentifier(imoOnly), true);

  // Có cả hai thì giữ cả hai.
  const both = createObservationKey({ mmsi: MMSI, imo: IMO });
  assert.equal(both.mmsi, MMSI);
  assert.equal(both.imo, IMO);
});

test("không định danh nào hợp lệ -> INVALID", () => {
  const observation = positionObservation({}, createObservationKey({ mmsi: "12345" }));
  const validation = validateObservation(observation, { now: NOW });

  assert.equal(validation.status, ObservationValidationStatus.INVALID);
  assert.equal(
    validation.errors.some((e) => e.code === ObservationIssueCode.NO_IDENTIFIER),
    true
  );
  assert.equal(isUsable(validation), false);
});

test("MMSI sai định dạng được phát hiện", () => {
  const key = createObservationKey({ mmsi: "012345678", imo: IMO });
  const validation = validateObservation(positionObservation({}, key), { now: NOW });

  // IMO còn dùng được -> chỉ PARTIAL, không vứt cả bản ghi.
  assert.equal(validation.status, ObservationValidationStatus.PARTIAL);
  const invalidMmsi = validation.errors.find((e) => e.code === ObservationIssueCode.INVALID_MMSI);
  assert.equal(invalidMmsi?.field, "mmsi");
});

test("IMO sai checksum được phát hiện (MMSI vẫn tốt -> PARTIAL)", () => {
  const key = createObservationKey({ mmsi: MMSI, imo: "9074728" });
  const validation = validateObservation(positionObservation({}, key), { now: NOW });

  assert.equal(validation.status, ObservationValidationStatus.PARTIAL);
  assert.equal(
    validation.errors.some((e) => e.code === ObservationIssueCode.INVALID_IMO),
    true
  );
  assert.equal(isUsable(validation), true);
});

test("POSITION đầy đủ và hợp lệ -> VALID", () => {
  const validation = validateObservation(
    positionObservation({ speed: 12.3, course: 187, heading: 186 }),
    { now: NOW }
  );
  assert.equal(validation.status, ObservationValidationStatus.VALID);
  assert.deepEqual([...validation.errors], []);
});

test("toạ độ hỏng là LÕI -> INVALID", () => {
  for (const data of [{ lat: 91 }, { lng: 181 }, { lat: Number.NaN }]) {
    const validation = validateObservation(positionObservation(data), { now: NOW });
    assert.equal(validation.status, ObservationValidationStatus.INVALID, JSON.stringify(data));
    assert.equal(
      validation.errors.some((e) => e.code === ObservationIssueCode.INVALID_COORDINATE),
      true
    );
  }
});

test("speed/course/heading hỏng là PHỤ -> PARTIAL, toạ độ vẫn dùng được", () => {
  const validation = validateObservation(
    positionObservation({ speed: 999, course: 360, heading: 400 }),
    { now: NOW }
  );

  assert.equal(validation.status, ObservationValidationStatus.PARTIAL);
  assert.equal(isUsable(validation), true);
  const codes = validation.errors.map((e) => e.code);
  assert.equal(codes.includes(ObservationIssueCode.INVALID_SPEED), true);
  assert.equal(codes.includes(ObservationIssueCode.INVALID_COURSE), true);
  assert.equal(codes.includes(ObservationIssueCode.INVALID_HEADING), true);
});

test("PARTICULARS âm -> issue", () => {
  const validation = validateObservation(
    particularsObservation({ grossTonnage: -5, deadweight: -1, draught: -2 }),
    { now: NOW }
  );

  assert.equal(validation.status, ObservationValidationStatus.PARTIAL);
  const negatives = validation.errors.filter(
    (e) => e.code === ObservationIssueCode.NEGATIVE_VALUE
  );
  assert.equal(negatives.length, 3);
  assert.deepEqual(
    negatives.map((e) => e.field).sort(),
    ["deadweight", "draught", "grossTonnage"]
  );
});

test("builtYear phải hợp lý, cận trên tính từ `now` (không hardcode năm)", () => {
  assert.equal(maxBuiltYear(new Date("2026-01-01T00:00:00Z")), 2031);

  const tooOld = validateObservation(particularsObservation({ builtYear: MIN_BUILT_YEAR - 1 }), {
    now: NOW,
  });
  assert.equal(
    tooOld.errors.some((e) => e.code === ObservationIssueCode.UNREASONABLE_YEAR),
    true
  );

  const tooNew = validateObservation(
    particularsObservation({ builtYear: maxBuiltYear(NOW) + 1 }),
    { now: NOW }
  );
  assert.equal(
    tooNew.errors.some((e) => e.code === ObservationIssueCode.UNREASONABLE_YEAR),
    true
  );

  // Tàu đặt đóng trước: năm giao trong tương lai gần vẫn chấp nhận.
  const ordered = validateObservation(particularsObservation({ builtYear: 2028 }), { now: NOW });
  assert.equal(ordered.status, ObservationValidationStatus.VALID);
});

test("PARTICULARS rỗng trơn -> INVALID (không có gì để dùng)", () => {
  const empty: ParticularsObservation = {
    ...particularsObservation(),
    data: { mmsi: MMSI, metadata },
  };
  const validation = validateObservation(empty, { now: NOW });
  assert.equal(validation.status, ObservationValidationStatus.INVALID);
  assert.equal(
    validation.errors.some((e) => e.code === ObservationIssueCode.NO_DATA),
    true
  );
});

test("VOYAGE: timestamp hỏng -> PARTIAL", () => {
  const observation: VoyageObservation = {
    source: VesselSource.VESSELFINDER,
    type: VesselObservationType.VOYAGE,
    vesselKey: createObservationKey({ mmsi: MMSI }),
    fetchedAt: FETCHED_AT,
    validation: { status: ObservationValidationStatus.VALID, errors: [] },
    data: {
      mmsi: MMSI,
      destination: "SGSIN",
      eta: new Date("không phải ngày"),
      metadata,
    },
  };

  const validation = validateObservation(observation, { now: NOW });
  assert.equal(validation.status, ObservationValidationStatus.PARTIAL);
  const issue = validation.errors.find((e) => e.code === ObservationIssueCode.INVALID_TIMESTAMP);
  assert.equal(issue?.field, "eta");
});

test("IDENTITY hợp lệ -> VALID", () => {
  const observation: IdentityObservation = {
    source: VesselSource.VESSELFINDER,
    type: VesselObservationType.IDENTITY,
    vesselKey: createObservationKey({ mmsi: MMSI, imo: IMO }),
    fetchedAt: FETCHED_AT,
    validation: { status: ObservationValidationStatus.VALID, errors: [] },
    data: { mmsi: MMSI, imo: IMO, name: "TEST CARRIER", metadata },
  };
  assert.equal(
    validateObservation(observation, { now: NOW }).status,
    ObservationValidationStatus.VALID
  );
});

test("sourceReceivedAt KHÔNG tự động bằng fetchedAt", () => {
  const observation = positionObservation();
  assert.equal(observation.sourceReceivedAt, null);
  assert.notEqual(observation.sourceReceivedAt, observation.fetchedAt);
  // Metadata canonical cũng vậy: không cho thì null, không mượn đồng hồ của bot.
  assert.equal(metadata.sourceReceivedAt, null);
  assert.equal(metadata.fetchedAt.getTime(), FETCHED_AT.getTime());
});
