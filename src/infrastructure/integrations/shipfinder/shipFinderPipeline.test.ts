// ============================================================================
//  TEST TÍCH HỢP · Toàn bộ đường ống ShipFinder, KHÔNG mock provider
// ----------------------------------------------------------------------------
//  Chỉ giả lập ĐÚNG một thứ: transport HTTP. Còn lại là code thật:
//      fake transport -> ShipFinderClient -> ShipFinderParser -> ShipFinderMapper
//      -> ShipFinderProvider -> P4 runtime -> ObservationRecorder
//      -> InMemoryVesselObservationRepository
//
//  Không mạng, không MongoDB.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { ObservationRecorder } from "../../../application/services/observation/ObservationRecorder";
import { ProviderRegistry } from "../../../application/services/acquisition/ProviderRegistry";
import { ProviderOperation } from "../../../application/contracts/providers/VesselDataProvider";
import { SourceErrorCategory, SourceRequestError } from "../../../application/services/crawl-runtime/SourceError";
import { SourceHealthState } from "../../../application/services/crawl-runtime/SourceHealthTracker";
import { SourceRuntimeManager } from "../../../application/services/crawl-runtime/SourceRuntimeManager";
import {
  CollectStatus,
  CollectVesselObservations,
} from "../../../application/use-cases/CollectVesselObservations";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import { VesselObservationType } from "../../../domain/entities/VesselObservation";
import { imoIdentifier, mmsiIdentifier } from "../../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { InMemoryVesselObservationRepository } from "../../persistence/memory/InMemoryVesselObservationRepository";
import { ShipFinderClient } from "./ShipFinderClient";
import { SHIPFINDER_PARSER_VERSION } from "./ShipFinderParser";
import { ShipFinderProvider } from "./ShipFinderProvider";
import {
  FIXTURE_FULL_VESSEL,
  FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING,
  FIXTURE_NOT_FOUND,
  FIXTURE_STRUCTURE_DRIFT,
} from "./shipFinderFixtures";

const MMSI = "636018086";
const FETCHED_AT = new Date("2026-08-14T16:00:00.000Z");
/** Giả định vận hành từ P7.1, khai tường minh ở đây như composition root làm. */
const OFFSET_UTC_PLUS_8 = 480;

interface Pipeline {
  collect: CollectVesselObservations;
  repo: InMemoryVesselObservationRepository;
  runtime: SourceRuntimeManager;
  urls: string[];
}

function pipeline(
  html: string | (() => Promise<string>),
  options: { sourceUtcOffsetMinutes?: number } = {}
): Pipeline {
  const urls: string[] = [];
  const client = new ShipFinderClient({
    http: {
      async getText(url: string): Promise<string> {
        urls.push(url);
        return typeof html === "string" ? html : html();
      },
    },
  });

  const registry = new ProviderRegistry();
  registry.register(
    new ShipFinderProvider({
      client,
      now: () => FETCHED_AT,
      sourceUtcOffsetMinutes: options.sourceUtcOffsetMinutes,
    })
  );

  const repo = new InMemoryVesselObservationRepository({ now: () => FETCHED_AT });
  const runtime = new SourceRuntimeManager({ sleep: async () => undefined });

  return {
    urls,
    repo,
    runtime,
    collect: new CollectVesselObservations({
      registry,
      runtime,
      recorder: new ObservationRecorder({ repository: repo, now: () => FETCHED_AT }),
      parserVersionBySource: { [VesselSource.SHIPFINDER]: SHIPFINDER_PARSER_VERSION },
    }),
  };
}

const params = { source: VesselSource.SHIPFINDER, identifier: mmsiIdentifier(MMSI) };

// ---- Thành công -----------------------------------------------------------

test("tàu đầy đủ + có offset -> 4 nhóm IDENTITY/PARTICULARS/POSITION/VOYAGE", async () => {
  const { collect, repo, urls } = pipeline(FIXTURE_FULL_VESSEL, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });

  const result = await collect.execute(params);

  assert.equal(result.status, CollectStatus.RECORDED);
  assert.deepEqual(urls, [`https://www.shipfinder.com/ship/detail/mmsi/${MMSI}`]);
  assert.equal(repo.size, 4);
  assert.deepEqual(
    repo.all().map((o) => o.type).sort(),
    [
      VesselObservationType.IDENTITY,
      VesselObservationType.PARTICULARS,
      VesselObservationType.POSITION,
      VesselObservationType.VOYAGE,
    ].sort()
  );
});

