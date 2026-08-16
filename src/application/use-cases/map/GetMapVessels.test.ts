// ============================================================================
//  TEST · GetMapVessels + MapBoundingBox
// ----------------------------------------------------------------------------
//  Kho là bản giả ghi lại truy vấn nhận được -> kiểm được cả HÌNH DẠNG truy vấn
//  (mấy hộp, trần ứng viên) lẫn kết quả. Không Mongo, không mạng.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMapVesselRepository,
  MapVesselQuery,
  MapVesselQueryResult,
} from "../../contracts/repositories/IMapVesselRepository";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import { ResolvedCurrentVessel } from "../../services/resolution/ResolvedCurrentVessel";
import { PositionFreshness } from "../../services/resolution/PositionResolverPolicy";
import {
  MapBoundingBoxError,
  WORLD_BOUNDING_BOX,
  resolveViewport,
} from "../../services/map/MapBoundingBox";
import { GetMapVessels, InvalidViewportError, MAP_QUERY_LIMITS } from "./GetMapVessels";

const NOW = new Date("2026-08-16T12:00:00.000Z");
const FRESH = new Date(NOW.getTime() - 60_000);
const STALE = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);

function vessel(
  mmsi: string,
  lat: number,
  lon: number,
  options: { observedAt?: Date; name?: string; storedFreshness?: PositionFreshness } = {}
): ResolvedCurrentVessel {
  const observedAt = options.observedAt ?? FRESH;
  const position: VesselPositionReport = {
    mmsi,
    imo: null,
    lat,
    lng: lon,
    speed: 10,
    course: 90,
    heading: null,
    navStatus: { code: 0, text: "Under way using engine" },
    latLngApproximate: false,
    receivedAt: observedAt,
    metadata: createSourceMetadata({
      source: VesselSource.AISSTREAM,
      fetchedAt: NOW,
      sourceReceivedAt: observedAt,
    }),
  };
  return {
    vesselKey: { mmsi },
    identity:
      options.name === undefined
        ? null
        : ({
            mmsi,
            imo: null,
            name: {
              value: options.name,
              source: VesselSource.AISSTREAM,
              observedAt: null,
              fetchedAt: NOW,
              reason: "ONLY_AVAILABLE_VALUE",
              rejected: [],
            },
            callsign: null,
            vesselType: null,
            vesselTypeCode: null,
            flagCode: null,
            flagName: null,
          } as never),
    position: {
      position,
      source: VesselSource.AISSTREAM,
      observedAt,
      fetchedAt: NOW,
      freshness: options.storedFreshness ?? PositionFreshness.LIVE,
      reason: "ONLY_AVAILABLE_VALUE",
      rejected: [],
    } as never,
    particulars: null,
    voyage: null,
    resolvedAt: NOW,
  };
}

/** Kho giả: lọc theo hộp ngay trong bộ nhớ, và GHI LẠI truy vấn nhận được. */
class FakeMapRepository implements IMapVesselRepository {
  queries: MapVesselQuery[] = [];
  constructor(private readonly all: readonly ResolvedCurrentVessel[]) {}

  async findInBoxes(query: MapVesselQuery): Promise<MapVesselQueryResult> {
    this.queries.push(query);
    const inside = this.all.filter((item) => {
      const report = item.position?.position;
      if (report === undefined) return false;
      return query.boxes.some(
        (box) =>
          report.lat >= box.minLat &&
          report.lat <= box.maxLat &&
          report.lng >= box.minLon &&
          report.lng <= box.maxLon
      );
    });
    const limit = query.candidateLimit;
    return {
      candidates: Object.freeze(inside.slice(0, limit)),
      reachedCandidateLimit: inside.length > limit,
    };
  }
}

function useCase(vessels: readonly ResolvedCurrentVessel[]) {
  const repository = new FakeMapRepository(vessels);
  return { repository, sut: new GetMapVessels({ repository, now: () => NOW }) };
}

// ---------------------------------------------------------------------------
//  §3 + §24 · Kiểm tra hộp bao
// ---------------------------------------------------------------------------

