// ============================================================================
//  TEST TÍCH HỢP · Acquisition free, đầu-tới-cuối, KHÔNG mock pipeline
// ----------------------------------------------------------------------------
//  Giả lập ĐÚNG MỘT thứ: transport HTTP. Từ đó trở đi là code thật:
//
//      fake transport -> ShipFinderClient -> ShipFinderParser -> ShipFinderMapper
//        -> ShipFinderProvider (P3) -> SourceRequestExecutor (P4)
//        -> ObservationRecorder (P5) -> InMemoryVesselObservationRepository
//        -> 4 resolver (P8) -> InMemoryCurrentVesselRepository
//        -> LocalDataSufficiencyChecker (P9.2) -> FreeSourceSelector (P9.3)
//        -> AcquireFreeVesselData (P9.4)
//
//  Không mạng, không MongoDB. Một nguồn là đủ để chứng minh vòng khép kín —
//  nhiều nguồn thật sẽ biến test này thành bản sao của POC.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { ObservationRecorder } from "../services/observation/ObservationRecorder";
import { ProviderRegistry } from "../services/acquisition/ProviderRegistry";
import { SourceHealthState } from "../services/crawl-runtime/SourceHealthTracker";
import { SourceRuntimeManager } from "../services/crawl-runtime/SourceRuntimeManager";
import { FreeSourceSelector } from "../services/acquisition/FreeSourceSelector";
import { AcquisitionOutcome } from "../services/acquisition/AcquisitionAttempt";
import { DataNeedType } from "../services/acquisition/DataNeed";
import { VesselField } from "../../domain/enums/VesselField";
import { VesselSource } from "../../domain/enums/VesselSource";
import { InMemoryCurrentVesselRepository } from "../../infrastructure/persistence/memory/InMemoryCurrentVesselRepository";
import { InMemoryVesselObservationRepository } from "../../infrastructure/persistence/memory/InMemoryVesselObservationRepository";
import { ShipFinderClient } from "../../infrastructure/integrations/shipfinder/ShipFinderClient";
import { SHIPFINDER_PARSER_VERSION } from "../../infrastructure/integrations/shipfinder/ShipFinderParser";
import { ShipFinderProvider } from "../../infrastructure/integrations/shipfinder/ShipFinderProvider";
import {
  FIXTURE_FULL_VESSEL,
  FIXTURE_NOT_FOUND,
  FIXTURE_STRUCTURE_DRIFT,
} from "../../infrastructure/integrations/shipfinder/shipFinderFixtures";
import { AcquireFreeVesselData, AcquisitionStopReason } from "./AcquireFreeVesselData";
import { CheckLocalVesselSufficiency } from "./CheckLocalVesselSufficiency";
import { CollectVesselObservations } from "./CollectVesselObservations";
import { ResolveAndStoreCurrentVessel } from "./ResolveAndStoreCurrentVessel";
import { ResolveCurrentVessel } from "./ResolveCurrentVessel";

const MMSI = "636018086";
/**
 * Fixture khai `Last update = 2026-08-14 23:51:36` theo giờ NGUỒN (UTC+8), tức
 * `15:51:36Z`. Đặt `now` cách đó ~18 phút để vị trí rơi vào bậc LIVE — đúng
 * khoảng POC P7.4 đo được trên nguồn thật (tuổi 1–37 phút).
 */
const NOW = new Date("2026-08-14T16:10:00.000Z");
/** Giả định vận hành từ P7.1, khai tường minh như composition root làm. */
const OFFSET_UTC_PLUS_8 = 480;

interface Rig {
  acquire: AcquireFreeVesselData;
  currentRepo: InMemoryCurrentVesselRepository;
  observationRepo: InMemoryVesselObservationRepository;
  urls: string[];
}

function rig(html: string | (() => string)): Rig {
  const now = () => NOW;
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
      now,
      sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
    })
  );

  const observationRepo = new InMemoryVesselObservationRepository({ now });
  const currentRepo = new InMemoryCurrentVesselRepository({ now });

  const acquire = new AcquireFreeVesselData({
    checkLocal: new CheckLocalVesselSufficiency({ repository: currentRepo, now }),
    selector: new FreeSourceSelector(),
    collect: new CollectVesselObservations({
      registry,
      runtime: new SourceRuntimeManager({ sleep: async () => undefined }),
      recorder: new ObservationRecorder({ repository: observationRepo }),
      parserVersionBySource: { [VesselSource.SHIPFINDER]: SHIPFINDER_PARSER_VERSION },
    }),
    resolveAndStore: new ResolveAndStoreCurrentVessel({
      resolve: new ResolveCurrentVessel({ repository: observationRepo, now }),
      repository: currentRepo,
    }),
    healthOf: () => SourceHealthState.HEALTHY,
    now,
  });

  return { acquire, currentRepo, observationRepo, urls };
}

