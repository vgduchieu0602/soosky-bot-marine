// ============================================================================
//  TEST TÍCH HỢP · Toàn bộ đường ống ShipInfo, KHÔNG mock provider
// ----------------------------------------------------------------------------
//  Chỉ giả lập ĐÚNG một thứ: transport HTTP. Tất cả các mắt xích còn lại là code
//  thật:
//      fake transport -> ShipInfoClient -> ShipInfoParser -> ShipInfoMapper
//      -> ShipInfoProvider -> P4 runtime -> ObservationRecorder
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
} from "../../../application/use-cases/observation/CollectVesselObservations";
import { VesselObservationType } from "../../../domain/entities/VesselObservation";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import { imoIdentifier, mmsiIdentifier } from "../../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { InMemoryVesselObservationRepository } from "../../persistence/memory/InMemoryVesselObservationRepository";
import { ShipInfoClient } from "./ShipInfoClient";
import { SHIPINFO_PARSER_VERSION } from "./ShipInfoParser";
import { ShipInfoProvider } from "./ShipInfoProvider";
import {
  FIXTURE_ALL_POINTS_INVALID,
  FIXTURE_MALFORMED_JSON,
  FIXTURE_NORMAL_VESSEL,
  FIXTURE_PHP_FATAL_ERROR,
} from "./shipInfoFixtures";

const IMO = "9467976";
const MMSI = "636018086";
const FETCHED_AT = new Date("2026-08-14T08:00:00.000Z");

interface Pipeline {
  collect: CollectVesselObservations;
  repo: InMemoryVesselObservationRepository;
  runtime: SourceRuntimeManager;
  urls: string[];
}

/** Dựng đường ống thật; chỉ transport là giả. */
function pipeline(html: string | (() => Promise<string>)): Pipeline {
  const urls: string[] = [];
  const client = new ShipInfoClient({
    http: {
      async getText(url: string): Promise<string> {
        urls.push(url);
        return typeof html === "string" ? html : html();
      },
    },
  });

  const registry = new ProviderRegistry();
  registry.register(new ShipInfoProvider({ client, now: () => FETCHED_AT }));

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
      parserVersionBySource: { [VesselSource.SHIPINFO]: SHIPINFO_PARSER_VERSION },
    }),
  };
}

// ---- Thành công -----------------------------------------------------------

test("tàu đầy đủ -> IDENTITY + PARTICULARS + POSITION, KHÔNG có VOYAGE", async () => {
  const { collect, repo } = pipeline(FIXTURE_NORMAL_VESSEL);

  const result = await collect.execute({
    source: VesselSource.SHIPINFO,
    identifier: imoIdentifier(IMO),
  });

  assert.equal(result.status, CollectStatus.RECORDED);
  assert.equal(repo.size, 3);
  assert.deepEqual(
    repo.all().map((o) => o.type).sort(),
    [
      VesselObservationType.IDENTITY,
      VesselObservationType.PARTICULARS,
      VesselObservationType.POSITION,
    ].sort()
  );
  // destination/eta null ở 0/1073 điểm -> không phát nhóm voyage.
  assert.equal(
    repo.all().some((o) => o.type === VesselObservationType.VOYAGE),
    false
  );
});

test("observation mang đúng source, khoá tàu, parserVersion, validation", async () => {
  const { collect, repo } = pipeline(FIXTURE_NORMAL_VESSEL);
  await collect.execute({ source: VesselSource.SHIPINFO, identifier: imoIdentifier(IMO) });

  for (const observation of repo.all()) {
    assert.equal(observation.source, VesselSource.SHIPINFO);
    assert.equal(observation.vesselKey.mmsi, MMSI);
    assert.equal(observation.vesselKey.imo, IMO);
    assert.equal(observation.parserVersion, SHIPINFO_PARSER_VERSION);
    assert.equal(observation.validation.status, ObservationValidationStatus.VALID);
    assert.ok(observation.id, "đã được lưu");
  }
});

