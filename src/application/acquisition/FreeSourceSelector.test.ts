// ============================================================================
//  TEST · FreeSourceSelector
// ----------------------------------------------------------------------------
//  Chạy trên `SOURCE_CAPABILITY_MATRIX` THẬT, không mock matrix — nếu luật chọn
//  nguồn và bằng chứng capability lệch nhau thì test này phải thấy.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselField, VesselFieldGroup } from "../../domain/value-objects/VesselField";
import { VesselObservationKey } from "../../domain/observations/VesselObservation";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { ProviderOperation } from "../providers/VesselDataProvider";
import { SourceHealthState } from "../runtime/SourceHealthTracker";
import {
  AcquisitionAttempt,
  AcquisitionOutcome,
  AttemptScope,
} from "./AcquisitionAttempt";
import { DataNeed, DataNeedType } from "./DataNeed";
import { FreeSourceSelector } from "./FreeSourceSelector";
import { MissingRequirement, MissingReason, SufficiencyResult } from "./SufficiencyTypes";
import { SourceSelectionReason, SourceSkipReason } from "./SourceSelectionTypes";

const MMSI = "636018086";
const IMO = "9467976";
const NOW = new Date("2026-08-14T17:00:00.000Z");
const MINUTE = 60 * 1000;

const selector = new FreeSourceSelector();
const allHealthy = () => SourceHealthState.HEALTHY;

function healthMap(
  overrides: Partial<Record<VesselSource, SourceHealthState>>
): (source: VesselSource) => SourceHealthState {
  return (source) => overrides[source] ?? SourceHealthState.HEALTHY;
}

function run(props: {
  need: DataNeed;
  missing: readonly MissingRequirement[];
  key?: VesselObservationKey;
  healthOf?: (source: VesselSource) => SourceHealthState;
  attempts?: readonly AcquisitionAttempt[];
  now?: Date;
  satisfied?: boolean;
}) {
  const sufficiency: SufficiencyResult = {
    satisfied: props.satisfied ?? false,
    need: props.need,
    missing: props.missing,
  };
  return selector.select({
    key: props.key ?? { mmsi: MMSI },
    need: props.need,
    sufficiency,
    healthOf: props.healthOf ?? allHealthy,
    attempts: props.attempts,
    now: props.now ?? NOW,
  });
}

// Các "thiếu" hay dùng.
const POSITION_STALE: MissingRequirement = {
  group: VesselFieldGroup.POSITION,
  reason: MissingReason.POSITION_NOT_FRESH_ENOUGH,
};
const NEEDS_DESTINATION: MissingRequirement = {
  group: VesselFieldGroup.VOYAGE,
  field: VesselField.DESTINATION,
  reason: MissingReason.MISSING_REQUIRED_FIELD,
};
const NEEDS_BUILT_YEAR: MissingRequirement = {
  group: VesselFieldGroup.PARTICULARS,
  field: VesselField.BUILT_YEAR,
  reason: MissingReason.MISSING_REQUIRED_FIELD,
};

function skipReason(
  result: ReturnType<typeof run>,
  source: VesselSource
): SourceSkipReason | undefined {
  return result.skipped.find((entry) => entry.source === source)?.reason;
}

// ---- Đã đủ ----------------------------------------------------------------

test("sufficiency.satisfied -> next null, không cân nhắc nguồn nào", () => {
  const result = run({
    need: { type: DataNeedType.POSITION },
    missing: [],
    satisfied: true,
  });

  assert.equal(result.next, null);
  assert.deepEqual([...result.skipped], []);
});

// ---- POSITION -------------------------------------------------------------

test("POSITION cũ · ShipFinder thắng dù defaultPriority KÉM hơn ShipInfo", () => {
  const result = run({ need: { type: DataNeedType.POSITION }, missing: [POSITION_STALE] });

  assert.equal(result.next?.source, VesselSource.SHIPFINDER);
  assert.equal(result.next?.operation, ProviderOperation.GET_POSITION);
  assert.equal(result.next?.reason, SourceSelectionReason.BEST_POSITION_SOURCE);
  // ShipInfo priority 45 < ShipFinder 55 — nhưng vị trí bản free trễ ~14 giờ.
  assert.notEqual(result.next?.source, VesselSource.SHIPINFO);
});

