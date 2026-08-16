// ============================================================================
//  TEST · QueryMap + MapQueryStrategy + MapGrid
// ----------------------------------------------------------------------------
//  Kho cụm là bản giả GỘP THẬT theo đúng công thức `MapGrid` -> test kiểm được
//  cả luật gộp lẫn luật điều phối, mà không cần Mongo.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMapClusterRepository,
  MapClusterQuery,
  MapClusterQueryResult,
} from "../../contracts/repositories/IMapClusterRepository";
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
import { WORLD_BOUNDING_BOX } from "../../services/map/MapBoundingBox";
import {
  MAX_ZOOM,
  WEB_MERCATOR_MAX_LAT,
  gridCellCenter,
  gridCellId,
  toGridCell,
} from "../../services/map/MapGrid";
import {
  DEFAULT_MAP_QUERY_STRATEGY,
  InvalidZoomError,
  MapQueryMode,
  planMapQuery,
} from "../../services/map/MapQueryStrategy";
import { GetMapVessels } from "./GetMapVessels";
import { MAP_CLUSTER_LIMITS, QueryMap } from "./QueryMap";

const NOW = new Date("2026-08-16T12:00:00.000Z");
const FRESH = new Date(NOW.getTime() - 60_000);
const STALE = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);

function vessel(
  mmsi: string,
  lat: number,
  lon: number,
  options: { observedAt?: Date; speed?: number; storedFreshness?: PositionFreshness } = {}
): ResolvedCurrentVessel {
  const observedAt = options.observedAt ?? FRESH;
  const position: VesselPositionReport = {
    mmsi,
    imo: null,
    lat,
    lng: lon,
    speed: options.speed ?? 10,
    course: 90,
    heading: null,
    navStatus: null,
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
    identity: null,
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

/** Gộp cụm trong bộ nhớ bằng ĐÚNG `MapGrid` mà pipeline Mongo mô phỏng lại. */
class FakeClusterRepository implements IMapClusterRepository {
  queries: MapClusterQuery[] = [];
  constructor(private readonly all: readonly ResolvedCurrentVessel[]) {}

  async aggregateClusters(query: MapClusterQuery): Promise<MapClusterQueryResult> {
    this.queries.push(query);

    const buckets = new Map<
      string,
      { x: number; y: number; count: number; latSum: number; lonSum: number; moving: number }
    >();

    for (const item of this.all) {
      const report = item.position?.position;
      const observedAt = item.position?.observedAt;
      if (report === undefined || !(observedAt instanceof Date)) continue;
      if (observedAt.getTime() < query.observedSince.getTime()) continue;
      // Cận TRÊN: mốc ở tương lai không phải "siêu tươi".
      if (observedAt.getTime() > query.observedBefore.getTime()) continue;

      const inside = query.boxes.some(
        (box) =>
          report.lat >= box.minLat &&
          report.lat <= box.maxLat &&
          report.lng >= box.minLon &&
          report.lng <= box.maxLon
      );
      if (!inside) continue;

      const cell = toGridCell(report.lat, report.lng, query.gridZoom);
      const key = gridCellId(cell);
      const bucket = buckets.get(key) ?? {
        x: cell.x,
        y: cell.y,
        count: 0,
        latSum: 0,
        lonSum: 0,
        moving: 0,
      };
      bucket.count += 1;
      bucket.latSum += report.lat;
      bucket.lonSum += report.lng;
      if ((report.speed ?? 0) > 0.5) bucket.moving += 1;
      buckets.set(key, bucket);
    }

    const sorted = [...buckets.values()].sort((a, b) => a.x - b.x || a.y - b.y);
    const reachedLimit = sorted.length > query.limit;
    return {
      rows: Object.freeze(
        sorted.slice(0, query.limit).map((bucket) => ({
          gridZoom: query.gridZoom,
          x: bucket.x,
          y: bucket.y,
          count: bucket.count,
          avgLat: bucket.latSum / bucket.count,
          avgLon: bucket.lonSum / bucket.count,
          movingCount: bucket.moving,
        }))
      ),
      reachedLimit,
    };
  }
}

class FakeVesselRepository implements IMapVesselRepository {
  constructor(private readonly all: readonly ResolvedCurrentVessel[]) {}
  async findInBoxes(query: MapVesselQuery): Promise<MapVesselQueryResult> {
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
    return {
      candidates: Object.freeze(inside.slice(0, query.candidateLimit)),
      reachedCandidateLimit: inside.length > query.candidateLimit,
    };
  }
}

function useCase(vessels: readonly ResolvedCurrentVessel[]) {
  const clusters = new FakeClusterRepository(vessels);
  const sut = new QueryMap({
    vessels: new GetMapVessels({ repository: new FakeVesselRepository(vessels), now: () => NOW }),
    clusters,
    now: () => NOW,
  });
  return { sut, clusters };
}

// ---------------------------------------------------------------------------
//  §32 · Chiến lược theo zoom
// ---------------------------------------------------------------------------

test("§32 zoom thấp -> CLUSTERS, zoom cao -> VESSELS, ranh giới tất định", () => {
  for (const zoom of [0, 1, 2, 3, 4, 5]) {
    assert.equal(planMapQuery(zoom).mode, MapQueryMode.CLUSTERS, `zoom ${zoom}`);
  }
  for (const zoom of [6, 7, 10, 22]) {
    assert.equal(planMapQuery(zoom).mode, MapQueryMode.VESSELS, `zoom ${zoom}`);
  }
  assert.equal(DEFAULT_MAP_QUERY_STRATEGY.vesselModeMinZoom, 6);
});

test("zoom sai -> ném, không đoán hộ", () => {
  for (const zoom of [-1, 23, Number.NaN, Number.POSITIVE_INFINITY, "5" as never, undefined]) {
    assert.throws(() => planMapQuery(zoom), InvalidZoomError, String(zoom));
  }
});

test("lưới gộp MỊN HƠN zoom hiển thị", () => {
  assert.equal(planMapQuery(0).gridZoom, 2);
  assert.equal(planMapQuery(5).gridZoom, 7);
  // Kẹp trần: không vượt MAX_ZOOM.
  assert.ok(planMapQuery(5, { vesselModeMinZoom: 23, gridZoomOffset: 30 }).gridZoom <= MAX_ZOOM);
});

// ---------------------------------------------------------------------------
//  §7 + §38 · Khoá cụm
// ---------------------------------------------------------------------------

test("§38 khoá cụm TẤT ĐỊNH theo (zoom, x, y)", () => {
  const a = toGridCell(10.5, 106.5, 6);
  const b = toGridCell(10.5001, 106.5001, 6);
  assert.equal(gridCellId(a), gridCellId(b), "hai tàu cùng ô -> cùng khoá");
  assert.match(gridCellId(a), /^6:\d+:\d+$/);
  assert.notEqual(gridCellId(toGridCell(10.5, 106.5, 7)), gridCellId(a), "zoom khác -> khoá khác");
});

test("§12 vĩ độ cực bị kẹp, KHÔNG cho ra NaN/Infinity", () => {
  for (const lat of [90, -90, 89.999, -89.999]) {
    const cell = toGridCell(lat, 0, 5);
    assert.ok(Number.isInteger(cell.x) && Number.isInteger(cell.y), `lat ${lat}`);
    assert.ok(cell.y >= 0 && cell.y < 2 ** 5, `lat ${lat} -> y=${cell.y}`);
  }
  assert.equal(toGridCell(90, 0, 5).y, toGridCell(WEB_MERCATOR_MAX_LAT, 0, 5).y);
});

test("kinh độ 180 không tràn ra ngoài bảng", () => {
  const cell = toGridCell(0, 180, 4);
  assert.equal(cell.x, 2 ** 4 - 1);
});

test("tâm hình học của ô nằm trong chính ô đó", () => {
  for (const zoom of [2, 5, 8]) {
    const cell = toGridCell(35.6, 139.7, zoom);
    const center = gridCellCenter(cell);
    assert.deepEqual(toGridCell(center.lat, center.lon, zoom), cell);
  }
});

// ---------------------------------------------------------------------------
//  §22 · Zoom cao dùng lại đường MAP-2
// ---------------------------------------------------------------------------

test("§22 zoom cao trả VESSELS, dùng lại GetMapVessels", async () => {
  const { sut } = useCase([vessel("111111111", 10, 106), vessel("222222222", 10.01, 106.01)]);
  const result = await sut.execute({
    bbox: { minLat: 5, minLon: 100, maxLat: 15, maxLon: 110 },
    zoom: 10,
  });

  assert.equal(result.mode, MapQueryMode.VESSELS);
  if (result.mode !== MapQueryMode.VESSELS) return;
  assert.deepEqual(result.items.map((item) => item.mmsi), ["111111111", "222222222"]);
});

// ---------------------------------------------------------------------------
//  §33 + §19 · Viewport toàn cầu
// ---------------------------------------------------------------------------

test("§33 world zoom thấp -> NHIỀU cụm rải nhiều vùng, không phải danh sách MMSI thiên lệch", async () => {
  const vessels = [
    vessel("111111111", 1, 103), // Singapore
    vessel("111111112", 1.1, 103.1),
    vessel("222222221", 51, 4), // Rotterdam
    vessel("222222222", 51.1, 4.1),
    vessel("333333331", 33, -118), // Long Beach
    vessel("444444441", -34, 151), // Sydney
  ];
  const { sut } = useCase(vessels);
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 2 });

  assert.equal(result.mode, MapQueryMode.CLUSTERS);
  if (result.mode !== MapQueryMode.CLUSTERS) return;

  assert.ok(result.clusters.length >= 4, `mong đợi >=4 vùng, nhận ${result.clusters.length}`);
  // §28/§29: mỗi tàu đếm đúng MỘT lần, tổng không đổi.
  assert.equal(result.representedVessels, vessels.length);
  assert.equal(result.truncated, false);
  assert.equal(result.gridZoom, 4);
});

