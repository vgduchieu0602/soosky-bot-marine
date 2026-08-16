// ============================================================================
//  APPLICATION · USE CASE: GetMapVessels — "viewport này có tàu nào vẽ được?"
// ----------------------------------------------------------------------------
//      bbox
//        -> resolveViewport()          (kiểm tra + tách đường đổi ngày)
//        -> IMapVesselRepository       (lọc KHÔNG GIAN, có trần ứng viên)
//        -> evaluateMapReadiness()     (lọc ĐỘ TƯƠI, tính lại tại thời điểm hỏi)
//        -> MapVesselItem[]            (payload mỏng, có trần)
//
//  ⛔ Không HTTP, không Mongo, không clustering. Kết quả LUÔN có trần và luôn
//     nói thật khi bị cắt bớt.
// ============================================================================

import {
  IMapVesselRepository,
} from "../../contracts/repositories/IMapVesselRepository";
import { BoundingBox } from "../../contracts/geo/Geo";
import {
  MapBoundingBoxError,
  resolveViewport,
} from "../../services/map/MapBoundingBox";
import {
  DEFAULT_MAP_READINESS_POLICY,
  MapReadinessPolicy,
} from "../../services/map/MapVesselReadiness";
import { MapVesselItem, projectMapVessels } from "../../services/map/MapVesselProjector";

/**
 * ⚠️ MỌI con số ở đây là TRẦN, không phải gợi ý.
 *
 * Một viewport toàn cầu ở mức zoom nhỏ nhất có thể trúng hàng trăm nghìn tàu.
 * Trả hết là giết cả Mongo, cả mạng, lẫn RAM của điện thoại. MAP-2 chưa có
 * clustering nên câu trả lời trung thực là "đây là một phần, và tôi nói cho bạn
 * biết là nó bị cắt".
 */
export const MAP_QUERY_LIMITS = Object.freeze({
  /** Người gọi không nói gì thì lấy ngần này. */
  defaultLimit: 1_000,
  /** Xin nhiều hơn cũng chỉ được ngần này. */
  maxLimit: 5_000,
  /**
   * Đọc dư bao nhiêu lần so với `limit`.
   *
   * Cần dư vì bộ lọc độ tươi chạy SAU truy vấn không gian: đọc đúng 1.000 rồi
   * loại 300 tàu cũ thì người dùng chỉ nhận 700, dù trong viewport còn thừa tàu
   * tươi chưa được đọc tới.
   */
  overfetchMultiplier: 2,
  /** Trần TUYỆT ĐỐI cho số ứng viên đọc từ kho, kể cả sau khi nhân hệ số. */
  maxCandidates: 20_000,
});

export interface GetMapVesselsInput {
  readonly bbox: BoundingBox;
  /** Không truyền -> `MAP_QUERY_LIMITS.defaultLimit`. Vượt trần -> bị kẹp. */
  readonly limit?: number;
}

export interface GetMapVesselsResult {
  readonly items: readonly MapVesselItem[];
  /**
   * `true` = viewport CÒN tàu vẽ được mà kết quả này không mang theo.
   *
   * Người gọi TUYỆT ĐỐI không được coi danh sách là đầy đủ khi cờ này bật —
   * đó là lúc phải thu nhỏ viewport (và, từ MAP-3, dùng clustering).
   */
  readonly truncated: boolean;
  /** Trần đã áp dụng sau khi kẹp. */
  readonly limit: number;
  /** Số ứng viên kho trả về, TRƯỚC bộ lọc độ tươi. Dùng để chỉnh trần. */
  readonly candidatesScanned: number;
  readonly crossesAntiMeridian: boolean;
}

export class InvalidViewportError extends Error {
  constructor(readonly reason: MapBoundingBoxError) {
    super(`Viewport không hợp lệ: ${reason}`);
    this.name = "InvalidViewportError";
  }
}

export interface GetMapVesselsDeps {
  repository: IMapVesselRepository;
  now?: () => Date;
  policy?: MapReadinessPolicy;
}

export class GetMapVessels {
  private readonly repository: IMapVesselRepository;
  private readonly now: () => Date;
  private readonly policy: MapReadinessPolicy;

  constructor(deps: GetMapVesselsDeps) {
    this.repository = deps.repository;
    // Đồng hồ tiêm được: `now` KHÔNG bao giờ đến từ tham số của người gọi ngoài,
    // nếu không một client lệch giờ sẽ tự quyết định tàu nào là "tươi".
    this.now = deps.now ?? (() => new Date());
    this.policy = deps.policy ?? DEFAULT_MAP_READINESS_POLICY;
  }

  /** @throws InvalidViewportError khi bbox sai — KHÔNG tự sửa hộ. */
  async execute(input: GetMapVesselsInput): Promise<GetMapVesselsResult> {
    const viewport = resolveViewport(input.bbox);
    if (!viewport.ok) throw new InvalidViewportError(viewport.reason);

    const limit = GetMapVessels.clampLimit(input.limit);
    const candidateLimit = Math.min(
      limit * MAP_QUERY_LIMITS.overfetchMultiplier,
      MAP_QUERY_LIMITS.maxCandidates
    );
    const now = this.now();

    const { candidates, reachedCandidateLimit } = await this.repository.findInBoxes({
      boxes: viewport.boxes,
      candidateLimit,
      // Lọc sơ bộ để kho khỏi trả về tàu chắc chắn sẽ bị loại. Kết quả CUỐI
      // vẫn do `evaluateMapReadiness` quyết — không sao chép luật xuống kho.
      observedSince: new Date(now.getTime() - this.policy.maxPositionAgeMs),
    });

    const projected = projectMapVessels(candidates, now, this.policy);

    // Một MMSI chỉ được xuất hiện MỘT lần. Viewport cắt đường đổi ngày được hỏi
    // bằng hai hộp, và một tàu nằm sát kinh tuyến ±180 có thể trúng cả hai.
    // Khử trùng Ở ĐÂY chứ không ở kho: đây là chỗ hợp đồng được phát biểu, và
    // để luật này nằm ở hai tầng là mời hai tầng lệch nhau.
    const unique = new Map<string, MapVesselItem>();
    for (const item of projected) {
      if (!unique.has(item.mmsi)) unique.set(item.mmsi, item);
    }

    // Sắp theo MMSI rồi mới cắt -> cùng dữ liệu, cùng viewport thì cùng kết quả.
    // `$geoWithin` không hứa thứ tự nào cả, mà test lẫn cache phía client đều
    // cần một câu trả lời tất định.
    const ordered = [...unique.values()].sort((a, b) => a.mmsi.localeCompare(b.mmsi));

    return {
      items: Object.freeze(ordered.slice(0, limit)),
      // Hai đường dẫn tới "bị cắt", cả hai đều phải nói thật:
      //   1. lọc xong vẫn nhiều hơn trần;
      //   2. kho chạm trần ứng viên -> ngoài kia còn tàu CHƯA ĐỌC TỚI, và ta
      //      không biết chúng có tươi hay không. Nói "đầy đủ" là nói dối.
      truncated: ordered.length > limit || reachedCandidateLimit,
      limit,
      candidatesScanned: candidates.length,
      crossesAntiMeridian: viewport.crossesAntiMeridian,
    };
  }

  private static clampLimit(requested: number | undefined): number {
    if (requested === undefined) return MAP_QUERY_LIMITS.defaultLimit;
    if (!Number.isFinite(requested) || requested < 1) return MAP_QUERY_LIMITS.defaultLimit;
    return Math.min(Math.floor(requested), MAP_QUERY_LIMITS.maxLimit);
  }
}
