// ============================================================================
//  APPLICATION · PositionResolver — chọn vị trí canonical hiện tại. HÀM THUẦN.
// ----------------------------------------------------------------------------
//      VesselSourceObservation[]  ->  ResolvedPosition | null
//
//  Không mạng, không DB, không provider, không ghi gì. Cùng đầu vào -> cùng đầu
//  ra, kể cả khi đảo thứ tự mảng.
//
//  NGUYÊN KHỐI (atomic): observation THẮNG đi nguyên vẹn. TUYỆT ĐỐI không lấp
//  field thiếu từ observation thua — ghép `lat/lng` lúc 16:39 với `heading` lúc
//  02:00 tạo ra một con tàu CHƯA TỪNG Ở trạng thái đó (RESOLVER_POLICY.md §D.0).
//
//  Thứ tự quyết định (§D.1) — tuổi áp đảo mọi thứ khác vì chênh lệch đo được
//  giữa các nguồn là 14 GIỜ, còn chênh lệch độ chính xác chỉ ~150 m:
//      1. loại INVALID
//      2. bậc độ tươi theo `sourceReceivedAt`   (NO_SOURCE_TIME thấp nhất)
//      3. độ chính xác toạ độ                   (chỉ trong CÙNG bậc)
//      4. đầy đủ field chuyển động              (chỉ trong cùng bậc + độ chính xác)
//      5. defaultPriority                       (NƠI DUY NHẤT priority quyết định)
//      6. tên nguồn theo bảng chữ cái           (để tất định)
// ============================================================================

import { getSourceCapability } from "../acquisition/capabilities/capabilityQueries";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import {
  PositionObservation,
  VesselObservationType,
  VesselSourceObservation,
} from "../../../domain/entities/VesselObservation";
import { VesselSource } from "../../../domain/enums/VesselSource";
import {
  DEFAULT_POSITION_RESOLVER_POLICY,
  PositionFreshness,
  PositionResolverPolicy,
  classifyPositionFreshness,
  freshnessRank,
} from "./PositionResolverPolicy";
import { RejectedCandidate, RejectionReason, ResolutionReason } from "./ResolverTypes";

/**
 * Chuyển động đã phân xử RIÊNG, kèm xuất xứ của CHÍNH NÓ.
 *
 * Tồn tại vì một nguồn có thể phát ra nhiều BỀ MẶT cho cùng nhóm POSITION: ô
 * map của VesselFinder cho toạ độ chính xác nhưng không có chuyển động, trang
 * chi tiết thì ngược lại. Nhét cả hai vào một khối `position` sẽ tạo ra một ảnh
 * chụp CHƯA TỪNG TỒN TẠI (toạ độ lúc 13:00 ghép tốc độ lúc 12:57).
 *
 * Nên: hai khối, mỗi khối tự khai mốc thời gian và nguồn của mình. Người đọc
 * thấy rõ toạ độ và chuyển động đến từ hai quan sát khác nhau.
 *
 * ⚠️ `observedAt` ở đây LUÔN là mốc của quan sát sinh ra chuyển động. TUYỆT ĐỐI
 * không được làm mới bằng `fetchedAt` của một ô map đến sau.
 */
export interface ResolvedMotion {
  readonly speed?: number | null;
  readonly course?: number | null;
  readonly heading?: number | null;
  readonly navStatus?: VesselPositionReport["navStatus"];
  readonly source: VesselSource;
  readonly observationId?: string;
  /** Mốc NGUỒN khai cho chuyển động này. `null` = nguồn không cho biết. */
  readonly observedAt: Date | null;
  /** Lúc bot lấy được bản ghi chuyển động. */
  readonly fetchedAt: Date;
  /** Bậc độ tươi của CHÍNH chuyển động — STALE phải nhìn thấy được. */
  readonly freshness: PositionFreshness;
}