test("POSITION giữ mốc NGUỒN; IDENTITY/PARTICULARS không mượn mốc đó", async () => {
  const { collect, repo } = pipeline(FIXTURE_NORMAL_VESSEL);
  await collect.execute({ source: VesselSource.SHIPINFO, identifier: imoIdentifier(IMO) });

  const position = repo.all().find((o) => o.type === VesselObservationType.POSITION);
  // 19:39:30 (UTC+2 suy ra từ updated_utc) -> 17:39:30Z
  assert.equal(position?.sourceReceivedAt?.toISOString(), "2026-08-13T17:39:30.000Z");
  assert.equal(position?.fetchedAt.getTime(), FETCHED_AT.getTime());
  assert.notEqual(position?.sourceReceivedAt?.getTime(), position?.fetchedAt.getTime());

  const identity = repo.all().find((o) => o.type === VesselObservationType.IDENTITY);
  assert.equal(identity?.sourceReceivedAt, null, "lý lịch không có mốc nguồn");
});

test("payload canonical đúng nội dung, dimension bị bỏ", async () => {
  const { collect, repo } = pipeline(FIXTURE_NORMAL_VESSEL);
  await collect.execute({ source: VesselSource.SHIPINFO, identifier: imoIdentifier(IMO) });

  const identity = repo.all().find((o) => o.type === VesselObservationType.IDENTITY)?.data as {
    name?: string;
    callsign?: string;
    vesselType?: string;
    flag?: { code?: string | null; name?: string | null } | null;
  };
  assert.equal(identity.name, "Agia Doxa");
  assert.equal(identity.callsign, "D5OC7");
  assert.equal(identity.vesselType, "Bulk Carrier");
  assert.equal(identity.flag?.code, "LR");

  const particulars = repo.all().find((o) => o.type === VesselObservationType.PARTICULARS)
    ?.data as { builtYear?: number; deadweight?: number; length?: number | null; beam?: number | null };
  assert.equal(particulars.builtYear, 2010);
  assert.equal(particulars.deadweight, 33261);
  assert.equal(particulars.length, null, "dimension của ShipInfo không đáng tin");
  assert.equal(particulars.beam, null);

  const position = repo.all().find((o) => o.type === VesselObservationType.POSITION)?.data as {
    lat?: number;
    lng?: number;
    speed?: number;
    course?: number;
    heading?: number | null;
  };
  assert.equal(position.lat, 33.74968);
  assert.equal(position.lng, -118.20887);
  assert.equal(position.speed, 0);
  assert.equal(position.course, 58);
  assert.equal(position.heading, null);
});

test("tra bằng MMSI đi đúng URL IMO-0 và vẫn ghi được observation", async () => {
  const { collect, repo, urls } = pipeline(FIXTURE_NORMAL_VESSEL);

  const result = await collect.execute({
    source: VesselSource.SHIPINFO,
    identifier: mmsiIdentifier(MMSI),
  });

  assert.equal(result.status, CollectStatus.RECORDED);
  assert.deepEqual(urls, [`https://shipinfo.net/find_vessel_vessel_IMO-0_MMSI-${MMSI}`]);
  assert.equal(repo.size, 3);
});

test("operation GET_POSITION -> chỉ POSITION + IDENTITY", async () => {
  const { collect, repo } = pipeline(FIXTURE_NORMAL_VESSEL);

  await collect.execute({
    source: VesselSource.SHIPINFO,
    identifier: imoIdentifier(IMO),
    operation: ProviderOperation.GET_POSITION,
  });

  assert.equal(repo.size, 2);
  assert.equal(
    repo.all().some((o) => o.type === VesselObservationType.PARTICULARS),
    false
  );
});

// ---- Not found ------------------------------------------------------------

test("PHP fatal (HTTP 200) -> NOT_FOUND, 0 observation, nguồn KHÔNG degrade", async () => {
  const { collect, repo, runtime } = pipeline(FIXTURE_PHP_FATAL_ERROR);

  const result = await collect.execute({
    source: VesselSource.SHIPINFO,
    identifier: imoIdentifier(IMO),
  });

  assert.equal(result.status, CollectStatus.NOT_FOUND);
  assert.equal(repo.size, 0);

  const health = runtime.getHealth(VesselSource.SHIPINFO);
  assert.equal(health.notFoundCount, 1);
  assert.equal(health.failureCount, 0);
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(health.state, SourceHealthState.HEALTHY);
});

// ---- Parser drift ---------------------------------------------------------

