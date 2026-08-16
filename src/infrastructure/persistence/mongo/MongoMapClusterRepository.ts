// ============================================================================
//  INFRASTRUCTURE · MongoMapClusterRepository — gộp cụm bằng aggregation
// ----------------------------------------------------------------------------
//  CHỈ ĐỌC, chỉ chạm `canonical_current_vessels`.
//
//  ⛔ KHÔNG đọc `vessel_observations`: đếm observation là đếm số lần một con tàu
//     nói, không phải số con tàu. Canonical đã là một document mỗi tàu.
//
//  ⛔ KHÔNG tạo collection cụm dựng sẵn, không cache. Gộp động trước, đo, rồi
//     mới bàn tới vật chất hoá (MAP-4).
// ============================================================================

import {
  IMapClusterRepository,
  MapClusterQuery,
  MapClusterQueryResult,
  MapClusterRow,
} from "../../../application/contracts/repositories/IMapClusterRepository";
import { WEB_MERCATOR_MAX_LAT, gridSize } from "../../../application/services/map/MapGrid";
import { buildMapFilter } from "./MongoMapVesselRepository";
import { CurrentVesselModel } from "./currentVesselModel";

/** Trên ngưỡng này coi là đang chạy. Dưới là neo/buộc/trôi. */
const MOVING_SPEED_KNOTS = 0.5;

const LAT_PATH = "$position.position.lat";
const LON_PATH = "$position.position.lng";

/**
 * Vĩ độ đã kẹp về dải Web Mercator, TÍNH TRONG PIPELINE.
 *
 * ⚠️ Không kẹp thì `cos(±90°) = 0` -> `$divide` cho 0 -> Mongo ném lỗi và cả
 * truy vấn chết vì đúng một con tàu ở cực. Kẹp ở đây, không ở application, vì
 * phép toán chạy ở đây.
 */
const CLAMPED_LAT_RAD = {
  $degreesToRadians: {
    $min: [WEB_MERCATOR_MAX_LAT, { $max: [-WEB_MERCATOR_MAX_LAT, LAT_PATH] }],
  },
};

/**
 * Toạ độ -> ô lưới, bằng CHÍNH công thức Web Mercator của `MapGrid.toGridCell`:
 *
 *     x = floor( (lon + 180) / 360 * n )
 *     y = floor( (1 - ln(tan(φ) + sec(φ)) / π) / 2 * n )
 *
 * ⚠️ Hai bản (JS và pipeline) PHẢI cho cùng kết quả — có test đối chiếu trực
 * tiếp trên Mongo thật. Lệch nhau nghĩa là khoá cụm đổi giữa hai đường đọc và
 * FE thấy marker nhảy chỗ.
 */
function gridCellStages(gridZoom: number): Record<string, unknown> {
  const n = gridSize(gridZoom);
  const maxIndex = n - 1;

  const rawX = { $floor: { $multiply: [{ $divide: [{ $add: [LON_PATH, 180] }, 360] }, n] } };
  const rawY = {
    $floor: {
      $multiply: [
        {
          $divide: [
            {
              $subtract: [
                1,
                {
                  $divide: [
                    {
                      $ln: {
                        $add: [
                          { $tan: CLAMPED_LAT_RAD },
                          { $divide: [1, { $cos: CLAMPED_LAT_RAD }] },
                        ],
                      },
                    },
                    Math.PI,
                  ],
                },
              ],
            },
            2,
          ],
        },
        n,
      ],
    },
  };

  // Kẹp về [0, n-1]: `lon = 180` cho ra đúng `n`, tràn một ô ra ngoài bảng.
  return {
    _gx: { $min: [maxIndex, { $max: [0, rawX] }] },
    _gy: { $min: [maxIndex, { $max: [0, rawY] }] },
  };
}

/**
 * Pipeline gộp cụm.
 *
 * ⚠️ `$match` PHẢI là stage ĐẦU TIÊN, nếu không `$geoWithin` mất index và cả
 * collection bị quét. MAP-2 đã đo giá của việc đó.
 */
export function buildClusterPipeline(query: MapClusterQuery): Record<string, unknown>[] {
  return [
    {
      $match: buildMapFilter({
        boxes: query.boxes,
        candidateLimit: query.limit,
        // Lọc độ tươi NGAY trong `$match`: cụm chỉ trả về con số nên không còn
        // cơ hội loại tàu cũ (hoặc tàu có mốc ở tương lai) ở tầng trên.
        observedSince: query.observedSince,
        observedBefore: query.observedBefore,
      }),
    },
    // Chỉ giữ đúng ba field cần cho phép gộp — không kéo `identity`,
    // `particulars`, `voyage`, hay mảng `rejected` vào bộ nhớ aggregation.
    {
      $project: {
        _id: 0,
        [LAT_PATH.slice(1)]: 1,
        [LON_PATH.slice(1)]: 1,
        "position.position.speed": 1,
      },
    },
    { $addFields: gridCellStages(query.gridZoom) },
    {
      $group: {
        _id: { x: "$_gx", y: "$_gy" },
        count: { $sum: 1 },
        // Tâm THẬT của đám tàu, không phải tâm hình học của ô: cụm sẽ nằm đúng
        // trên luồng tàu thay vì lơ lửng giữa một ô phần lớn là biển trống.
        avgLat: { $avg: LAT_PATH },
        avgLon: { $avg: LON_PATH },
        movingCount: {
          $sum: {
            $cond: [{ $gt: ["$position.position.speed", MOVING_SPEED_KNOTS] }, 1, 0],
          },
        },
      },
    },
    // Sắp tất định trước khi cắt -> cùng dữ liệu cho cùng câu trả lời.
    { $sort: { "_id.x": 1, "_id.y": 1 } },
    { $limit: Math.max(1, Math.floor(query.limit)) + 1 },
  ];
}

interface ClusterAggregateRow {
  _id: { x: number; y: number };
  count: number;
  avgLat: number;
  avgLon: number;
  movingCount: number;
}

export class MongoMapClusterRepository implements IMapClusterRepository {
  async aggregateClusters(query: MapClusterQuery): Promise<MapClusterQueryResult> {
    const limit = Math.max(1, Math.floor(query.limit));

    const rows = await CurrentVesselModel.aggregate<ClusterAggregateRow>(
      buildClusterPipeline(query) as never[]
    ).exec();

    const reachedLimit = rows.length > limit;
    const page = reachedLimit ? rows.slice(0, limit) : rows;

    const mapped: MapClusterRow[] = page.map((row) => ({
      gridZoom: query.gridZoom,
      x: row._id.x,
      y: row._id.y,
      count: row.count,
      avgLat: row.avgLat,
      avgLon: row.avgLon,
      movingCount: row.movingCount,
    }));

    return { rows: Object.freeze(mapped), reachedLimit };
  }
}
