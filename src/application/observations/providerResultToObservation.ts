// ============================================================================
//  APPLICATION · ProviderResult -> Observation (hàm thuần)
// ----------------------------------------------------------------------------
//  Một `ProviderDetailsResult` có tối đa 4 nhóm -> sinh tối đa 4 observation
//  RIÊNG BIỆT. KHÔNG gộp thành một bản ghi khổng lồ: mỗi nhóm có độ tươi và độ
//  tin cậy riêng, gộp lại là mất khả năng phân xử theo nhóm ở phase sau.
//
//  Nguồn và mốc thời gian lấy từ `metadata` của CHÍNH nhóm đó (canonical A1 đã
//  mang sẵn) — mapper không tự bịa. `sourceReceivedAt` upstream không cho thì
//  giữ nguyên null.
//
//  Chưa gắn `rawPayload`: giữ hay không là việc của RawPayloadPolicy, mà chính
//  sách đó lại phụ thuộc kết quả validate. Recorder làm bước đó.
// ============================================================================

import {
  ProviderDetailsResult,
  ProviderPositionResult,
  ProviderSearchResult,
} from "../providers/ProviderResults";
import { VesselIdentity } from "../../domain/canonical/VesselIdentity";
import { VesselParticulars } from "../../domain/canonical/VesselParticulars";
import { VesselPositionReport } from "../../domain/canonical/VesselPositionReport";
import { VesselVoyage } from "../../domain/canonical/VesselVoyage";
import { validateObservation } from "../../domain/observations/observationValidators";
import {
  VesselObservationKey,
  VesselObservationType,
  VesselSourceObservation,
  createObservationKey,
} from "../../domain/observations/VesselObservation";

export interface ObservationMappingContext {
  /** VD "vesselfinder-html-v1". Nguồn đổi form -> bump để phân biệt bản ghi. */
  parserVersion?: string;
  /** Mốc dùng cho validator (chặn năm đóng ở tương lai). */
  now?: Date;
}

type CanonicalGroup = VesselIdentity | VesselPositionReport | VesselParticulars | VesselVoyage;

/** Nhóm thiếu cả mmsi lẫn imo -> bỏ qua, không làm hỏng cả mẻ. */
function tryKey(group: CanonicalGroup): VesselObservationKey | null {
  try {
    return createObservationKey({ mmsi: group.mmsi, imo: group.imo });
  } catch {
    return null;
  }
}

function build(
  type: VesselObservationType,
  group: CanonicalGroup,
  context: ObservationMappingContext
): VesselSourceObservation | null {
  const vesselKey = tryKey(group);
  if (vesselKey === null) return null;

  const base = {
    source: group.metadata.source,
    vesselKey,
    fetchedAt: group.metadata.fetchedAt,
    sourceReceivedAt: group.metadata.sourceReceivedAt ?? null,
    parserVersion: context.parserVersion,
  };

  // `as` cần thiết vì union được phân biệt bằng `type` — cặp (type, data) đã
  // được các hàm gọi bên dưới ghép đúng, không có đường nào ghép sai.
  const draft = { ...base, type, data: group } as VesselSourceObservation;
  return { ...draft, validation: validateObservation(draft, { now: context.now }) };
}

/** 0..4 observation, theo đúng số nhóm mà provider thực sự trả về. */
export function detailsResultToObservations(
  result: ProviderDetailsResult,
  context: ObservationMappingContext = {}
): readonly VesselSourceObservation[] {
  const observations: VesselSourceObservation[] = [];
  const groups: Array<[VesselObservationType, CanonicalGroup | undefined]> = [
    [VesselObservationType.IDENTITY, result.identity],
    [VesselObservationType.POSITION, result.position],
    [VesselObservationType.PARTICULARS, result.particulars],
    [VesselObservationType.VOYAGE, result.voyage],
  ];

  for (const [type, group] of groups) {
    if (group === undefined) continue;
    const observation = build(type, group, context);
    if (observation !== null) observations.push(observation);
  }
  return Object.freeze(observations);
}

/** POSITION + (IDENTITY nếu nguồn trả kèm, VD `name` trong bản ghi mp2). */
export function positionResultToObservations(
  result: ProviderPositionResult,
  context: ObservationMappingContext = {}
): readonly VesselSourceObservation[] {
  return detailsResultToObservations(
    { position: result.position, identity: result.identity },
    context
  );
}

/** IDENTITY + (POSITION nếu nguồn trả kèm). */
export function searchResultToObservations(
  result: ProviderSearchResult,
  context: ObservationMappingContext = {}
): readonly VesselSourceObservation[] {
  return detailsResultToObservations(
    { identity: result.identity, position: result.position },
    context
  );
}