test("observation mang đúng source, khoá tàu, parserVersion, validation", async () => {
  const { collect, repo } = pipeline(FIXTURE_FULL_VESSEL, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });
  const result = await collect.execute(params);

  for (const observation of repo.all()) {
    assert.equal(observation.source, VesselSource.SHIPFINDER);
    assert.equal(observation.vesselKey.mmsi, MMSI);
    assert.equal(observation.vesselKey.imo, "9467976");
    assert.equal(observation.parserVersion, SHIPFINDER_PARSER_VERSION);
    assert.equal(observation.validation.status, ObservationValidationStatus.VALID);
    assert.ok(observation.id, "đã được lưu");
  }

  // Vân tay do P5 tính, nằm ở kết quả ghi — mỗi nhóm một vân tay khác nhau.
  const fingerprints = result.observations.map((r) => r.fingerprint);
  assert.equal(fingerprints.length, 4);
  for (const fingerprint of fingerprints) assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(new Set(fingerprints).size, 4);
});

test("payload canonical: toạ độ decimal, heading, navStatus, kích thước", async () => {
  const { collect, repo } = pipeline(FIXTURE_FULL_VESSEL, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });
  await collect.execute(params);

  const identity = repo.all().find((o) => o.type === VesselObservationType.IDENTITY)?.data as {
    name?: string;
    callsign?: string;
    vesselType?: string;
    flag?: { code?: string | null } | null;
  };
  assert.equal(identity.name, "AGIA DOXA");
  assert.equal(identity.callsign, "D5OC7");
  assert.equal(identity.vesselType, "Cargo ship");
  assert.equal(identity.flag?.code, "LBR", "ISO3 giữ nguyên");

  const position = repo.all().find((o) => o.type === VesselObservationType.POSITION)?.data as {
    lat: number;
    lng: number;
    speed?: number | null;
    course?: number | null;
    heading?: number | null;
    navStatus?: { text?: string | null } | null;
  };
  // DDM "33-44.983 N" -> decimal.
  assert.ok(Math.abs(position.lat - 33.7497167) < 1e-4, `lat=${position.lat}`);
  assert.ok(Math.abs(position.lng - -118.20885) < 1e-4, `lng=${position.lng}`);
  assert.equal(position.speed, 0);
  assert.equal(position.course, 0.9);
  assert.equal(position.heading, 58);
  assert.equal(position.navStatus?.text, "Moored");

  const particulars = repo.all().find((o) => o.type === VesselObservationType.PARTICULARS)
    ?.data as { length?: number | null; beam?: number | null; draught?: number | null;
      builtYear?: number | null; deadweight?: number | null; grossTonnage?: number | null };
  assert.equal(particulars.length, 179);
  assert.equal(particulars.beam, 29);
  assert.equal(particulars.draught, 5.9);
  // Trang công khai không có ba field này.
  assert.equal(particulars.builtYear, null);
  assert.equal(particulars.deadweight, null);
  assert.equal(particulars.grossTonnage, null);
});

test("VOYAGE có destination nhưng ETA null — không bịa năm", async () => {
  const { collect, repo } = pipeline(FIXTURE_FULL_VESSEL, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });
  await collect.execute(params);

  const voyage = repo.all().find((o) => o.type === VesselObservationType.VOYAGE)?.data as {
    destination?: string | null;
    eta?: Date | null;
    currentPort?: string | null;
  };
  assert.equal(voyage.destination, "LONG BEACH, US");
  assert.equal(voyage.eta, null, 'nguồn cho "07-29 07:01" — thiếu năm');
  assert.equal(voyage.currentPort, null, "cảng cần đăng nhập/premium");
});