test("POSITION · chỉ thiếu vị trí -> GET_POSITION, không GET_DETAILS", () => {
  const result = run({ need: { type: DataNeedType.POSITION }, missing: [POSITION_STALE] });

  assert.equal(result.next?.operation, ProviderOperation.GET_POSITION);
  assert.deepEqual(
    [...(result.next?.targetFields ?? [])],
    [VesselField.LAT, VesselField.LNG, VesselField.POSITION_RECEIVED_AT]
  );
});

test("POSITION · ShipFinder COOLDOWN -> nguồn vị trí free khác, KHÔNG ShipFinder", () => {
  const result = run({
    need: { type: DataNeedType.POSITION },
    missing: [POSITION_STALE],
    healthOf: healthMap({ [VesselSource.SHIPFINDER]: SourceHealthState.COOLDOWN }),
  });

  assert.equal(skipReason(result, VesselSource.SHIPFINDER), SourceSkipReason.SOURCE_COOLDOWN);
  assert.notEqual(result.next?.source, VesselSource.SHIPFINDER);
  assert.equal(result.next?.source, VesselSource.SHIPINFO);
});

test("POSITION · chỉ có IMO -> ShipFinder bị loại UNSUPPORTED_IDENTIFIER", () => {
  const result = run({
    need: { type: DataNeedType.POSITION },
    missing: [POSITION_STALE],
    key: { imo: IMO },
  });

  // /ship/detail/imo/{imo} trả 404 — NOT_FOUND được đảm bảo trước, chặn ở đây.
  assert.equal(
    skipReason(result, VesselSource.SHIPFINDER),
    SourceSkipReason.UNSUPPORTED_IDENTIFIER
  );
  assert.equal(result.next?.source, VesselSource.SHIPINFO);
});

test("POSITION · VesselFinder bị loại vì positionReceivedAt chỉ CANDIDATE", () => {
  const result = run({ need: { type: DataNeedType.POSITION }, missing: [POSITION_STALE] });

  // `lrpd` là chuỗi tương đối "0 min ago" -> không map được thành mốc thật ->
  // mọi vị trí rơi vào bậc NO_SOURCE_TIME -> gọi nó không giải quyết gì.
  assert.equal(
    skipReason(result, VesselSource.VESSELFINDER),
    SourceSkipReason.NO_REQUIRED_CAPABILITY
  );
});

// ---- Field cụ thể ---------------------------------------------------------

test("BUILT_YEAR -> ShipInfo, nguồn free DUY NHẤT", () => {
  const result = run({
    need: { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.BUILT_YEAR] },
    missing: [NEEDS_BUILT_YEAR],
  });

  assert.equal(result.next?.source, VesselSource.SHIPINFO);
  assert.equal(result.next?.reason, SourceSelectionReason.ONLY_SOURCE_FOR_REQUIRED_FIELD);
  assert.deepEqual([...(result.next?.targetFields ?? [])], [VesselField.BUILT_YEAR]);
  // ShipFinder khoẻ, priority không tệ — nhưng builtYear nằm sau API ký chữ ký.
  assert.equal(
    skipReason(result, VesselSource.SHIPFINDER),
    SourceSkipReason.NO_REQUIRED_CAPABILITY
  );
});

test("DEADWEIGHT -> ShipInfo, ShipFinder không phải ứng viên", () => {
  const result = run({
    need: { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.DEADWEIGHT] },
    missing: [
      {
        group: VesselFieldGroup.PARTICULARS,
        field: VesselField.DEADWEIGHT,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      },
    ],
  });

  assert.equal(result.next?.source, VesselSource.SHIPINFO);
  assert.equal(
    skipReason(result, VesselSource.SHIPFINDER),
    SourceSkipReason.NO_REQUIRED_CAPABILITY
  );
});

test("LENGTH · ShipFinder LÀ ứng viên, ShipInfo thì KHÔNG", () => {
  const result = run({
    need: { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.LENGTH] },
    missing: [
      {
        group: VesselFieldGroup.PARTICULARS,
        field: VesselField.LENGTH,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      },
    ],
  });

  // ShipInfo đảo length/beam không nhất quán giữa các tàu -> UNSUPPORTED.
  assert.equal(skipReason(result, VesselSource.SHIPINFO), SourceSkipReason.NO_REQUIRED_CAPABILITY);
  assert.equal(skipReason(result, VesselSource.SHIPFINDER), undefined, "ShipFinder là ứng viên");
});

