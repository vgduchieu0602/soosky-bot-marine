// ============================================================================
//  APPLICATION · Canonical -> read model chi tiết. HÀM THUẦN.
// ----------------------------------------------------------------------------
//  Trả lời đúng một câu: "hiện tại Bot biết gì về con tàu này?"
//
//  ⛔ KHÔNG phải `VesselExtended`. Kiểu đó là DTO tương thích của
//     Soosky-marine-api (mọi field `required`, thiếu thì `"N/A"`/`0`). Read
//     model này giữ độc lập: thiếu là `null`, và nói rõ nhóm nào đang thiếu.
//
//  ⛔ KHÔNG rò nội bộ resolver: `rejected`, `observationId`, `reason`,
//     `contentHash` đều là dữ liệu chẩn đoán. Muốn soi thì làm CLI riêng.
// ============================================================================

import { ResolvedField } from "../resolution/ResolverTypes";
import { ResolvedCurrentVessel } from "../resolution/ResolvedCurrentVessel";
import {
  DEFAULT_MAP_READINESS_POLICY,
  MapReadinessPolicy,
} from "../map/MapVesselReadiness";
import { isValidCoordinates } from "../../../domain/validators/geo";

/**
 * Trạng thái của MỘT nhóm dữ liệu.
 *
 * Ba mức, cố ý không hơn. Không thang điểm 20 bậc, không "chất lượng nguồn" —
 * việc chọn nguồn nào thắng đã xong ở resolver, ở đây chỉ nhìn kết quả.
 */
export const DetailGroupStatus = {
  /** Có dữ liệu dùng được. */
  AVAILABLE: "AVAILABLE",
  /** Chưa nguồn nào cấp nhóm này. */
  MISSING: "MISSING",
  /** Có dữ liệu nhưng đã quá cũ so với ngưỡng của nhóm. */
  STALE: "STALE",
} as const;

export type DetailGroupStatus = (typeof DetailGroupStatus)[keyof typeof DetailGroupStatus];

export const DetailGroup = {
  IDENTITY: "IDENTITY",
  POSITION: "POSITION",
  PARTICULARS: "PARTICULARS",
  VOYAGE: "VOYAGE",
} as const;

export type DetailGroup = (typeof DetailGroup)[keyof typeof DetailGroup];

/** Giá trị kèm xuất xứ NHẸ — đủ để biết ai nói, không kèm ai thua. */
export interface DetailValue<T> {
  readonly value: T;
  readonly source: string;
  /** Mốc NGUỒN khai. Nhóm tĩnh thường không có -> null. */
  readonly observedAt: Date | null;
  /** Lúc bot lấy được. Luôn có. */
  readonly fetchedAt: Date;
}

export interface DetailIdentity {
  readonly name: DetailValue<string> | null;
  readonly callsign: DetailValue<string> | null;
  readonly vesselType: DetailValue<string> | null;
  readonly vesselTypeCode: DetailValue<number> | null;
  readonly flagCode: DetailValue<string> | null;
  readonly flagName: DetailValue<string> | null;
}

export interface DetailPosition {
  readonly lat: number;
  /** ⚠️ Canonical dùng `lng`; read model dùng `lon` như payload map. */
  readonly lon: number;
  readonly speed: number | null;
  readonly course: number | null;
  readonly heading: number | null;
  readonly navStatusCode: number | null;
  readonly navStatusText: string | null;
  /** Mốc NGUỒN khai. `null` = nguồn không cho biết. KHÔNG bao giờ là `fetchedAt`. */
  readonly observedAt: Date | null;
  /** Tuổi tại thời điểm chiếu. `null` khi không có `observedAt`. */
  readonly ageMs: number | null;
  readonly source: string;
  /**
   * Độ tươi TÍNH LẠI tại thời điểm hỏi.
   *
   * ⚠️ KHÔNG phải bậc `freshness` lưu trong canonical — bậc đó đóng băng từ lần
   * resolve cuối và sẽ mãi nói `LIVE` cho một con tàu đã ngừng phát tín hiệu.
   */
  readonly status: DetailGroupStatus;
}

export interface DetailParticulars {
  readonly length: DetailValue<number> | null;
  readonly beam: DetailValue<number> | null;
  readonly draught: DetailValue<number> | null;
  readonly grossTonnage: DetailValue<number> | null;
  readonly deadweight: DetailValue<number> | null;
  readonly builtYear: DetailValue<number> | null;
}

export interface DetailVoyage {
  readonly destination: DetailValue<string> | null;
  readonly eta: DetailValue<Date> | null;
  readonly currentPort: DetailValue<string> | null;
  readonly nextPort: DetailValue<string> | null;
  readonly lastPort: DetailValue<string> | null;
  readonly lastPortDepartureAt: DetailValue<Date> | null;
}