export interface ResolvedPosition {
  /** Payload NGUYÊN KHỐI từ đúng một observation. Không trộn field. */
  readonly position: VesselPositionReport;
  readonly source: VesselSource;
  /** Id bản ghi gốc trong `vessel_observations`. Chưa lưu -> undefined. */
  readonly observationId?: string;
  /** Mốc NGUỒN khai. `null` = nguồn không cho biết (bậc NO_SOURCE_TIME). */
  readonly observedAt: Date | null;
  /** Lúc bot lấy được. Luôn có. KHÔNG phải mốc của nguồn. */
  readonly fetchedAt: Date;
  readonly freshness: PositionFreshness;
  readonly reason: ResolutionReason;
  readonly rejected: readonly RejectedCandidate[];
  /**
   * Chuyển động, khi bản ghi toạ độ thắng cuộc KHÔNG mang nó nhưng một quan sát
   * khác còn dùng được thì có. `null` = không có chuyển động nào dùng được.
   */
  readonly motion: ResolvedMotion | null;
}

export interface PositionResolverDeps {
  policy?: PositionResolverPolicy;
  /** Tiêm được để test. Mặc định lấy từ capability matrix. */
  priorityOf?: (source: VesselSource) => number;
}

/** Field chuyển động dùng để đếm độ đầy đủ. lat/lng không tính — vị trí dùng được thì bắt buộc có. */
const MOTION_FIELDS = ["speed", "course", "heading", "navStatus"] as const;

interface Candidate {
  observation: PositionObservation;
  freshness: PositionFreshness;
  rank: number;
  precise: boolean;
  motion: number;
  priority: number;
}

function countMotionFields(position: VesselPositionReport): number {
  return MOTION_FIELDS.reduce((total, field) => (position[field] != null ? total + 1 : total), 0);
}

export class PositionResolver {
  private readonly policy: PositionResolverPolicy;
  private readonly priorityOf: (source: VesselSource) => number;

  constructor(deps: PositionResolverDeps = {}) {
    this.policy = deps.policy ?? DEFAULT_POSITION_RESOLVER_POLICY;
    this.priorityOf =
      deps.priorityOf ?? ((source) => getSourceCapability(source).defaultPriority);
  }

  /**
   * @param observations Ứng viên của MỘT tàu. Observation khác nhóm POSITION bị
   *        bỏ qua im lặng (chúng không phải ứng viên vị trí, không phải "bị loại").
   * @returns null khi không còn ứng viên nào dùng được. KHÔNG bao giờ bịa vị trí.
   */
  resolve(observations: readonly VesselSourceObservation[], now: Date): ResolvedPosition | null {
    const rejected: RejectedCandidate[] = [];
    const candidates: Candidate[] = [];

    for (const observation of observations) {
      // `type` là discriminant -> đây vừa là bộ lọc vừa là type guard, không ép kiểu bừa.
      if (observation.type !== VesselObservationType.POSITION) continue;

      if (observation.validation.status === ObservationValidationStatus.INVALID) {
        // Bản ghi hỏng KHÔNG được vào vòng trong, dù nó mới hơn tất cả.
        rejected.push(this.reject(observation, RejectionReason.INVALID_OBSERVATION));
        continue;
      }

      const freshness = classifyPositionFreshness(
        observation.sourceReceivedAt,
        now,
        this.policy
      );
      candidates.push({
        observation,
        freshness,
        rank: freshnessRank(freshness),
        precise: observation.data.latLngApproximate !== true,
        motion: countMotionFields(observation.data),
        priority: this.priorityOf(observation.source),
      });
    }

    if (candidates.length === 0) return null;

    const ranked = [...candidates].sort(PositionResolver.compare);
    // Nâng cấp độ chính xác CHỈ TRONG CÙNG MỘT NGUỒN — xem `preciseUpgrade`.
    const winner = this.preciseUpgrade(ranked[0], candidates, now);
    const losers = ranked.filter((candidate) => candidate !== winner);
    for (const loser of losers) {
      rejected.push(
        this.reject(loser.observation, PositionResolver.rejectionReason(winner, loser))
      );
    }

    return {
      position: winner.observation.data,
      source: winner.observation.source,
      observationId: winner.observation.id,
      // Không có mốc nguồn -> null. KHÔNG mượn fetchedAt.
      observedAt: winner.observation.sourceReceivedAt ?? null,
      fetchedAt: winner.observation.fetchedAt,
      freshness: winner.freshness,
      reason: PositionResolver.winnerReason(winner, losers),
      rejected: Object.freeze(rejected),
      motion: this.resolveMotion(winner, candidates),
    };
  }