test("LENGTH · VesselFinder thắng bằng defaultPriority — KHÔNG override vô căn cứ", () => {
  const result = run({
    need: { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.LENGTH] },
    missing: [
      {
        group: VesselFieldGroup.PARTICULARS,
        field: VesselField.LENGTH,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      },
    ],
  });

  // VesselFinder VÀ ShipFinder đều CONFIRMED `length`. Không có bằng chứng đo
  // đạc nào nói bên nào chính xác hơn -> không tạo bảng ưu tiên riêng, để
  // defaultPriority (20 < 55) quyết. Khác hẳn POSITION, nơi bằng chứng có thật
  // (trễ 14 giờ vs vài phút) nên MỚI có positionPreference.
  assert.equal(result.next?.source, VesselSource.VESSELFINDER);
  assert.equal(result.next?.reason, SourceSelectionReason.LOWER_COST_FREE_SOURCE);
});

test("DESTINATION -> ShipFinder, nguồn free DUY NHẤT", () => {
  const result = run({ need: { type: DataNeedType.VOYAGE }, missing: [NEEDS_DESTINATION] });

  assert.equal(result.next?.source, VesselSource.SHIPFINDER);
  assert.equal(result.next?.operation, ProviderOperation.GET_DETAILS);
  assert.equal(result.next?.reason, SourceSelectionReason.ONLY_SOURCE_FOR_REQUIRED_FIELD);
  // VesselFinder có operations.voyage = false; ShipInfo không có destination.
  assert.equal(
    skipReason(result, VesselSource.VESSELFINDER),
    SourceSkipReason.NO_REQUIRED_CAPABILITY
  );
  assert.equal(skipReason(result, VesselSource.SHIPINFO), SourceSkipReason.NO_REQUIRED_CAPABILITY);
});

test("ETA · KHÔNG nguồn free nào CONFIRMED -> next null · ca bắt buộc", () => {
  const result = run({
    need: { type: DataNeedType.VOYAGE, requiredFields: [VesselField.ETA] },
    missing: [
      {
        group: VesselFieldGroup.VOYAGE,
        field: VesselField.ETA,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      },
    ],
  });

  // ShipFinder cho "07-29 07:01" THIẾU NĂM -> mapper cố ý không map -> CANDIDATE.
  // Gọi lại nó là đi lấy thứ nguồn đó không có.
  assert.equal(result.next, null);
  assert.equal(
    skipReason(result, VesselSource.SHIPFINDER),
    SourceSkipReason.NO_REQUIRED_CAPABILITY
  );
  assert.equal(skipReason(result, VesselSource.SHIPINFO), SourceSkipReason.NO_REQUIRED_CAPABILITY);
});

test("GROSS_TONNAGE · không nguồn free nào -> next null", () => {
  const result = run({
    need: { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.GROSS_TONNAGE] },
    missing: [
      {
        group: VesselFieldGroup.PARTICULARS,
        field: VesselField.GROSS_TONNAGE,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      },
    ],
  });
  assert.equal(result.next, null);
});

test("CANDIDATE không đủ để tự động crawl", () => {
  // `heading` của VesselFinder là CANDIDATE (chưa audit #djson đầy đủ).
  const result = run({
    need: { type: DataNeedType.POSITION, requiredFields: [VesselField.HEADING] },
    missing: [
      {
        group: VesselFieldGroup.POSITION,
        field: VesselField.HEADING,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      },
    ],
  });

  assert.equal(result.next?.source, VesselSource.SHIPFINDER, "chỉ ShipFinder CONFIRMED heading");
  assert.equal(
    skipReason(result, VesselSource.VESSELFINDER),
    SourceSkipReason.NO_REQUIRED_CAPABILITY
  );
});

// ---- Gộp field ------------------------------------------------------------

test("hai field cùng một nguồn -> MỘT plan, không hai request", () => {
  const result = run({
    need: {
      type: DataNeedType.PARTICULARS,
      requiredFields: [VesselField.BUILT_YEAR, VesselField.DEADWEIGHT],
    },
    missing: [
      NEEDS_BUILT_YEAR,
      {
        group: VesselFieldGroup.PARTICULARS,
        field: VesselField.DEADWEIGHT,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      },
    ],
  });

  assert.equal(result.next?.source, VesselSource.SHIPINFO);
  assert.deepEqual(
    [...(result.next?.targetFields ?? [])],
    [VesselField.BUILT_YEAR, VesselField.DEADWEIGHT]
  );
});