export interface DetailGroupState {
  readonly status: DetailGroupStatus;
  /** Lần cuối nhóm này được cập nhật (max `fetchedAt` của các field). */
  readonly updatedAt: Date | null;
  readonly ageMs: number | null;
}

export interface CanonicalVesselDetail {
  readonly identifiers: { readonly mmsi: string | null; readonly imo: string | null };
  readonly identity: DetailIdentity;
  /** `null` = chưa nhóm POSITION nào được phân xử, hoặc toạ độ không dùng được. */
  readonly position: DetailPosition | null;
  readonly particulars: DetailParticulars;
  readonly voyage: DetailVoyage;
  /**
   * Trạng thái TỪNG nhóm.
   *
   * ⚠️ Không có "một độ tươi cho cả con tàu": vị trí có thể 2 phút tuổi trong
   * khi `builtYear` 30 ngày và cả hai đều hoàn toàn bình thường. Gộp thành một
   * con số là vứt đi chính thông tin cần dùng.
   */
  readonly groups: Readonly<Record<DetailGroup, DetailGroupState>>;
  /** Nhóm chưa có dữ liệu. */
  readonly missingGroups: readonly DetailGroup[];
  /** Nhóm có dữ liệu nhưng đã quá hạn. */
  readonly staleGroups: readonly DetailGroup[];
  /**
   * Gợi ý cho DETAIL-2. Ở phase này CHỈ LÀ CỜ — không có gì được kích hoạt.
   */
  readonly needsRefresh: boolean;
  readonly refreshGroups: readonly DetailGroup[];
  /** Lúc canonical được phân xử lần cuối (persistence metadata). */
  readonly resolvedAt: Date;
}

// ---------------------------------------------------------------------------
//  Chính sách tuổi theo NHÓM
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface VesselDetailPolicy {
  /** Dùng lại nguyên `MapReadinessPolicy` cho nhóm POSITION — không số thứ hai. */
  readonly position: MapReadinessPolicy;
  /**
   * Ngưỡng "quá cũ" cho ba nhóm tĩnh, tính theo `fetchedAt`.
   *
   * Ba con số khác nhau vì ba nhóm đổi ở ba nhịp khác nhau: chuyến đi đổi theo
   * cảng, tên tàu gần như không đổi, kích thước thì không bao giờ. Áp một
   * ngưỡng chung là hoặc bắt crawl lại tên tàu mỗi tuần, hoặc để `destination`
   * cũ ba tháng.
   */
  readonly identityMaxAgeMs: number;
  readonly particularsMaxAgeMs: number;
  readonly voyageMaxAgeMs: number;
}

export const DEFAULT_VESSEL_DETAIL_POLICY: Readonly<VesselDetailPolicy> = Object.freeze({
  position: DEFAULT_MAP_READINESS_POLICY,
  identityMaxAgeMs: 90 * DAY,
  particularsMaxAgeMs: 90 * DAY,
  voyageMaxAgeMs: 7 * DAY,
});

// ---------------------------------------------------------------------------
//  Chiếu
// ---------------------------------------------------------------------------

function toDetailValue<T>(field: ResolvedField<T> | null | undefined): DetailValue<T> | null {
  if (field === null || field === undefined) return null;
  // Bóc đúng bốn thứ. `rejected`/`reason`/`observationId` ở lại bên trong.
  return {
    value: field.value,
    source: field.source,
    observedAt: field.observedAt ?? null,
    fetchedAt: field.fetchedAt,
  };
}

/** Mốc cập nhật của một nhóm = `fetchedAt` MỚI NHẤT trong các field có mặt. */
function latestFetchedAt(values: readonly (DetailValue<unknown> | null)[]): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (latest === null || value.fetchedAt.getTime() > latest.getTime()) latest = value.fetchedAt;
  }
  return latest;
}

function staticGroupState(
  values: readonly (DetailValue<unknown> | null)[],
  now: Date,
  maxAgeMs: number
): DetailGroupState {
  const updatedAt = latestFetchedAt(values);
  if (updatedAt === null) {
    return { status: DetailGroupStatus.MISSING, updatedAt: null, ageMs: null };
  }
  const ageMs = now.getTime() - updatedAt.getTime();
  return {
    status: ageMs > maxAgeMs ? DetailGroupStatus.STALE : DetailGroupStatus.AVAILABLE,
    updatedAt,
    ageMs,
  };
}

/**
 * Nhóm POSITION.
 *
 * @returns `null` khi chưa phân xử được, hoặc toạ độ không dùng được — cùng
 *          hàng rào với `MapVesselReadiness`, không có bản luật thứ hai.
 */