// ---------------------------------------------------------------------------
//  §34 + §35 · Cảng đông vs vùng thưa
// ---------------------------------------------------------------------------

test("§34 nhiều tàu sát nhau -> MỘT cụm, đếm đúng", async () => {
  const dense = Array.from({ length: 50 }, (_, index) =>
    vessel(String(200_000_000 + index), 1 + index / 10_000, 103 + index / 10_000)
  );
  const { sut } = useCase(dense);
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 2 });

  assert.equal(result.mode, MapQueryMode.CLUSTERS);
  if (result.mode !== MapQueryMode.CLUSTERS) return;
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].count, 50);
  // §13: tâm là toạ độ TRUNG BÌNH của đám tàu, không phải tâm hình học của ô.
  assert.ok(Math.abs(result.clusters[0].lat - 1.00245) < 0.01);
});

test("§35 tàu xa nhau -> cụm riêng", async () => {
  const { sut } = useCase([
    vessel("111111111", 1, 103),
    vessel("222222222", 51, 4),
  ]);
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 2 });
  assert.equal(result.mode, MapQueryMode.CLUSTERS);
  if (result.mode !== MapQueryMode.CLUSTERS) return;
  assert.equal(result.clusters.length, 2);
  assert.deepEqual(result.clusters.map((c) => c.count), [1, 1]);
});

