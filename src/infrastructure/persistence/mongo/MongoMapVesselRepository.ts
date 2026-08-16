// ============================================================================
//  INFRASTRUCTURE · MongoMapVesselRepository — truy vấn viewport bằng 2dsphere
// ----------------------------------------------------------------------------
//  Chỉ ĐỌC. Không ghi gì, không upsert, không đụng `vessel_observations`.
//
//  Trách nhiệm: hộp bao -> Polygon GeoJSON -> `$geoWithin` -> canonical.
//  Luật "tàu này có vẽ được không" KHÔNG nằm ở đây (xem `MapVesselReadiness`).
// ============================================================================

import {
  IMapVesselRepository,
  MapVesselQuery,
  MapVesselQueryResult,
} from "../../../application/contracts/repositories/IMapVesselRepository";
import { BoundingBox } from "../../../application/contracts/geo/Geo";
import { ResolvedCurrentVessel } from "../../../application/services/resolution/ResolvedCurrentVessel";
import { CurrentVesselModel } from "./currentVesselModel";

/**
 * ⚠️ CHỈ nạp thứ map thật sự vẽ.
 *
 * Canonical đầy đủ mang theo `particulars`, `voyage`, và — nặng nhất — mảng
 * `rejected` của TỪNG field (danh sách nguồn thua kèm lý do). Với mười nghìn
 * tàu một viewport, nạp chúng là kéo hàng chục MB từ Mongo về rồi vứt đi.
 *
 * `position` phải lấy NGUYÊN KHỐI: nó là payload của đúng một observation, tách
 * lẻ ra là phá bất biến của resolver.
 */
const MAP_PROJECTION = Object.freeze({
  mmsi: 1,
  imo: 1,
  "identity.name": 1,
  "identity.vesselTypeCode": 1,
  "identity.imo": 1,
  position: 1,
  resolvedAt: 1,
});

interface MapDoc {
  mmsi?: string | null;
  imo?: string | null;
  identity?: unknown;
  position?: unknown;
  resolvedAt: Date;
}

/**
 * Hộp bao -> vòng Polygon GeoJSON, đóng kín (điểm đầu = điểm cuối).
 *
 * ⚠️ Thứ tự đỉnh là **[kinh độ, vĩ độ]**, và ngược chiều kim đồng hồ. Mongo
 * hiểu vòng ngoài theo quy tắc bàn tay phải; đảo chiều sẽ cho ra phần BÙ của
 * hộp — tức là gần như cả địa cầu — mà không lỗi nào được ném ra.
 */
export function boxToPolygon(box: BoundingBox): {
  type: "Polygon";
  coordinates: number[][][];
} {
  return {
    type: "Polygon",
    coordinates: [
      [
        [box.minLon, box.minLat],
        [box.maxLon, box.minLat],
        [box.maxLon, box.maxLat],
        [box.minLon, box.maxLat],
        [box.minLon, box.minLat],
      ],
    ],
  };
}

/**
 * Điều kiện lọc gửi xuống Mongo.
 *
 * ⛔ TUYỆT ĐỐI không dùng `$geoWithin: { $box: ... }`. MAP-1 đã đo: `$box` là
 *    toán tử legacy chỉ index `2d` phục vụ được, nên với `location_2dsphere`
 *    nó rơi thẳng vào COLLSCAN — quét 2.000/2.000 document để trả 97 kết quả,
 *    và KHÔNG có lỗi nào báo. Chỉ `$geometry` mới dùng được 2dsphere.
 */
export function buildMapFilter(query: MapVesselQuery): Record<string, unknown> {
  const geo = query.boxes.map((box) => ({
    location: { $geoWithin: { $geometry: boxToPolygon(box) } },
  }));

  const filter: Record<string, unknown> = geo.length === 1 ? { ...geo[0] } : { $or: geo };

  if (query.observedSince !== undefined) {
    // Lọc SƠ BỘ để giảm ứng viên. Quyết định cuối vẫn là của application —
    // ở đây không có khái niệm "đủ tươi", chỉ có "cũ hơn mốc này thì khỏi đọc".
    filter["position.observedAt"] = { $gte: query.observedSince };
  }
  return filter;
}

export class MongoMapVesselRepository implements IMapVesselRepository {
  async findInBoxes(query: MapVesselQuery): Promise<MapVesselQueryResult> {
    const limit = Math.max(1, Math.floor(query.candidateLimit));

    // Đọc DƯ ĐÚNG MỘT bản ghi để biết "còn nữa không" — rẻ hơn `countDocuments`
    // trên viewport hàng trăm nghìn document tới vài bậc độ lớn.
    const docs = await CurrentVesselModel.find(buildMapFilter(query))
      .select(MAP_PROJECTION)
      .limit(limit + 1)
      .lean<MapDoc[]>()
      .exec();

    const reachedCandidateLimit = docs.length > limit;
    const page = reachedCandidateLimit ? docs.slice(0, limit) : docs;

    // Viewport cắt đường đổi ngày -> hai hộp -> `$or`. Mongo đã trả mỗi document
    // ĐÚNG MỘT LẦN cho `$or`, nên ở đây không khử trùng thêm. Bảo đảm "không có
    // tàu trùng trong kết quả" là của use case — chỗ hợp đồng được phát biểu —
    // để luật đó không nằm ở hai nơi rồi lệch nhau.
    return {
      candidates: Object.freeze(page.map(MongoMapVesselRepository.toEntity)),
      reachedCandidateLimit,
    };
  }

  /**
   * Nhóm không được chiếu về sẽ là `null` — đúng nghĩa "map không hỏi tới",
   * KHÔNG phải "tàu không có". Người đọc canonical đầy đủ phải dùng
   * `ICurrentVesselRepository`.
   */
  private static toEntity(doc: MapDoc): ResolvedCurrentVessel {
    return {
      vesselKey: { mmsi: doc.mmsi ?? undefined, imo: doc.imo ?? undefined },
      identity: doc.identity ?? null,
      position: doc.position ?? null,
      particulars: null,
      voyage: null,
      resolvedAt: doc.resolvedAt,
    } as ResolvedCurrentVessel;
  }
}