test("§3 hộp hợp lệ -> một hộp, không cắt đường đổi ngày", () => {
  const result = resolveViewport({ minLat: 5, minLon: 100, maxLat: 15, maxLon: 110 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.boxes.length, 1);
  assert.equal(result.crossesAntiMeridian, false);
});

test("§24 toạ độ sai -> báo lỗi rõ, KHÔNG tự sửa hộ", () => {
  const cases: Array<[Record<string, number>, MapBoundingBoxError]> = [
    [{ minLat: Number.NaN, minLon: 0, maxLat: 1, maxLon: 1 }, MapBoundingBoxError.NOT_FINITE],
    [{ minLat: -91, minLon: 0, maxLat: 1, maxLon: 1 }, MapBoundingBoxError.LAT_OUT_OF_RANGE],
    [{ minLat: 0, minLon: 0, maxLat: 91, maxLon: 1 }, MapBoundingBoxError.LAT_OUT_OF_RANGE],
    [{ minLat: 0, minLon: -181, maxLat: 1, maxLon: 1 }, MapBoundingBoxError.LON_OUT_OF_RANGE],
    [{ minLat: 0, minLon: 0, maxLat: 1, maxLon: 181 }, MapBoundingBoxError.LON_OUT_OF_RANGE],
    // Vĩ độ KHÔNG vòng quanh -> đảo ngược là bug của người gọi.
    [{ minLat: 20, minLon: 0, maxLat: 10, maxLon: 1 }, MapBoundingBoxError.LAT_INVERTED],
  ];
  for (const [bbox, reason] of cases) {
    const result = resolveViewport(bbox as never);
    assert.equal(result.ok, false, JSON.stringify(bbox));
    if (!result.ok) assert.equal(result.reason, reason);
  }
});

test("§24 use case NÉM khi viewport sai, không gửi Polygon rác xuống kho", async () => {
  const { sut, repository } = useCase([]);
  await assert.rejects(
    () => sut.execute({ bbox: { minLat: 20, minLon: 0, maxLat: 10, maxLon: 5 } }),
    (error: unknown) =>
      error instanceof InvalidViewportError && error.reason === MapBoundingBoxError.LAT_INVERTED
  );
  assert.equal(repository.queries.length, 0, "kho không được gọi khi bbox sai");
});

// ---------------------------------------------------------------------------
//  §4 + §33 · Đường đổi ngày
// ---------------------------------------------------------------------------

test("§4 minLon 170, maxLon -170 -> HAI hộp, không phải lỗi", () => {
  const result = resolveViewport({ minLat: -10, minLon: 170, maxLat: 10, maxLon: -170 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.crossesAntiMeridian, true);
  assert.deepEqual(result.boxes, [
    { minLat: -10, maxLat: 10, minLon: 170, maxLon: 180 },
    { minLat: -10, maxLat: 10, minLon: -180, maxLon: -170 },
  ]);
});

test("§33 175E + 175W lọt, 0E bị loại", async () => {
  const { sut, repository } = useCase([
    vessel("111111111", 0, 175),
    vessel("222222222", 0, -175),
    vessel("333333333", 0, 0),
  ]);

  const result = await sut.execute({
    bbox: { minLat: -10, minLon: 170, maxLat: 10, maxLon: -170 },
  });

  assert.deepEqual(result.items.map((item) => item.mmsi), ["111111111", "222222222"]);
  assert.equal(result.crossesAntiMeridian, true);
  assert.equal(repository.queries[0].boxes.length, 2, "phải hỏi bằng HAI hộp");
});

test("§22 tàu sát biên không bị trả về hai lần", async () => {
  // Cùng một tàu trúng cả hai hộp trong bản giả -> use case vẫn chỉ ra một mục.
  const boundary = vessel("444444444", 0, 180);
  const { sut } = useCase([boundary, boundary]);
  const result = await sut.execute({
    bbox: { minLat: -10, minLon: 170, maxLat: 10, maxLon: -170 },
  });
  assert.equal(result.items.filter((item) => item.mmsi === "444444444").length, 1);
});

// ---------------------------------------------------------------------------
//  Hộp quá rộng phải bị cắt nhỏ — lỗi ĐO ĐƯỢC, không phải phòng xa
// ---------------------------------------------------------------------------

test("viewport toàn cầu bị cắt thành nhiều hộp dưới nửa cầu", () => {
  const result = resolveViewport(WORLD_BOUNDING_BOX);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Một Polygon lớn hơn nửa mặt cầu khiến Mongo chọn NHẦM phía trong: đo thật
  // với 10.000 tàu rải toàn cầu, hộp -180..180 chỉ trả về 3 tàu. Không lỗi nào
  // được ném ra — nên hàng rào phải nằm ở đây.
  assert.ok(result.boxes.length > 1, "hộp toàn cầu phải được cắt nhỏ");
  for (const box of result.boxes) {
    assert.ok(box.maxLon - box.minLon <= 90, `hộp rộng ${box.maxLon - box.minLon}° là quá lớn`);
  }

  // Hợp của các mảnh phải đúng bằng hộp gốc — cắt nhỏ không được làm mất vùng.
  assert.equal(Math.min(...result.boxes.map((b) => b.minLon)), -180);
  assert.equal(Math.max(...result.boxes.map((b) => b.maxLon)), 180);
  for (const box of result.boxes) {
    assert.equal(box.minLat, -90);
    assert.equal(box.maxLat, 90);
  }
});

test("hộp hẹp KHÔNG bị cắt vô ích", () => {
  const result = resolveViewport({ minLat: 5, minLon: 100, maxLat: 15, maxLon: 110 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.boxes.length, 1);
});

test("viewport toàn cầu vẫn trả đúng tàu sau khi cắt", async () => {
  const { sut } = useCase([
    vessel("111111111", 10, -170),
    vessel("222222222", -40, 0),
    vessel("333333333", 60, 170),
  ]);
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, limit: 100 });
  assert.equal(result.items.length, 3, "cắt hộp không được làm rơi tàu nào");
});

// ---------------------------------------------------------------------------
//  §26 + §23 · Trong / ngoài / trên biên
// ---------------------------------------------------------------------------

test("§26 chỉ tàu TRONG hộp được trả về", async () => {
  const { sut } = useCase([
    vessel("111111111", 10, 106),
    vessel("222222222", 40, 10),
  ]);
  const result = await sut.execute({ bbox: { minLat: 5, minLon: 100, maxLat: 15, maxLon: 110 } });
  assert.deepEqual(result.items.map((item) => item.mmsi), ["111111111"]);
});

test("§23 tàu nằm ĐÚNG trên cạnh vẫn được tính", async () => {
  const { sut } = useCase([vessel("111111111", 5, 100), vessel("222222222", 15, 110)]);
  const result = await sut.execute({ bbox: { minLat: 5, minLon: 100, maxLat: 15, maxLon: 110 } });
  assert.equal(result.items.length, 2);
});

// ---------------------------------------------------------------------------
//  §27 + §28 · Lọc độ tươi ĐỘNG
// ---------------------------------------------------------------------------

test("§27 tàu trong hộp nhưng mốc nguồn cũ -> KHÔNG xuất hiện", async () => {
  const { sut } = useCase([
    vessel("111111111", 10, 106),
    vessel("222222222", 10, 106, { observedAt: STALE }),
  ]);
  const result = await sut.execute({ bbox: { minLat: 5, minLon: 100, maxLat: 15, maxLon: 110 } });
  assert.deepEqual(result.items.map((item) => item.mmsi), ["111111111"]);
});

test("§28 freshness ĐÃ LƯU nói LIVE nhưng mốc đã cũ -> vẫn bị loại", async () => {
  const trap = vessel("222222222", 10, 106, {
    observedAt: STALE,
    storedFreshness: PositionFreshness.LIVE,
  });
  assert.equal(trap.position?.freshness, PositionFreshness.LIVE, "document vẫn nói LIVE");

  const { sut } = useCase([trap]);
  const result = await sut.execute({ bbox: { minLat: 5, minLon: 100, maxLat: 15, maxLon: 110 } });
  assert.deepEqual(result.items, []);
});

test("§7 use case truyền mốc lọc sơ bộ xuống kho, nhưng vẫn tự quyết kết quả", async () => {
  const { sut, repository } = useCase([vessel("111111111", 10, 106)]);
  await sut.execute({ bbox: { minLat: 5, minLon: 100, maxLat: 15, maxLon: 110 } });
  const since = repository.queries[0].observedSince!;
  assert.equal(since.toISOString(), new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString());
});

// ---------------------------------------------------------------------------
//  §29 · Identity thiếu
// ---------------------------------------------------------------------------

test("§29 tàu chỉ có vị trí, không tên/IMO/loại -> VẪN trả về", async () => {
  const { sut } = useCase([vessel("111111111", 10, 106)]);
  const result = await sut.execute({ bbox: { minLat: 5, minLon: 100, maxLat: 15, maxLon: 110 } });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].vesselName, null);
  assert.equal(result.items[0].imo, null);
  assert.equal(result.items[0].vesselTypeCode, null);
});