// ---------------------------------------------------------------------------
//  §36 + §14 · Chỉ đếm tàu ĐỦ ĐIỀU KIỆN
// ---------------------------------------------------------------------------

test("§36 cùng một ô có tàu tươi và tàu cũ -> chỉ đếm tàu tươi", async () => {
  const { sut, clusters } = useCase([
    vessel("111111111", 1, 103),
    vessel("222222222", 1.001, 103.001, { observedAt: STALE }),
    // Bẫy: document vẫn nói LIVE nhưng mốc đã 3 ngày.
    vessel("333333333", 1.002, 103.002, {
      observedAt: STALE,
      storedFreshness: PositionFreshness.LIVE,
    }),
  ]);
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 2 });

  assert.equal(result.mode, MapQueryMode.CLUSTERS);
  if (result.mode !== MapQueryMode.CLUSTERS) return;
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].count, 1, "tàu cũ KHÔNG được tính vào cụm");

  // Ngưỡng lọc lấy từ chính chính sách readiness, không phải số thứ hai.
  const since = clusters.queries[0].observedSince;
  assert.equal(since.toISOString(), new Date(NOW.getTime() - 24 * 3600_000).toISOString());
});

test("§20 mốc nguồn ở TƯƠNG LAI xa cũng bị loại khỏi cụm, giống chế độ tàu", async () => {
  // Lỗ hổng của MAP-3: bộ lọc cụm chỉ có `$gte` nên một mốc hỏng ở tương lai
  // lọt vào MỌI cụm, vĩnh viễn — trong khi chế độ VESSELS đã loại nó từ MAP-1.
  // Hai chế độ nói hai điều khác nhau về cùng một con tàu.
  const future = new Date(NOW.getTime() + 60 * 60 * 1000);
  const { sut, clusters } = useCase([
    vessel("111111111", 1, 103),
    vessel("222222222", 1.001, 103.001, { observedAt: future }),
  ]);

  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 2 });
  assert.equal(result.mode, MapQueryMode.CLUSTERS);
  if (result.mode !== MapQueryMode.CLUSTERS) return;
  assert.equal(result.representedVessels, 1, "mốc tương lai KHÔNG được đếm");

  // Cận trên lấy từ chính `futureToleranceMs` của readiness — không phải số mới.
  assert.equal(
    clusters.queries[0].observedBefore.toISOString(),
    new Date(NOW.getTime() + 5 * 60_000).toISOString()
  );
});

