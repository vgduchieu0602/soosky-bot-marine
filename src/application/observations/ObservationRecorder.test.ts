// ============================================================================
//  TEST · Mapper ProviderResult -> Observation, và ObservationRecorder
// ----------------------------------------------------------------------------
//  Điểm khoá chặt nhất: recorder KHÔNG được bịa `sourceReceivedAt`, và không
//  được gộp 4 nhóm canonical thành một bản ghi.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { ObservationValidationStatus } from "../../domain/observations/ObservationValidation";
import { VesselObservationType } from "../../domain/observations/VesselObservation";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { InMemoryVesselObservationRepository } from "../../infrastructure/persistence/InMemoryVesselObservationRepository";
import { ProviderDetailsResult } from "../providers/ProviderResults";
import { ObservationSaveStatus } from "./IVesselObservationRepository";
import { ObservationRecorder } from "./ObservationRecorder";
import { RawPayloadPolicy, REDACTED, prepareRawPayload, sanitizeRawPayload } from "./ObservationPolicy";
import { detailsResultToObservations } from "./providerResultToObservation";

const MMSI = "305803000";
const IMO = "9074729";
const FETCHED_AT = new Date("2026-08-14T10:00:00.000Z");
const SOURCE_RECEIVED_AT = new Date("2026-08-14T09:58:30.000Z");

const metadata = createSourceMetadata({
  source: VesselSource.VESSELFINDER,
  fetchedAt: FETCHED_AT,
});

function fullDetails(): ProviderDetailsResult {
  return {
    identity: { mmsi: MMSI, imo: IMO, name: "TEST CARRIER", metadata },
    particulars: { mmsi: MMSI, imo: IMO, length: 134, beam: 22, metadata },
    position: {
      mmsi: MMSI,
      lat: 1.5,
      lng: 103.5,
      speed: 12,
      receivedAt: FETCHED_AT,
      metadata,
    },
    voyage: { mmsi: MMSI, destination: "SGSIN", metadata },
  };
}

function recorderWith(
  options: { policy?: RawPayloadPolicy; maxBytes?: number } = {}
): { recorder: ObservationRecorder; repo: InMemoryVesselObservationRepository } {
  const repo = new InMemoryVesselObservationRepository({ now: () => FETCHED_AT });
  const recorder = new ObservationRecorder({
    repository: repo,
    rawPayloadPolicy: options.policy,
    maxRawPayloadBytes: options.maxBytes,
    now: () => FETCHED_AT,
  });
  return { recorder, repo };
}

test("ProviderDetailsResult có 4 nhóm -> 4 observation RIÊNG BIỆT", () => {
  const observations = detailsResultToObservations(fullDetails(), { now: FETCHED_AT });

  assert.equal(observations.length, 4);
  assert.deepEqual(
    observations.map((o) => o.type).sort(),
    [
      VesselObservationType.IDENTITY,
      VesselObservationType.PARTICULARS,
      VesselObservationType.POSITION,
      VesselObservationType.VOYAGE,
    ].sort()
  );
  // Không nhóm nào bị gộp vào nhóm khác.
  const positionObservation = observations.find((o) => o.type === VesselObservationType.POSITION);
  assert.equal("destination" in (positionObservation?.data ?? {}), false);
});

test("chỉ có position -> đúng 1 POSITION observation", () => {
  const observations = detailsResultToObservations(
    { position: fullDetails().position },
    { now: FETCHED_AT }
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].type, VesselObservationType.POSITION);
});

test("nguồn và fetchedAt lấy từ metadata của CHÍNH nhóm đó, giữ nguyên", () => {
  const observations = detailsResultToObservations(fullDetails(), { now: FETCHED_AT });
  for (const observation of observations) {
    assert.equal(observation.source, VesselSource.VESSELFINDER, observation.type);
    assert.equal(observation.fetchedAt.getTime(), FETCHED_AT.getTime(), observation.type);
  }
});

test("sourceReceivedAt giữ nguyên khi upstream CÓ", () => {
  const withTimestamp = createSourceMetadata({
    source: VesselSource.SHIPINFO,
    fetchedAt: FETCHED_AT,
    sourceReceivedAt: SOURCE_RECEIVED_AT,
  });
  const [observation] = detailsResultToObservations(
    { position: { ...fullDetails().position!, metadata: withTimestamp } },
    { now: FETCHED_AT }
  );

  assert.equal(observation.sourceReceivedAt?.getTime(), SOURCE_RECEIVED_AT.getTime());
  assert.equal(observation.source, VesselSource.SHIPINFO);
});

test("KHÔNG tự tạo sourceReceivedAt khi upstream không có", () => {
  const observations = detailsResultToObservations(fullDetails(), { now: FETCHED_AT });
  for (const observation of observations) {
    assert.equal(observation.sourceReceivedAt, null, observation.type);
    assert.notEqual(observation.sourceReceivedAt, observation.fetchedAt);
  }
});

test("nhóm thiếu cả mmsi lẫn imo bị bỏ qua, không làm hỏng cả mẻ", () => {
  const broken = {
    identity: { mmsi: "", imo: null, name: "X", metadata },
    position: fullDetails().position,
  } as unknown as ProviderDetailsResult;

  const observations = detailsResultToObservations(broken, { now: FETCHED_AT });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].type, VesselObservationType.POSITION);
});