// ---------------------------------------------------------------------------
//  §31 + §32 + §14 · Trần và cờ bị cắt
// ---------------------------------------------------------------------------

function manyVessels(count: number): ResolvedCurrentVessel[] {
  return Array.from({ length: count }, (_, index) =>
    vessel(String(200_000_000 + index), 10, 106)
  );
}

test("§31 xin nhiều hơn trần cứng -> bị kẹp", async () => {
  const { sut } = useCase([]);
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, limit: 999_999 });
  assert.equal(result.limit, MAP_QUERY_LIMITS.maxLimit);
});

test("§31 limit rác -> quay về mặc định", async () => {
  const { sut } = useCase([]);
  for (const limit of [0, -5, Number.NaN]) {
    const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, limit });
    assert.equal(result.limit, MAP_QUERY_LIMITS.defaultLimit);
  }
});

test("§32 nhiều tàu hơn trần -> cắt và BÁO truncated", async () => {
  const { sut } = useCase(manyVessels(30));
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, limit: 10 });

  assert.equal(result.items.length, 10);
  assert.equal(result.truncated, true);
  // §16: thứ tự tất định -> cùng đầu vào cho cùng đầu ra.
  assert.deepEqual(
    result.items.map((item) => item.mmsi),
    [...result.items].map((item) => item.mmsi).sort()
  );
});