test("§20 hai chế độ loại CÙNG một tập mốc hỏng", async () => {
  const future = new Date(NOW.getTime() + 60 * 60 * 1000);
  const { sut } = useCase([
    vessel("111111111", 10, 106),
    vessel("222222222", 10.01, 106.01, { observedAt: future }),
  ]);
  const bbox = { minLat: 5, minLon: 100, maxLat: 15, maxLon: 110 };

  const asVessels = await sut.execute({ bbox, zoom: 10 });
  const asClusters = await sut.execute({ bbox, zoom: 2 });

  assert.equal(asVessels.mode, MapQueryMode.VESSELS);
  assert.equal(asClusters.mode, MapQueryMode.CLUSTERS);
  if (asVessels.mode !== MapQueryMode.VESSELS || asClusters.mode !== MapQueryMode.CLUSTERS) return;

  assert.equal(asVessels.items.length, 1);
  assert.equal(asClusters.representedVessels, 1, "cùng một con số ở cả hai chế độ");
});

test("movingCount tách tàu đang chạy khỏi tàu đứng yên", async () => {
  const { sut } = useCase([
    vessel("111111111", 1, 103, { speed: 12 }),
    vessel("222222222", 1.001, 103.001, { speed: 0 }),
    vessel("333333333", 1.002, 103.002, { speed: 0.2 }),
  ]);
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 2 });
  assert.equal(result.mode, MapQueryMode.CLUSTERS);
  if (result.mode !== MapQueryMode.CLUSTERS) return;
  assert.equal(result.clusters[0].count, 3);
  assert.equal(result.clusters[0].movingCount, 1);
});

// ---------------------------------------------------------------------------
//  §37 + §25 + §27 · Kinh tuyến ±180
// ---------------------------------------------------------------------------

test("§37 175E + 175W -> cụm đúng, KHÔNG trùng ở biên", async () => {
  const { sut, clusters } = useCase([
    vessel("111111111", 0, 175),
    vessel("222222222", 0, -175),
    vessel("333333333", 0, 0),
  ]);
  const result = await sut.execute({
    bbox: { minLat: -10, minLon: 170, maxLat: 10, maxLon: -170 },
    zoom: 2,
  });

  assert.equal(result.mode, MapQueryMode.CLUSTERS);
  if (result.mode !== MapQueryMode.CLUSTERS) return;

  assert.equal(clusters.queries[0].boxes.length, 2, "phải dùng lại phép tách của MAP-2");
  assert.equal(result.representedVessels, 2, "0°E nằm ngoài viewport");
  // Khoá lưới là toàn cục -> hai mảnh tự gộp, không có khoá trùng.
  assert.equal(new Set(result.clusters.map((c) => c.id)).size, result.clusters.length);
});