test("observation hỏng vẫn mang đầy đủ metadata kiểm tra", () => {
  const bad: ProviderDetailsResult = {
    position: { ...fullDetails().position!, lat: 999, speed: 999 },
  };
  const [observation] = detailsResultToObservations(bad, { now: FETCHED_AT });

  assert.equal(observation.validation.status, ObservationValidationStatus.INVALID);
  assert.ok(observation.validation.errors.length >= 1);
  assert.equal(observation.source, VesselSource.VESSELFINDER);
  assert.equal(observation.fetchedAt.getTime(), FETCHED_AT.getTime());
});

test("parserVersion được gắn vào mọi observation", async () => {
  const { recorder, repo } = recorderWith();
  await recorder.recordDetails(fullDetails(), { parserVersion: "vesselfinder-html-v1" });

  assert.equal(repo.size, 4);
  for (const observation of repo.all()) {
    assert.equal(observation.parserVersion, "vesselfinder-html-v1");
  }
});

test("recorder ghi qua repository, trả kết quả theo thứ tự", async () => {
  const { recorder, repo } = recorderWith();
  const results = await recorder.recordDetails(fullDetails());

  assert.equal(results.length, 4);
  assert.equal(
    results.every((r) => r.status === ObservationSaveStatus.SAVED),
    true
  );
  assert.equal(repo.size, 4);

  // Ghi lại y hệt trong cửa sổ -> bị bỏ qua hết.
  const again = await recorder.recordDetails(fullDetails());
  assert.equal(
    again.every((r) => r.status === ObservationSaveStatus.SKIPPED_DUPLICATE),
    true
  );
  assert.equal(repo.size, 4);
});

test("danh sách rỗng -> không chạm repository", async () => {
  const { recorder, repo } = recorderWith();
  assert.deepEqual([...(await recorder.record([]))], []);
  assert.equal(repo.size, 0);
});

test("ON_ERROR (mặc định): bản sạch KHÔNG giữ payload, bản hỏng thì giữ", async () => {
  const { recorder, repo } = recorderWith();
  await recorder.recordDetails(fullDetails(), { rawPayload: "<html>ổn</html>" });
  for (const observation of repo.all()) {
    assert.equal(observation.rawPayload, undefined, observation.type);
  }

  const broken = recorderWith();
  await broken.recorder.recordDetails(
    { position: { ...fullDetails().position!, speed: 999 } },
    { rawPayload: "<html>hỏng</html>" }
  );
  const [saved] = broken.repo.all();
  assert.equal(saved.validation.status, ObservationValidationStatus.PARTIAL);
  assert.equal(saved.rawPayload, "<html>hỏng</html>");
});

test("NONE không bao giờ giữ; ALWAYS luôn giữ", async () => {
  const none = recorderWith({ policy: RawPayloadPolicy.NONE });
  await none.recorder.recordDetails(
    { position: { ...fullDetails().position!, speed: 999 } },
    { rawPayload: "<html/>" }
  );
  assert.equal(none.repo.all()[0].rawPayload, undefined);

  const always = recorderWith({ policy: RawPayloadPolicy.ALWAYS });
  await always.recorder.recordDetails(fullDetails(), { rawPayload: "<html/>" });
  for (const observation of always.repo.all()) {
    assert.equal(observation.rawPayload, "<html/>");
  }
});

test("payload quá lớn bị cắt và ĐÁNH DẤU", async () => {
  const { recorder, repo } = recorderWith({ policy: RawPayloadPolicy.ALWAYS, maxBytes: 32 });
  await recorder.recordDetails(
    { position: fullDetails().position },
    { rawPayload: "x".repeat(5000) }
  );

  const [saved] = repo.all();
  assert.equal((saved.rawPayload as string).length, 32);
  assert.equal(saved.rawPayloadTruncated, true);
});

test("field nhạy cảm bị xoá khỏi payload thô", () => {
  const sanitized = sanitizeRawPayload({
    url: "https://example.com",
    headers: {
      cookie: "session=abc",
      Authorization: "Bearer xyz",
      "x-api-key": "k",
      "user-agent": "SooskyCrawlBot/1.0",
    },
    body: { token: "t", data: "giữ lại" },
  }) as Record<string, Record<string, unknown>>;

  assert.equal(sanitized.headers.cookie, REDACTED);
  assert.equal(sanitized.headers.Authorization, REDACTED);
  assert.equal(sanitized.headers["x-api-key"], REDACTED);
  assert.equal(sanitized.headers["user-agent"], "SooskyCrawlBot/1.0");
  assert.equal(sanitized.body.token, REDACTED);
  assert.equal(sanitized.body.data, "giữ lại");
  assert.equal(sanitized.url, "https://example.com");
});

test("prepareRawPayload: object nhỏ giữ nguyên, object lớn -> chuỗi cắt", () => {
  const small = prepareRawPayload({ a: 1 });
  assert.deepEqual(small.payload, { a: 1 });
  assert.equal(small.truncated, false);

  const big = prepareRawPayload({ blob: "y".repeat(1000) }, 64);
  assert.equal(typeof big.payload, "string");
  assert.equal((big.payload as string).length, 64);
  assert.equal(big.truncated, true);

  assert.equal(prepareRawPayload(undefined).payload, undefined);
});

test("recordPositions gộp cả mẻ quét vùng vào một lần ghi", async () => {
  const { recorder, repo } = recorderWith();
  const results = await recorder.recordPositions([
    { position: fullDetails().position!, identity: fullDetails().identity },
    {
      position: { ...fullDetails().position!, mmsi: "305803001", lat: 2.5 },
    },
  ]);

  // Tàu 1: POSITION + IDENTITY. Tàu 2: chỉ POSITION.
  assert.equal(results.length, 3);
  assert.equal(repo.size, 3);
});