test("JSON nhúng hỏng -> PARSE_ERROR, 0 observation, KHÔNG thành NOT_FOUND", async () => {
  const { collect, repo, runtime, urls } = pipeline(FIXTURE_MALFORMED_JSON);

  await assert.rejects(
    () => collect.execute({ source: VesselSource.SHIPINFO, identifier: imoIdentifier(IMO) }),
    (err: unknown) => {
      assert.ok(err instanceof SourceRequestError);
      assert.equal(err.category, SourceErrorCategory.PARSE_ERROR);
      return true;
    }
  );

  assert.equal(repo.size, 0);
  assert.equal(urls.length, 1, "PARSE_ERROR không retry");

  const health = runtime.getHealth(VesselSource.SHIPINFO);
  assert.equal(health.parseErrorCount, 1);
  assert.equal(health.notFoundCount, 0, "drift KHÁC không-có-tàu");
  assert.equal(health.state, SourceHealthState.DEGRADED);
});

// ---- Vị trí không dùng được ----------------------------------------------

test("mọi toạ độ hỏng -> vẫn ghi IDENTITY, KHÔNG ghi POSITION", async () => {
  const { collect, repo } = pipeline(FIXTURE_ALL_POINTS_INVALID);

  const result = await collect.execute({
    source: VesselSource.SHIPINFO,
    identifier: imoIdentifier(IMO),
  });

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

// ---- Dedupe ---------------------------------------------------------------

test("chạy hai lần -> lần hai bị dedupe, kho không phình", async () => {
  const { collect, repo } = pipeline(FIXTURE_NORMAL_VESSEL);
  const params = { source: VesselSource.SHIPINFO, identifier: imoIdentifier(IMO) };

  const first = await collect.execute(params);
  const second = await collect.execute(params);

  assert.equal(repo.size, 3, "vẫn đúng 3 bản ghi");
  assert.equal(
    first.observations.every((r) => r.status === "SAVED"),
    true
  );
  assert.equal(
    second.observations.every((r) => r.status === "SKIPPED_DUPLICATE"),
    true
  );
});

test("fetchedAt lệch vài giây KHÔNG tạo bản ghi mới", async () => {
  // Vân tay cố ý loại fetchedAt/receivedAt (OBSERVATION_STORAGE.md §7) — nếu
  // không, mỗi lần crawl lại là một bản ghi rác.
  const urls: string[] = [];
  const client = new ShipInfoClient({
    http: {
      async getText(url: string): Promise<string> {
        urls.push(url);
        return FIXTURE_NORMAL_VESSEL;
      },
    },
  });

  const registry = new ProviderRegistry();
  let clock = new Date("2026-08-14T08:00:00.000Z");
  registry.register(new ShipInfoProvider({ client, now: () => clock }));

  const repo = new InMemoryVesselObservationRepository({ now: () => clock });
  const collect = new CollectVesselObservations({
    registry,
    runtime: new SourceRuntimeManager({ sleep: async () => undefined }),
    recorder: new ObservationRecorder({ repository: repo, now: () => clock }),
  });
  const params = { source: VesselSource.SHIPINFO, identifier: imoIdentifier(IMO) };

  await collect.execute(params);
  clock = new Date("2026-08-14T08:00:47.000Z");
  await collect.execute(params);

  assert.equal(repo.size, 3);
});

// ---- Runtime --------------------------------------------------------------

test("dùng ĐÚNG config runtime của ShipInfo, không phải mặc định", async () => {
  const { runtime } = pipeline(FIXTURE_NORMAL_VESSEL);
  const config = runtime.getConfig(VesselSource.SHIPINFO);

  assert.equal(config.maxConcurrency, 1);
  assert.equal(config.minDelayMs, 3000);
  assert.equal(config.maxDelayMs, 8000);
  assert.equal(config.timeoutMs, 20_000);
  assert.equal(config.maxRetries, 1);
  assert.equal(config.cooldownMs, 15 * 60 * 1000);
});

test("lỗi mạng ĐƯỢC retry theo policy P4 — provider vẫn không tự retry", async () => {
  let attempts = 0;
  const { collect, repo } = pipeline(async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("fetch failed");
    return FIXTURE_NORMAL_VESSEL;
  });

  const result = await collect.execute({
    source: VesselSource.SHIPINFO,
    identifier: imoIdentifier(IMO),
  });

  assert.equal(result.status, CollectStatus.RECORDED);
  assert.equal(attempts, 2, "P4 thử lại đúng 1 lần theo maxRetries của ShipInfo");
  assert.equal(repo.size, 3);
});