test("§26 hộp toàn cầu vẫn được cắt nhỏ trước khi xuống kho cụm", async () => {
  const { sut, clusters } = useCase([vessel("111111111", 0, 0)]);
  await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 1 });
  const boxes = clusters.queries[0].boxes;
  assert.ok(boxes.length > 1, "phải dùng lại phép cắt hộp rộng của MAP-2");
  for (const box of boxes) assert.ok(box.maxLon - box.minLon <= 90);
});

// ---------------------------------------------------------------------------
//  §39 · Zoom tăng -> lưới mịn hơn
// ---------------------------------------------------------------------------

test("§39 zoom cao hơn -> cụm tách nhỏ hơn", async () => {
  // Hai tàu cách nhau ~5°: chung ô ở lưới zoom 2 (ô rộng 90°), tách ô ở lưới
  // zoom 7 (ô rộng ~2,8°). Cố ý tránh (0,0) — điểm đó nằm đúng góc ô ở MỌI mức
  // zoom nên luôn tách, không kiểm được điều đang muốn kiểm.
  const { sut } = useCase([vessel("111111111", 10, 10), vessel("222222222", 15, 15)]);

  const coarse = await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 0 });
  const fine = await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 5 });

  assert.equal(coarse.mode, MapQueryMode.CLUSTERS);
  assert.equal(fine.mode, MapQueryMode.CLUSTERS);
  if (coarse.mode !== MapQueryMode.CLUSTERS || fine.mode !== MapQueryMode.CLUSTERS) return;

  assert.equal(coarse.clusters.length, 1, "lưới zoom 2: chung ô");
  assert.equal(fine.clusters.length, 2, "lưới zoom 7: tách ô");
  assert.equal(coarse.representedVessels, fine.representedVessels, "tổng tàu không đổi");
});

// ---------------------------------------------------------------------------
//  §20 + §21 + §40 · Trần cụm
// ---------------------------------------------------------------------------

test("§40 nhiều cụm hơn trần -> cắt và báo truncated", async () => {
  // 40 tàu rải rất xa nhau -> 40 ô khác nhau.
  const spread = Array.from({ length: 40 }, (_, index) =>
    vessel(String(200_000_000 + index), -60 + index * 3, -170 + index * 8)
  );
  const { sut } = useCase(spread);
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 2, limit: 10 });

  assert.equal(result.mode, MapQueryMode.CLUSTERS);
  if (result.mode !== MapQueryMode.CLUSTERS) return;
  assert.equal(result.clusters.length, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.limit, 10);
});

test("§20 trần cụm bị kẹp, limit rác về mặc định", async () => {
  const { sut } = useCase([vessel("111111111", 0, 0)]);
  const big = await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 2, limit: 999_999 });
  assert.equal(big.limit, MAP_CLUSTER_LIMITS.maxLimit);

  const junk = await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 2, limit: -1 });
  assert.equal(junk.limit, MAP_CLUSTER_LIMITS.defaultLimit);
});

// ---------------------------------------------------------------------------
//  §6 + §30 · Payload cụm
// ---------------------------------------------------------------------------

test("§6 cụm KHÔNG mang danh sách MMSI, chỉ 5 field", async () => {
  const { sut } = useCase([vessel("111111111", 1, 103), vessel("222222222", 1.001, 103.001)]);
  const result = await sut.execute({ bbox: WORLD_BOUNDING_BOX, zoom: 2 });
  assert.equal(result.mode, MapQueryMode.CLUSTERS);
  if (result.mode !== MapQueryMode.CLUSTERS) return;

  assert.deepEqual(Object.keys(result.clusters[0]).sort(), [
    "count",
    "id",
    "lat",
    "lon",
    "movingCount",
  ]);
  const serialized = JSON.stringify(result.clusters[0]);
  assert.equal(serialized.includes("111111111"), false, "không rò MMSI vào payload cụm");
});