// ---- Sức khoẻ -------------------------------------------------------------

test("ngang khả năng -> nguồn HEALTHY thắng nguồn DEGRADED", () => {
  const need = { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.LENGTH] };
  const missing = [
    {
      group: VesselFieldGroup.PARTICULARS,
      field: VesselField.LENGTH,
      reason: MissingReason.MISSING_REQUIRED_FIELD,
    },
  ];

  // VesselFinder thường thắng bằng priority. Cho nó DEGRADED -> ShipFinder lên.
  const result = run({
    need,
    missing,
    healthOf: healthMap({ [VesselSource.VESSELFINDER]: SourceHealthState.DEGRADED }),
  });

  assert.equal(result.next?.source, VesselSource.SHIPFINDER);
  assert.equal(result.next?.reason, SourceSelectionReason.HEALTHIER_SOURCE);
});

test("DEGRADED vẫn được chọn khi là nguồn duy nhất — DEGRADED ≠ DISABLED", () => {
  const result = run({
    need: { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.BUILT_YEAR] },
    missing: [NEEDS_BUILT_YEAR],
    healthOf: healthMap({ [VesselSource.SHIPINFO]: SourceHealthState.DEGRADED }),
  });

  assert.equal(result.next?.source, VesselSource.SHIPINFO);
});

test("capability ĐỨNG TRƯỚC sức khoẻ", () => {
  const result = run({
    need: { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.BUILT_YEAR] },
    missing: [NEEDS_BUILT_YEAR],
    healthOf: healthMap({ [VesselSource.SHIPINFO]: SourceHealthState.DEGRADED }),
  });

  // ShipFinder HEALTHY nhưng không cấp được builtYear; ShipInfo DEGRADED thì có.
  assert.equal(result.next?.source, VesselSource.SHIPINFO);
  assert.equal(
    skipReason(result, VesselSource.SHIPFINDER),
    SourceSkipReason.NO_REQUIRED_CAPABILITY
  );
});

test("COOLDOWN và DISABLED không bao giờ được chọn", () => {
  const result = run({
    need: { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.BUILT_YEAR] },
    missing: [NEEDS_BUILT_YEAR],
    healthOf: healthMap({ [VesselSource.SHIPINFO]: SourceHealthState.DISABLED }),
  });

  assert.equal(result.next, null);
  assert.equal(skipReason(result, VesselSource.SHIPINFO), SourceSkipReason.SOURCE_DISABLED);
});

test("ưu tiên vị trí THẮNG sức khoẻ — nguồn khoẻ mà trễ 14h không giải quyết gì", () => {
  const result = run({
    need: { type: DataNeedType.POSITION },
    missing: [POSITION_STALE],
    healthOf: healthMap({ [VesselSource.SHIPFINDER]: SourceHealthState.DEGRADED }),
  });

  // ShipInfo HEALTHY nhưng trễ ~14 giờ -> không bao giờ đạt LIVE.
  // ShipFinder DEGRADED = "có chuỗi hỏng chưa tới ngưỡng", vẫn còn cơ hội.
  assert.equal(result.next?.source, VesselSource.SHIPFINDER);
});

// ---- Chặn theo lần đã thử -------------------------------------------------

function attempt(props: {
  source: VesselSource;
  outcome: AcquisitionOutcome;
  scope: AttemptScope;
  minutesAgo?: number;
  key?: VesselObservationKey;
}): AcquisitionAttempt {
  return {
    source: props.source,
    operation: ProviderOperation.GET_POSITION,
    vesselKey: props.key ?? { mmsi: MMSI },
    attemptedAt: new Date(NOW.getTime() - (props.minutesAgo ?? 0) * MINUTE),
    outcome: props.outcome,
    scope: props.scope,
  };
}

test("NOT_FOUND 1 phút trước -> RECENTLY_ATTEMPTED, chọn nguồn khác", () => {
  const result = run({
    need: { type: DataNeedType.POSITION },
    missing: [POSITION_STALE],
    attempts: [
      attempt({
        source: VesselSource.SHIPFINDER,
        outcome: AcquisitionOutcome.NOT_FOUND,
        scope: AttemptScope.RECENT,
        minutesAgo: 1,
      }),
    ],
  });

  assert.equal(skipReason(result, VesselSource.SHIPFINDER), SourceSkipReason.RECENTLY_ATTEMPTED);
  assert.equal(result.next?.source, VesselSource.SHIPINFO);
});

