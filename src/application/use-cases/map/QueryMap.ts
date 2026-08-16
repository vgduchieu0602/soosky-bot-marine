// ============================================================================
//  APPLICATION · USE CASE: QueryMap — chọn chế độ theo zoom rồi trả lời
// ----------------------------------------------------------------------------
//      { bbox, zoom, limit? }
//            ↓  planMapQuery(zoom)
//      ┌── VESSELS  -> GetMapVessels        (đường của MAP-2, KHÔNG viết lại)
//      └── CLUSTERS -> IMapClusterRepository (gộp theo ô lưới)
//
//  Vì sao phải có chế độ cụm: ở zoom thấp, MAP-2 trả về `limit` tàu đầu tiên
//  theo MMSI rồi bật `truncated`. Danh sách đó ĐÚNG nhưng THIÊN LỆCH — nó luôn
//  là những MMSI nhỏ nhất, nên map toàn cầu hiện ra một mảng tàu dồn về vài
//  quốc gia có tiền tố MMSI thấp, còn phần còn lại của địa cầu trống trơn.
//  Cụm trả lời đúng câu hỏi thật: "chỗ nào đông".
// ============================================================================

import { BoundingBox } from "../../contracts/geo/Geo";
import { IMapClusterRepository } from "../../contracts/repositories/IMapClusterRepository";
import { resolveViewport } from "../../services/map/MapBoundingBox";
import { gridCellId } from "../../services/map/MapGrid";
import {
  DEFAULT_MAP_QUERY_STRATEGY,
  MapQueryMode,
  MapQueryStrategyPolicy,
  planMapQuery,
} from "../../services/map/MapQueryStrategy";
import {
  DEFAULT_MAP_READINESS_POLICY,
  MapReadinessPolicy,
} from "../../services/map/MapVesselReadiness";
import { MapVesselItem } from "../../services/map/MapVesselProjector";
import { GetMapVessels, InvalidViewportError } from "./GetMapVessels";

/** Trần riêng cho cụm — nhỏ hơn trần tàu vì một cụm đại diện cho nhiều tàu. */
export const MAP_CLUSTER_LIMITS = Object.freeze({
  defaultLimit: 500,
  maxLimit: 2_000,
});

export interface MapClusterItem {
  /** `${gridZoom}:${x}:${y}` — TẤT ĐỊNH, ổn định giữa các lần tải. */
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  readonly count: number;
  /** Số tàu đang chạy trong cụm. Đứng yên = `count - movingCount`. */
  readonly movingCount: number;
}

export interface QueryMapInput {
  readonly bbox: BoundingBox;
  readonly zoom: number;
  readonly limit?: number;
}

export type QueryMapResult =
  | {
      readonly mode: typeof MapQueryMode.VESSELS;
      readonly items: readonly MapVesselItem[];
      readonly truncated: boolean;
      readonly limit: number;
    }
  | {
      readonly mode: typeof MapQueryMode.CLUSTERS;
      readonly clusters: readonly MapClusterItem[];
      readonly truncated: boolean;
      readonly limit: number;
      readonly gridZoom: number;
      /** Tổng số tàu mà các cụm TRẢ VỀ đại diện. Không phải tổng toàn viewport. */
      readonly representedVessels: number;
    };

export interface QueryMapDeps {
  vessels: GetMapVessels;
  clusters: IMapClusterRepository;
  now?: () => Date;
  strategy?: MapQueryStrategyPolicy;
  readiness?: MapReadinessPolicy;
}

export class QueryMap {
  private readonly vessels: GetMapVessels;
  private readonly clusters: IMapClusterRepository;
  private readonly now: () => Date;
  private readonly strategy: MapQueryStrategyPolicy;
  private readonly readiness: MapReadinessPolicy;

  constructor(deps: QueryMapDeps) {
    this.vessels = deps.vessels;
    this.clusters = deps.clusters;
    this.now = deps.now ?? (() => new Date());
    this.strategy = deps.strategy ?? DEFAULT_MAP_QUERY_STRATEGY;
    this.readiness = deps.readiness ?? DEFAULT_MAP_READINESS_POLICY;
  }

  /**
   * @throws InvalidZoomError khi zoom ngoài [0, 22].
   * @throws InvalidViewportError khi bbox sai.
   */
  async execute(input: QueryMapInput): Promise<QueryMapResult> {
    const plan = planMapQuery(input.zoom, this.strategy);

    if (plan.mode === MapQueryMode.VESSELS) {
      // Đường của MAP-2 nguyên vẹn: trần, lọc độ tươi, khử trùng, sắp xếp đều
      // đã đúng ở đó. Viết lại ở đây là tạo bản thứ hai của cùng một luật.
      const result = await this.vessels.execute({ bbox: input.bbox, limit: input.limit });
      return {
        mode: MapQueryMode.VESSELS,
        items: result.items,
        truncated: result.truncated,
        limit: result.limit,
      };
    }

    // Dùng lại NGUYÊN bộ kiểm tra của MAP-2: kiểm hộp, tách qua kinh tuyến
    // ±180, và cắt nhỏ hộp rộng hơn nửa cầu. Cụm không được có bản riêng.
    const viewport = resolveViewport(input.bbox);
    if (!viewport.ok) throw new InvalidViewportError(viewport.reason);

    const limit = QueryMap.clampClusterLimit(input.limit);
    const now = this.now();

    const { rows, reachedLimit } = await this.clusters.aggregateClusters({
      boxes: viewport.boxes,
      gridZoom: plan.gridZoom,
      // Cụm chỉ trả về CON SỐ, nên bộ lọc độ tươi phải nằm trong truy vấn.
      // Ngưỡng lấy từ chính chính sách readiness -> không có số thứ hai.
      observedSince: new Date(now.getTime() - this.readiness.maxPositionAgeMs),
      limit,
    });

    const clusters = rows.map((row) => ({
      // Khoá toàn cục theo lưới -> hai mảnh viewport tự gộp về một cụm, không
      // cần bước merge nào và không thể trùng ở đường biên.
      id: gridCellId({ gridZoom: row.gridZoom, x: row.x, y: row.y }),
      lat: row.avgLat,
      lon: row.avgLon,
      count: row.count,
      movingCount: row.movingCount,
    }));

    return {
      mode: MapQueryMode.CLUSTERS,
      clusters: Object.freeze(clusters),
      truncated: reachedLimit,
      limit,
      gridZoom: plan.gridZoom,
      representedVessels: clusters.reduce((total, cluster) => total + cluster.count, 0),
    };
  }

  private static clampClusterLimit(requested: number | undefined): number {
    if (requested === undefined) return MAP_CLUSTER_LIMITS.defaultLimit;
    if (!Number.isFinite(requested) || requested < 1) return MAP_CLUSTER_LIMITS.defaultLimit;
    return Math.min(Math.floor(requested), MAP_CLUSTER_LIMITS.maxLimit);
  }
}