  /**
   * Chuyển động dùng được TỐT NHẤT trong đám ứng viên.
   *
   * Bản thắng về toạ độ có thể là một ô map: chính xác nhưng không có chuyển
   * động. Trước đây điều đó khiến speed/course/navStatus biến mất khỏi canonical
   * mỗi khi chu kỳ quét map chạy sau lần tra chi tiết.
   *
   * Quy tắc:
   *   • bản thắng CÓ chuyển động  -> dùng luôn của nó (không trộn, không đi tìm)
   *   • bản thắng KHÔNG có        -> lấy ứng viên chuyển động tươi nhất còn hạn
   *   • quá hạn (EXPIRED)         -> KHÔNG mang sang, thà thiếu còn hơn bịa
   *
   * Ngưỡng lấy nguyên từ `PositionResolverPolicy` — không đẻ thêm ngưỡng mới.
   */
  private resolveMotion(
    winner: Candidate,
    candidates: readonly Candidate[]
  ): ResolvedMotion | null {
    const best = PositionResolver.hasMotion(winner.observation.data)
      ? winner
      : [...candidates]
          .filter((candidate) => PositionResolver.hasMotion(candidate.observation.data))
          // Tươi nhất trước; cùng bậc thì mốc nguồn mới hơn thắng.
          .sort(PositionResolver.compare)[0];

    if (best === undefined) return null;

    // Chuyển động quá hạn KHÔNG được mang sang. `NO_SOURCE_TIME` vẫn giữ: nó
    // trung thực nói "không biết tuổi", khác hẳn "biết là đã quá cũ".
    if (best.freshness === PositionFreshness.EXPIRED) return null;

    const data = best.observation.data;
    return {
      speed: data.speed ?? null,
      course: data.course ?? null,
      heading: data.heading ?? null,
      navStatus: data.navStatus ?? null,
      source: best.observation.source,
      observationId: best.observation.id,
      // Mốc của CHÍNH quan sát chuyển động. Ô map đến sau không làm mới nó.
      observedAt: best.observation.sourceReceivedAt ?? null,
      fetchedAt: best.observation.fetchedAt,
      freshness: best.freshness,
    };
  }

  /** Có ÍT NHẤT một field chuyển động dùng được. `0` là giá trị, không phải thiếu. */
  private static hasMotion(position: VesselPositionReport): boolean {
    return MOTION_FIELDS.some((field) => position[field] != null);
  }

  /**
   * Nâng cấp toạ độ TRONG CÙNG MỘT NGUỒN.
   *
   * Một nguồn có thể phát nhiều BỀ MẶT: ô map của VesselFinder cho toạ độ chính
   * xác nhưng không khai mốc nguồn, trang chi tiết thì có mốc nhưng toạ độ đã
   * làm tròn về số nguyên (sai ~111 km). Theo `compare`, trang chi tiết luôn
   * thắng (có mốc nguồn = bậc cao hơn), nên canonical giữ toạ độ thô dù ta vừa
   * quét được toạ độ chính xác của đúng con tàu đó, từ đúng nguồn đó.
   *
   * Chỉ đổi khi CẢ BA điều kiện đúng:
   *   1. cùng `source`   — chính sách liên-nguồn (§D.1: độ tươi thắng độ chính
   *                        xác) KHÔNG bị đụng tới; đây là phạm vi §10 của phase.
   *   2. bản thay thế có toạ độ chính xác còn bản thắng thì không
   *   3. bản thay thế còn LIÊN QUAN (`fetchedAt` trong `recentMaxAgeMs`) — ô map
   *      cũ 3 ngày không được thắng chỉ vì nó chính xác
   *
   * Làm ở đây, SAU khi đã xếp hạng, chứ không nhét vào comparator: một luật so
   * sánh chỉ áp dụng cho vài cặp sẽ phá tính bắc cầu và `sort` mất định nghĩa.
   *
   * ⚠️ Vẫn trung thực: khối `position` khai đúng `observedAt`/`freshness` CỦA
   * BẢN ĐƯỢC CHỌN. Chọn ô map nghĩa là canonical nói "chính xác, không rõ tuổi"
   * — không phải "vừa mới".
   */
  private preciseUpgrade(
    winner: Candidate,
    candidates: readonly Candidate[],
    now: Date
  ): Candidate {
    if (winner.precise) return winner;
    const upgrade = candidates
      .filter(
        (candidate) =>
          candidate.observation.source === winner.observation.source &&
          candidate.precise &&
          now.getTime() - candidate.observation.fetchedAt.getTime() <= this.policy.recentMaxAgeMs
      )
      .sort(PositionResolver.compare)[0];
    return upgrade ?? winner;
  }