function projectPosition(
  vessel: ResolvedCurrentVessel,
  now: Date,
  policy: VesselDetailPolicy
): DetailPosition | null {
  const resolved = vessel.position;
  if (resolved === null) return null;

  const report = resolved.position;
  if (!isValidCoordinates(report.lat, report.lng)) return null;

  const observedAt =
    resolved.observedAt instanceof Date && Number.isFinite(resolved.observedAt.getTime())
      ? resolved.observedAt
      : null;
  const ageMs = observedAt === null ? null : now.getTime() - observedAt.getTime();

  return {
    lat: report.lat,
    lon: report.lng,
    speed: report.speed ?? null,
    course: report.course ?? null,
    heading: report.heading ?? null,
    navStatusCode: report.navStatus?.code ?? null,
    navStatusText: report.navStatus?.text ?? null,
    observedAt,
    ageMs,
    source: resolved.source,
    // Nguồn không khai mốc, hoặc mốc ở tương lai xa, hoặc quá cũ -> STALE.
    // "Không biết tuổi" KHÔNG được coi là tươi.
    status:
      ageMs === null ||
      ageMs > policy.position.maxPositionAgeMs ||
      ageMs < -policy.position.futureToleranceMs
        ? DetailGroupStatus.STALE
        : DetailGroupStatus.AVAILABLE,
  };
}

export function projectVesselDetail(
  vessel: ResolvedCurrentVessel,
  now: Date,
  policy: VesselDetailPolicy = DEFAULT_VESSEL_DETAIL_POLICY
): CanonicalVesselDetail {
  const identity: DetailIdentity = {
    name: toDetailValue(vessel.identity?.name),
    callsign: toDetailValue(vessel.identity?.callsign),
    vesselType: toDetailValue(vessel.identity?.vesselType),
    vesselTypeCode: toDetailValue(vessel.identity?.vesselTypeCode),
    flagCode: toDetailValue(vessel.identity?.flagCode),
    flagName: toDetailValue(vessel.identity?.flagName),
  };
  const particulars: DetailParticulars = {
    length: toDetailValue(vessel.particulars?.length),
    beam: toDetailValue(vessel.particulars?.beam),
    draught: toDetailValue(vessel.particulars?.draught),
    grossTonnage: toDetailValue(vessel.particulars?.grossTonnage),
    deadweight: toDetailValue(vessel.particulars?.deadweight),
    builtYear: toDetailValue(vessel.particulars?.builtYear),
  };
  const voyage: DetailVoyage = {
    destination: toDetailValue(vessel.voyage?.destination),
    eta: toDetailValue(vessel.voyage?.eta),
    currentPort: toDetailValue(vessel.voyage?.currentPort),
    nextPort: toDetailValue(vessel.voyage?.nextPort),
    lastPort: toDetailValue(vessel.voyage?.lastPort),
    lastPortDepartureAt: toDetailValue(vessel.voyage?.lastPortDepartureAt),
  };
  const position = projectPosition(vessel, now, policy);

  const groups: Record<DetailGroup, DetailGroupState> = {
    [DetailGroup.IDENTITY]: staticGroupState(
      Object.values(identity),
      now,
      policy.identityMaxAgeMs
    ),
    [DetailGroup.POSITION]:
      position === null
        ? { status: DetailGroupStatus.MISSING, updatedAt: null, ageMs: null }
        : {
            status: position.status,
            updatedAt: vessel.position?.fetchedAt ?? null,
            ageMs: position.ageMs,
          },
    [DetailGroup.PARTICULARS]: staticGroupState(
      Object.values(particulars),
      now,
      policy.particularsMaxAgeMs
    ),
    [DetailGroup.VOYAGE]: staticGroupState(Object.values(voyage), now, policy.voyageMaxAgeMs),
  };

  const missingGroups = (Object.keys(groups) as DetailGroup[]).filter(
    (group) => groups[group].status === DetailGroupStatus.MISSING
  );
  const staleGroups = (Object.keys(groups) as DetailGroup[]).filter(
    (group) => groups[group].status === DetailGroupStatus.STALE
  );
  const refreshGroups = [...missingGroups, ...staleGroups];

  return {
    identifiers: {
      mmsi: vessel.vesselKey.mmsi ?? null,
      imo: vessel.vesselKey.imo ?? vessel.identity?.imo?.value ?? null,
    },
    identity,
    position,
    particulars,
    voyage,
    groups: Object.freeze(groups),
    missingGroups: Object.freeze(missingGroups),
    staleGroups: Object.freeze(staleGroups),
    // CỜ THÔI. DETAIL-1 không gọi crawler nào; DETAIL-2 mới quyết có làm gì không.
    needsRefresh: refreshGroups.length > 0,
    refreshGroups: Object.freeze(refreshGroups),
    resolvedAt: vessel.resolvedAt,
  };
}