test("POSITION giữ mốc NGUỒN; nhóm khác không mượn mốc đó", async () => {
  const { collect, repo } = pipeline(FIXTURE_FULL_VESSEL, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });
  await collect.execute(params);

  const position = repo.all().find((o) => o.type === VesselObservationType.POSITION);
  // 23:51:36 (UTC+8 khai tường minh) -> 15:51:36Z
  assert.equal(position?.sourceReceivedAt?.toISOString(), "2026-08-14T15:51:36.000Z");
  assert.equal(position?.fetchedAt.getTime(), FETCHED_AT.getTime());
  assert.notEqual(position?.sourceReceivedAt?.getTime(), position?.fetchedAt.getTime());

  const identity = repo.all().find((o) => o.type === VesselObservationType.IDENTITY);
  assert.equal(identity?.sourceReceivedAt, null);
});

// ---- KHÔNG cấu hình múi giờ (BẮT BUỘC) ------------------------------------

test("KHÔNG khai offset -> ghi IDENTITY/PARTICULARS/VOYAGE, TUYỆT ĐỐI không POSITION", async () => {
  const { collect, repo } = pipeline(FIXTURE_FULL_VESSEL); // không truyền offset

  const result = await collect.execute(params);

  assert.equal(result.status, CollectStatus.RECORDED);
  assert.equal(repo.size, 3);
  assert.deepEqual(
    repo.all().map((o) => o.type).sort(),
    [
      VesselObservationType.IDENTITY,
      VesselObservationType.PARTICULARS,
      VesselObservationType.VOYAGE,
    ].sort()
  );
  // Không được có POSITION nào gắn fetchedAt làm mốc nguồn.
  assert.equal(
    repo.all().some((o) => o.type === VesselObservationType.POSITION),
    false
  );
});

// ---- Heading Unknown ------------------------------------------------------

test("heading Unknown -> null, nhưng course/speed/navStatus vẫn map", async () => {
  const { collect, repo } = pipeline(FIXTURE_MOVING_VESSEL_UNKNOWN_HEADING, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });
  await collect.execute({
    source: VesselSource.SHIPFINDER,
    identifier: mmsiIdentifier("367452710"),
  });

  const position = repo.all().find((o) => o.type === VesselObservationType.POSITION)?.data as {
    heading?: number | null;
    course?: number | null;
    speed?: number | null;
    navStatus?: { text?: string | null } | null;
  };
  assert.equal(position.heading, null);
  assert.equal(position.course, 97.5);
  assert.equal(position.speed, 10.6);
  assert.equal(position.navStatus?.text, "Under way using engine");
});

// ---- Toạ độ hỏng ----------------------------------------------------------

test("DDM hỏng -> vẫn ghi các nhóm khác, KHÔNG ghi POSITION", async () => {
  // Cùng fixture nhưng bẻ toạ độ (phút >= 60 là dữ liệu hỏng).
  const broken = FIXTURE_FULL_VESSEL.replace("33-44.983 N", "33-77.983 N");
  const { collect, repo } = pipeline(broken, { sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8 });

  const result = await collect.execute(params);

  assert.equal(result.status, CollectStatus.RECORDED);
  assert.equal(
    repo.all().some((o) => o.type === VesselObservationType.POSITION),
    false,
    "không được bịa toạ độ"
  );
  assert.equal(
    repo.all().some((o) => o.type === VesselObservationType.IDENTITY),
    true,
    "một nhóm hỏng không làm mất cả operation"
  );
});

// ---- Not found ------------------------------------------------------------

test("HTTP 200 + mọi ô \"-\" -> NOT_FOUND, 0 observation, nguồn KHÔNG degrade", async () => {
  const { collect, repo, runtime } = pipeline(FIXTURE_NOT_FOUND, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });

  const result = await collect.execute(params);

  assert.equal(result.status, CollectStatus.NOT_FOUND);
  assert.equal(repo.size, 0);

  const health = runtime.getHealth(VesselSource.SHIPFINDER);
  assert.equal(health.notFoundCount, 1);
  assert.equal(health.failureCount, 0);
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(health.state, SourceHealthState.HEALTHY);
});

// ---- Parser drift ---------------------------------------------------------

