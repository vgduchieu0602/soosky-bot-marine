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

    const [winner, ...losers] = [...candidates].sort(PositionResolver.compare);
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
    };
  }

  /** Nhỏ hơn = tốt hơn. Tất định: kết thúc bằng tên nguồn nên không phụ thuộc thứ tự đầu vào. */
  private static compare(a: Candidate, b: Candidate): number {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.precise !== b.precise) return a.precise ? -1 : 1;
    if (a.motion !== b.motion) return b.motion - a.motion;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.observation.source.localeCompare(b.observation.source);
  }

  /** Tiêu chí ĐẦU TIÊN phân định được winner với kẻ thua ngay sau nó. */
  private static winnerReason(winner: Candidate, losers: readonly Candidate[]): ResolutionReason {
    const runnerUp = losers[0];
    if (runnerUp === undefined) return ResolutionReason.ONLY_AVAILABLE_VALUE;
    if (winner.rank !== runnerUp.rank) return ResolutionReason.FRESHER_SOURCE_TIMESTAMP;
    if (winner.precise !== runnerUp.precise) return ResolutionReason.HIGHER_PRECISION;
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