test("NOT_FOUND quá TTL -> ShipFinder được thử lại", () => {
  const result = run({
    need: { type: DataNeedType.POSITION },
    missing: [POSITION_STALE],
    attempts: [
      attempt({
        source: VesselSource.SHIPFINDER,
        outcome: AcquisitionOutcome.NOT_FOUND,
        scope: AttemptScope.RECENT,
        minutesAgo: 20, // > 15 phút
      }),
    ],
  });

  assert.equal(result.next?.source, VesselSource.SHIPFINDER);
});

test("SUCCESS trong lượt NÀY -> không chọn lại dù vẫn chưa đủ", () => {
  const result = run({
    need: { type: DataNeedType.POSITION },
    missing: [POSITION_STALE],
    attempts: [
      attempt({
        source: VesselSource.SHIPFINDER,
        outcome: AcquisitionOutcome.SUCCESS,
        scope: AttemptScope.CURRENT_REQUEST,
      }),
    ],
  });

  // Dữ liệu nó có đã lấy rồi. Hỏi lại cho ra đúng thế.
  assert.equal(
    skipReason(result, VesselSource.SHIPFINDER),
    SourceSkipReason.ALREADY_ATTEMPTED_THIS_REQUEST
  );
  assert.equal(result.next?.source, VesselSource.SHIPINFO);
});

test("FAILED trong lượt NÀY -> không chọn lại · hàng rào chống vòng lặp", () => {
  const result = run({
    need: { type: DataNeedType.POSITION },
    missing: [POSITION_STALE],
    attempts: [
      attempt({
        source: VesselSource.SHIPFINDER,
        outcome: AcquisitionOutcome.FAILED,
        scope: AttemptScope.CURRENT_REQUEST,
      }),
    ],
  });

  assert.equal(
    skipReason(result, VesselSource.SHIPFINDER),
    SourceSkipReason.ALREADY_ATTEMPTED_THIS_REQUEST
  );
  assert.notEqual(result.next?.source, VesselSource.SHIPFINDER);
});

test("FAILED ở lượt TRƯỚC không bị chặn chồng — health lo cooldown", () => {
  const result = run({
    need: { type: DataNeedType.POSITION },
    missing: [POSITION_STALE],
    attempts: [
      attempt({
        source: VesselSource.SHIPFINDER,
        outcome: AcquisitionOutcome.FAILED,
        scope: AttemptScope.RECENT,
        minutesAgo: 1,
      }),
    ],
  });

  assert.equal(result.next?.source, VesselSource.SHIPFINDER);
});

test("attempt của tàu KHÁC không chặn tàu này", () => {
  const result = run({
    need: { type: DataNeedType.POSITION },
    missing: [POSITION_STALE],
    attempts: [
      attempt({
        source: VesselSource.SHIPFINDER,
        outcome: AcquisitionOutcome.NOT_FOUND,
        scope: AttemptScope.RECENT,
        minutesAgo: 1,
        key: { mmsi: "367452710" },
      }),
    ],
  });

  assert.equal(result.next?.source, VesselSource.SHIPFINDER);
});

test("mọi nguồn đều bị chặn -> next null", () => {
  const result = run({
    need: { type: DataNeedType.POSITION },
    missing: [POSITION_STALE],
    attempts: [
      attempt({
        source: VesselSource.SHIPFINDER,
        outcome: AcquisitionOutcome.FAILED,
        scope: AttemptScope.CURRENT_REQUEST,
      }),
      attempt({
        source: VesselSource.SHIPINFO,
        outcome: AcquisitionOutcome.NOT_FOUND,
        scope: AttemptScope.CURRENT_REQUEST,
      }),
    ],
  });

  assert.equal(result.next, null, "chưa đủ dữ liệu, nhưng hết nguồn free đáng thử");
});

// ---- Không bao giờ chọn ---------------------------------------------------

test("AISSTREAM không bao giờ được chọn dù matrix nói có vị trí", () => {
  const result = run({ need: { type: DataNeedType.POSITION }, missing: [POSITION_STALE] });

  assert.notEqual(result.next?.source, VesselSource.AISSTREAM);
  // Marine production sở hữu connection; bot không mở cái thứ hai.
  assert.equal(skipReason(result, VesselSource.AISSTREAM), SourceSkipReason.UNSUPPORTED_NEED);
});