  /** Nhỏ hơn = tốt hơn. Tất định: kết thúc bằng tên nguồn nên không phụ thuộc thứ tự đầu vào. */
  private static compare(a: Candidate, b: Candidate): number {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.precise !== b.precise) return a.precise ? -1 : 1;
    const sourceTimeOrder = PositionResolver.compareSourceTimes(a.observation, b.observation);
    if (sourceTimeOrder !== 0) return sourceTimeOrder;
    if (a.motion !== b.motion) return b.motion - a.motion;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.observation.source.localeCompare(b.observation.source);
  }

  /** More recent source timestamp wins within the same freshness and precision tier. */
  private static compareSourceTimes(a: PositionObservation, b: PositionObservation): number {
    const aTime = a.sourceReceivedAt?.getTime();
    const bTime = b.sourceReceivedAt?.getTime();
    if (aTime === undefined || bTime === undefined || aTime === bTime) return 0;
    return bTime - aTime;
  }

  /** Tiêu chí ĐẦU TIÊN phân định được winner với kẻ thua ngay sau nó. */
  private static winnerReason(winner: Candidate, losers: readonly Candidate[]): ResolutionReason {
    const runnerUp = losers[0];
    if (runnerUp === undefined) return ResolutionReason.ONLY_AVAILABLE_VALUE;
    if (winner.rank !== runnerUp.rank) return ResolutionReason.FRESHER_SOURCE_TIMESTAMP;
    if (winner.precise !== runnerUp.precise) return ResolutionReason.HIGHER_PRECISION;
    if (PositionResolver.compareSourceTimes(winner.observation, runnerUp.observation) !== 0) {
      return ResolutionReason.FRESHER_SOURCE_TIMESTAMP;
    }
    if (winner.motion !== runnerUp.motion) return ResolutionReason.MORE_COMPLETE;
    return ResolutionReason.TIE_BREAK_PRIORITY;
  }

  /** Tiêu chí đầu tiên khiến kẻ thua này thua winner. */
  private static rejectionReason(winner: Candidate, loser: Candidate): RejectionReason {
    if (winner.rank !== loser.rank) {
      return loser.freshness === PositionFreshness.NO_SOURCE_TIME
        ? RejectionReason.NO_SOURCE_TIMESTAMP
        : RejectionReason.STALER_TIMESTAMP;
    }
    if (winner.precise !== loser.precise) return RejectionReason.LOWER_PRECISION;
    if (PositionResolver.compareSourceTimes(winner.observation, loser.observation) !== 0) {
      return RejectionReason.STALER_TIMESTAMP;
    }
    if (winner.motion !== loser.motion) return RejectionReason.LESS_COMPLETE;
    return RejectionReason.TIE_BREAK_PRIORITY;
  }

  private reject(
    observation: VesselSourceObservation,
    reason: RejectionReason
  ): RejectedCandidate {
    return { source: observation.source, observationId: observation.id, reason };
  }
}