test("vừa đủ trần -> KHÔNG báo truncated", async () => {
  const { sut } = useCase(manyVessels(10));
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, limit: 10 });
  assert.equal(result.items.length, 10);
  assert.equal(result.truncated, false);
});

test("§17 đọc DƯ ứng viên để bộ lọc độ tươi không ăn mất chỗ", async () => {
  const { sut, repository } = useCase([]);
  await sut.execute({ bbox: WORLD_BOUNDING_BOX, limit: 1000 });
  assert.equal(
    repository.queries[0].candidateLimit,
    1000 * MAP_QUERY_LIMITS.overfetchMultiplier
  );
});

test("§17 trần ứng viên có giới hạn TUYỆT ĐỐI", async () => {
  const { sut, repository } = useCase([]);
  await sut.execute({ bbox: WORLD_BOUNDING_BOX, limit: MAP_QUERY_LIMITS.maxLimit });
  assert.ok(repository.queries[0].candidateLimit <= MAP_QUERY_LIMITS.maxCandidates);
});

test("§14 kho chạm trần ứng viên -> truncated=true dù kết quả chưa đầy trần", async () => {
  // 25 tàu tươi + kho chỉ đọc tới trần -> ta KHÔNG biết phần chưa đọc có gì.
  // Nói "đầy đủ" trong tình huống đó là nói dối.
  const stale = Array.from({ length: 25 }, (_, index) =>
    vessel(String(300_000_000 + index), 10, 106, { observedAt: STALE })
  );
  const { sut } = useCase([...manyVessels(5), ...stale]);
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, limit: 10 });

  assert.equal(result.items.length, 5, "chỉ 5 tàu tươi");
  assert.equal(result.truncated, true, "kho đã chạm trần -> phải nói thật");
  assert.equal(result.candidatesScanned, 20);
});

test("§25 viewport toàn cầu chạy được, nhưng vẫn có trần", async () => {
  const { sut } = useCase(manyVessels(50));
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, limit: 20 });
  assert.equal(result.items.length, 20);
  assert.equal(result.truncated, true);
});