test("MYSHIPTRACKING không bao giờ được chọn dù phủ mọi field", () => {
  const result = run({
    need: { type: DataNeedType.VOYAGE, requiredFields: [VesselField.ETA] },
    missing: [
      {
        group: VesselFieldGroup.VOYAGE,
        field: VesselField.ETA,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      },
    ],
  });

  assert.equal(result.next, null, "hết nguồn free -> null, KHÔNG rơi sang paid");
  assert.equal(
    skipReason(result, VesselSource.MYSHIPTRACKING),
    SourceSkipReason.UNSUPPORTED_NEED
  );
});

// ---- NO_CURRENT_VESSEL ----------------------------------------------------

test("NO_CURRENT_VESSEL · suy ra yêu cầu MẶC ĐỊNH, không gọi mọi nguồn", () => {
  const result = run({
    need: { type: DataNeedType.FULL },
    missing: [{ reason: MissingReason.NO_CURRENT_VESSEL }],
  });

  // ShipFinder phủ được cả bốn nhóm trong MỘT request.
  assert.equal(result.next?.source, VesselSource.SHIPFINDER);
  assert.equal(result.next?.operation, ProviderOperation.GET_DETAILS);
  assert.equal(result.next?.reason, SourceSelectionReason.BEST_CAPABILITY_MATCH);
});

test("NO_CURRENT_VESSEL · requiredFields KHÔNG được rơi rụng", () => {
  // P9.2 chỉ kịp nói "không có gì" — nó không liệt kê từng field thiếu. Nếu
  // selector bỏ qua `requiredFields` ở nhánh này, yêu cầu builtYear sẽ rơi về
  // particulars CHUNG và chọn phải nguồn không cấp được builtYear.
  const result = run({
    need: { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.BUILT_YEAR] },
    missing: [{ reason: MissingReason.NO_CURRENT_VESSEL }],
  });

  assert.equal(result.next?.source, VesselSource.SHIPINFO);
  assert.ok(
    result.next?.targetFields.includes(VesselField.BUILT_YEAR),
    "field đích danh phải nằm trong plan"
  );
});

test("NO_CURRENT_VESSEL · requiredFields của nhóm khác cũng được giữ", () => {
  const result = run({
    need: { type: DataNeedType.FULL, requiredFields: [VesselField.HEADING] },
    missing: [{ reason: MissingReason.NO_CURRENT_VESSEL }],
  });

  // Chỉ ShipFinder CONFIRMED heading -> nó phải phủ thêm yêu cầu đó.
  assert.equal(result.next?.source, VesselSource.SHIPFINDER);
  assert.ok(result.next?.targetFields.includes(VesselField.HEADING));
});

test("NO_CURRENT_VESSEL · need POSITION chỉ suy ra yêu cầu vị trí", () => {
  const result = run({
    need: { type: DataNeedType.POSITION },
    missing: [{ reason: MissingReason.NO_CURRENT_VESSEL }],
  });

  assert.equal(result.next?.source, VesselSource.SHIPFINDER);
  assert.equal(result.next?.operation, ProviderOperation.GET_POSITION);
});

// ---- FULL · coverage ------------------------------------------------------

test("FULL · nguồn phủ NHIỀU yêu cầu hơn đi trước", () => {
  const result = run({
    need: { type: DataNeedType.FULL, requiredFields: [VesselField.BUILT_YEAR] },
    missing: [POSITION_STALE, NEEDS_DESTINATION, NEEDS_BUILT_YEAR],
  });

  // ShipFinder phủ position + destination (2); ShipInfo phủ builtYear (1).
  assert.equal(result.next?.source, VesselSource.SHIPFINDER);
  assert.equal(result.next?.operation, ProviderOperation.GET_DETAILS);
  assert.deepEqual(
    [...(result.next?.targetFields ?? [])],
    [VesselField.DESTINATION, VesselField.LAT, VesselField.LNG, VesselField.POSITION_RECEIVED_AT]
  );
});

test("FULL · chỉ trả MỘT plan, không trả cả chuỗi", () => {
  const result = run({
    need: { type: DataNeedType.FULL, requiredFields: [VesselField.BUILT_YEAR] },
    missing: [POSITION_STALE, NEEDS_DESTINATION, NEEDS_BUILT_YEAR],
  });

  // `next` là một object, không phải mảng. P9.4 phải resolve + hỏi lại rồi mới
  // đi tiếp — đó chính là cách điều kiện dừng được bảo đảm.
  assert.ok(result.next);
  assert.equal(Array.isArray(result.next), false);
});