test("TÍCH HỢP · HTML thật -> canonical đủ cho need POSITION", async () => {
  const r = rig(FIXTURE_FULL_VESSEL);

  const result = await r.acquire.execute({ mmsi: MMSI }, { type: DataNeedType.POSITION });

  assert.equal(result.satisfied, true);
  assert.equal(result.stopReason, AcquisitionStopReason.SATISFIED_AFTER_ACQUISITION);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.source, VesselSource.SHIPFINDER);
  assert.equal(result.attempts[0]?.outcome, AcquisitionOutcome.SUCCESS);

  // Đúng một request lên "nguồn", đúng đường tra bằng MMSI.
  assert.equal(r.urls.length, 1);
  assert.match(r.urls[0], new RegExp(`/${MMSI}`));

  // Observation đã ghi, canonical đã dựng, xuất xứ còn nguyên.
  assert.ok(r.observationRepo.size > 0);
  assert.equal(r.currentRepo.size, 1);
  assert.equal(result.vessel?.position?.source, VesselSource.SHIPFINDER);
  assert.ok(result.vessel?.position?.observedAt, "mốc NGUỒN được giữ, không mượn fetchedAt");
});

test("TÍCH HỢP · lượt hai KHÔNG chạm nguồn — local-first thật sự", async () => {
  const r = rig(FIXTURE_FULL_VESSEL);

  await r.acquire.execute({ mmsi: MMSI }, { type: DataNeedType.POSITION });
  const urlsAfterFirst = r.urls.length;

  const second = await r.acquire.execute({ mmsi: MMSI }, { type: DataNeedType.POSITION });

  assert.equal(second.stopReason, AcquisitionStopReason.LOCAL_DATA_SUFFICIENT);
  assert.deepEqual([...second.attempts], []);
  assert.equal(r.urls.length, urlsAfterFirst, "0 request thêm");
});

test("TÍCH HỢP · trang không có tàu -> NOT_FOUND, KHÔNG ghi canonical", async () => {
  const r = rig(FIXTURE_NOT_FOUND);

  const result = await r.acquire.execute({ mmsi: MMSI }, { type: DataNeedType.POSITION });

  assert.equal(result.satisfied, false);
  assert.equal(result.attempts[0]?.outcome, AcquisitionOutcome.NOT_FOUND);
  assert.equal(r.currentRepo.size, 0, "không observation mới -> không phân xử -> không ghi");
  assert.equal(result.vessel, null);
});

test("TÍCH HỢP · HTML đổi form -> FAILED · PARSE_ERROR, không ném ra ngoài", async () => {
  const r = rig(FIXTURE_STRUCTURE_DRIFT);

  const result = await r.acquire.execute({ mmsi: MMSI }, { type: DataNeedType.POSITION });

  assert.equal(result.satisfied, false);
  assert.equal(result.attempts[0]?.outcome, AcquisitionOutcome.FAILED);
  assert.equal(result.attempts[0]?.failureCode, "PARSE_ERROR");
  assert.equal(r.currentRepo.size, 0);
});

test("TÍCH HỢP · một request getDetails lấp được NHIỀU nhóm", async () => {
  const r = rig(FIXTURE_FULL_VESSEL);

  const result = await r.acquire.execute({ mmsi: MMSI }, { type: DataNeedType.FULL });

  assert.equal(result.attempts.length, 1, "một lần chạm nguồn cho cả bốn nhóm");
  assert.equal(r.urls.length, 1);

  const vessel = result.vessel;
  assert.ok(vessel?.identity?.name);
  assert.ok(vessel?.position);
  assert.ok(vessel?.particulars);
  assert.ok(vessel?.voyage?.destination);
});

test("TÍCH HỢP · builtYear KHÔNG lấy được từ ShipFinder -> hết nguồn free", async () => {
  const r = rig(FIXTURE_FULL_VESSEL);

  const result = await r.acquire.execute(
    { mmsi: MMSI },
    { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.BUILT_YEAR] }
  );

  // ShipInfo mới là nguồn của builtYear, nhưng rig này không đăng ký nó ->
  // NO_PROVIDER. Kết quả vẫn là câu trả lời hợp lệ, KHÔNG phải exception, và
  // tuyệt đối không rơi sang nguồn trả tiền.
  assert.equal(result.satisfied, false);
  assert.equal(
    result.attempts.some((a) => a.source === VesselSource.MYSHIPTRACKING),
    false
  );
  assert.equal(
    result.attempts.some((a) => a.source === VesselSource.AISSTREAM),
    false
  );
});