test("mất neo -> PARSE_ERROR, 0 observation, KHÔNG thành NOT_FOUND", async () => {
  const { collect, repo, runtime, urls } = pipeline(FIXTURE_STRUCTURE_DRIFT, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });

  await assert.rejects(
    () => collect.execute(params),
    (err: unknown) => {
      assert.ok(err instanceof SourceRequestError);
      assert.equal(err.category, SourceErrorCategory.PARSE_ERROR);
      return true;
    }
  );

  assert.equal(repo.size, 0);
  assert.equal(urls.length, 1, "PARSE_ERROR không retry");

  const health = runtime.getHealth(VesselSource.SHIPFINDER);
  assert.equal(health.parseErrorCount, 1);
  assert.equal(health.notFoundCount, 0, "drift KHÁC không-có-tàu");
  assert.equal(health.state, SourceHealthState.DEGRADED);
});

// ---- Định danh ------------------------------------------------------------

test("định danh IMO -> lỗi, KHÔNG gọi mạng, KHÔNG fallback sang nguồn khác", async () => {
  const { collect, urls, repo } = pipeline(FIXTURE_FULL_VESSEL, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });

  await assert.rejects(
    () =>
      collect.execute({
        source: VesselSource.SHIPFINDER,
        identifier: imoIdentifier("9467976"),
      }),
    /chỉ hỗ trợ định danh MMSI/
  );
  assert.deepEqual(urls, []);
  assert.equal(repo.size, 0);
});

// ---- Dedupe ---------------------------------------------------------------

test("chạy hai lần -> lần hai bị dedupe, kho không phình", async () => {
  const { collect, repo } = pipeline(FIXTURE_FULL_VESSEL, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });

  const first = await collect.execute(params);
  const second = await collect.execute(params);

  assert.equal(repo.size, 4);
  assert.equal(
    first.observations.every((r) => r.status === "SAVED"),
    true
  );
  assert.equal(
    second.observations.every((r) => r.status === "SKIPPED_DUPLICATE"),
    true
  );
});

// ---- Runtime --------------------------------------------------------------

test("dùng ĐÚNG config runtime của ShipFinder", async () => {
  const { runtime } = pipeline(FIXTURE_FULL_VESSEL);
  const config = runtime.getConfig(VesselSource.SHIPFINDER);

  assert.equal(config.maxConcurrency, 1);
  assert.equal(config.minDelayMs, 3000);
  assert.equal(config.maxDelayMs, 8000);
  // Trang 59 KB nhẹ hơn ShipInfo (290 KB) -> timeout ngắn hơn.
  assert.equal(config.timeoutMs, 15_000);
  assert.equal(config.maxRetries, 1);
  assert.equal(config.cooldownMs, 15 * 60 * 1000);
});

test("lỗi mạng ĐƯỢC retry theo policy P4 — provider vẫn không tự retry", async () => {
  let attempts = 0;
  const { collect, repo } = pipeline(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return FIXTURE_FULL_VESSEL;
    },
    { sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8 }
  );

  const result = await collect.execute(params);

  assert.equal(result.status, CollectStatus.RECORDED);
  assert.equal(attempts, 2, "P4 thử lại đúng 1 lần theo maxRetries của ShipFinder");
  assert.equal(repo.size, 4);
});

test("ShipFinder cooldown KHÔNG chặn ShipInfo hay VesselFinder", async () => {
  const { collect, runtime } = pipeline(FIXTURE_FULL_VESSEL, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });

  runtime.getHealthTracker(VesselSource.SHIPFINDER).enterCooldown(60_000);
  await assert.rejects(() => collect.execute(params), /đang hạ nhiệt/);

  // Hai nguồn kia có bộ runtime hoàn toàn tách rời.
  for (const other of [VesselSource.SHIPINFO, VesselSource.VESSELFINDER]) {
    assert.equal(runtime.getHealth(other).state, SourceHealthState.HEALTHY, other);
    assert.equal(runtime.getExecutor(other) !== undefined, true);
  }
  assert.equal(runtime.getHealth(VesselSource.SHIPFINDER).state, SourceHealthState.COOLDOWN);
});