test("FULL · sau khi ShipFinder đã thử -> tới ShipInfo cho builtYear", () => {
  const result = run({
    need: { type: DataNeedType.FULL, requiredFields: [VesselField.BUILT_YEAR] },
    missing: [NEEDS_BUILT_YEAR],
    attempts: [
      attempt({
        source: VesselSource.SHIPFINDER,
        outcome: AcquisitionOutcome.SUCCESS,
        scope: AttemptScope.CURRENT_REQUEST,
      }),
    ],
  });

  assert.equal(result.next?.source, VesselSource.SHIPINFO);
  assert.deepEqual([...(result.next?.targetFields ?? [])], [VesselField.BUILT_YEAR]);
});

// ---- Tất định -------------------------------------------------------------

test("TẤT ĐỊNH · xáo thứ tự `missing` không đổi kết quả", () => {
  const need = { type: DataNeedType.FULL, requiredFields: [VesselField.BUILT_YEAR] };
  const items = [POSITION_STALE, NEEDS_DESTINATION, NEEDS_BUILT_YEAR];

  const orders = [
    [0, 1, 2], [2, 1, 0], [1, 0, 2], [0, 2, 1], [2, 0, 1], [1, 2, 0],
  ].map((order) => run({ need, missing: order.map((i) => items[i]) }));

  const sources = orders.map((r) => r.next?.source);
  assert.equal(new Set(sources).size, 1, `winner phải ổn định, nhận ${sources.join(" | ")}`);

  const fields = orders.map((r) => (r.next?.targetFields ?? []).join(","));
  assert.equal(new Set(fields).size, 1, "targetFields cũng phải ổn định");
});

test("TẤT ĐỊNH · xáo thứ tự `attempts` không đổi kết quả", () => {
  const attempts = [
    attempt({
      source: VesselSource.SHIPFINDER,
      outcome: AcquisitionOutcome.NOT_FOUND,
      scope: AttemptScope.RECENT,
      minutesAgo: 1,
    }),
    attempt({
      source: VesselSource.SHIPINFO,
      outcome: AcquisitionOutcome.FAILED,
      scope: AttemptScope.RECENT,
      minutesAgo: 2,
    }),
  ];
  const need = { type: DataNeedType.POSITION };

  const a = run({ need, missing: [POSITION_STALE], attempts });
  const b = run({ need, missing: [POSITION_STALE], attempts: [...attempts].reverse() });

  assert.equal(a.next?.source, b.next?.source);
  assert.deepEqual(
    [...a.skipped].sort((x, y) => x.source.localeCompare(y.source)),
    [...b.skipped].sort((x, y) => x.source.localeCompare(y.source))
  );
});

test("TẤT ĐỊNH · `skipped` sắp theo tên nguồn", () => {
  const result = run({ need: { type: DataNeedType.POSITION }, missing: [POSITION_STALE] });
  const names = result.skipped.map((entry) => entry.source);
  assert.deepEqual([...names], [...names].sort((a, b) => a.localeCompare(b)));
});

test("THUẦN · gọi nhiều lần cho cùng kết quả", () => {
  const need = { type: DataNeedType.FULL };
  const missing = [POSITION_STALE, NEEDS_DESTINATION];

  const a = run({ need, missing });
  const b = run({ need, missing });
  assert.deepEqual(a, b);
});

test("`now` là THAM SỐ — cửa sổ chặn hết hạn theo nó", () => {
  const attempts = [
    attempt({
      source: VesselSource.SHIPFINDER,
      outcome: AcquisitionOutcome.NOT_FOUND,
      scope: AttemptScope.RECENT,
      minutesAgo: 1,
    }),
  ];
  const need = { type: DataNeedType.POSITION };

  assert.equal(
    run({ need, missing: [POSITION_STALE], attempts }).next?.source,
    VesselSource.SHIPINFO
  );
  // 20 phút sau, cùng dữ liệu -> cửa sổ 15 phút đã hết.
  assert.equal(
    run({
      need,
      missing: [POSITION_STALE],
      attempts,
      now: new Date(NOW.getTime() + 20 * MINUTE),
    }).next?.source,
    VesselSource.SHIPFINDER
  );
});
