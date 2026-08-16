// ============================================================================
//  TEST · PaidFallbackGate
// ----------------------------------------------------------------------------
//  Cổng này quyết định có tiêu TIỀN THẬT hay không. Mỗi test dưới đây là một
//  đường mà tiền có thể rò ra nếu luật sai.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselField, VesselFieldGroup } from "../../../domain/enums/VesselField";
import { VesselObservationKey } from "../../../domain/entities/VesselObservation";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { ProviderOperation } from "../../contracts/providers/VesselDataProvider";
import {
  AcquisitionAttempt,
  AcquisitionOutcome,
  AttemptScope,
} from "./AcquisitionAttempt";
import { DataNeed, DataNeedType, InvalidDataNeedError } from "./DataNeed";
import { PaidBudgetSnapshot } from "./PaidFallbackPolicy";
import {
  FreeAcquisitionOutcome,
  PaidFallbackGate,
  PaidGateDecision,
  PaidGateReason,
} from "./PaidFallbackGate";
import {
  MYSHIPTRACKING_FIELD_VALUE,
  PaidFieldValue,
} from "./PaidSourceCapability";
import { MissingRequirement, MissingReason, SufficiencyResult } from "./SufficiencyTypes";

const MMSI = "636018086";
const IMO = "9467976";
const NOW = new Date("2026-08-15T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const gate = new PaidFallbackGate();

const BUDGET_OK: PaidBudgetSnapshot = { enabled: true, remainingCalls: 100 };

const POSITION_STALE: MissingRequirement = {
  group: VesselFieldGroup.POSITION,
  reason: MissingReason.POSITION_NOT_FRESH_ENOUGH,
};
const NEEDS_HEADING: MissingRequirement = {
  group: VesselFieldGroup.POSITION,
  field: VesselField.HEADING,
  reason: MissingReason.MISSING_REQUIRED_FIELD,
};
const NEEDS_BUILT_YEAR: MissingRequirement = {
  group: VesselFieldGroup.PARTICULARS,
  field: VesselField.BUILT_YEAR,
  reason: MissingReason.MISSING_REQUIRED_FIELD,
};
const NEEDS_GROSS_TONNAGE: MissingRequirement = {
  group: VesselFieldGroup.PARTICULARS,
  field: VesselField.GROSS_TONNAGE,
  reason: MissingReason.MISSING_REQUIRED_FIELD,
};
const NEEDS_ETA: MissingRequirement = {
  group: VesselFieldGroup.VOYAGE,
  field: VesselField.ETA,
  reason: MissingReason.MISSING_REQUIRED_FIELD,
};

function run(props: {
  need?: DataNeed;
  missing?: readonly MissingRequirement[];
  satisfied?: boolean;
  freeOutcome?: FreeAcquisitionOutcome;
  allowPaidFallback?: boolean;
  budget?: PaidBudgetSnapshot;
  attempts?: readonly AcquisitionAttempt[];
  key?: VesselObservationKey;
  now?: Date;
}) {
  const need = props.need ?? { type: DataNeedType.POSITION };
  const sufficiency: SufficiencyResult = {
    satisfied: props.satisfied ?? false,
    need,
    missing: props.missing ?? [POSITION_STALE],
  };
  return gate.evaluate({
    key: props.key ?? { mmsi: MMSI },
    need,
    sufficiency,
    freeOutcome: props.freeOutcome ?? FreeAcquisitionOutcome.NO_FREE_SOURCE_AVAILABLE,
    allowPaidFallback: props.allowPaidFallback ?? true,
    budget: props.budget ?? BUDGET_OK,
    attempts: props.attempts,
    now: props.now ?? NOW,
  });
}

function paidAttempt(props: {
  scope: AttemptScope;
  minutesAgo?: number;
  outcome?: AcquisitionOutcome;
  key?: VesselObservationKey;
  source?: VesselSource;
}): AcquisitionAttempt {
  return {
    source: props.source ?? VesselSource.MYSHIPTRACKING,
    operation: ProviderOperation.GET_DETAILS,
    vesselKey: props.key ?? { mmsi: MMSI },
    attemptedAt: new Date(NOW.getTime() - (props.minutesAgo ?? 0) * MINUTE),
    outcome: props.outcome ?? AcquisitionOutcome.SUCCESS,
    scope: props.scope,
  };
}

// ---- MẶC ĐỊNH TỪ CHỐI ------------------------------------------------------

test("allowPaidFallback=false -> DENY · ca bắt buộc", () => {
  const result = run({ allowPaidFallback: false });
  assert.equal(result.decision, PaidGateDecision.DENY);
  assert.equal(result.reason, PaidGateReason.PAID_NOT_ALLOWED);
  assert.deepEqual([...result.targetFields], []);
});

test("allowPaidFallback vắng mặt/undefined -> DENY, KHÔNG ngầm cho phép", () => {
  const need: DataNeed = { type: DataNeedType.POSITION };
  const result = gate.evaluate({
    key: { mmsi: MMSI },
    need,
    sufficiency: { satisfied: false, need, missing: [POSITION_STALE] },
    freeOutcome: FreeAcquisitionOutcome.NO_FREE_SOURCE_AVAILABLE,
    allowPaidFallback: undefined as unknown as boolean,
    budget: BUDGET_OK,
    now: NOW,
  });
  assert.equal(result.reason, PaidGateReason.PAID_NOT_ALLOWED);
});

test("cổng 1 chạy TRƯỚC mọi thứ — không lộ trạng thái khác khi chưa được phép", () => {
  const result = run({
    allowPaidFallback: false,
    satisfied: true,
    budget: { enabled: false, remainingCalls: 0 },
  });
  assert.equal(result.reason, PaidGateReason.PAID_NOT_ALLOWED);
});

// ---- Local đã đủ -----------------------------------------------------------

test("local đã đủ -> DENY dù allowPaidFallback=true · ca bắt buộc", () => {
  const result = run({ satisfied: true, missing: [] });
  assert.equal(result.decision, PaidGateDecision.DENY);
  assert.equal(result.reason, PaidGateReason.LOCAL_ALREADY_SUFFICIENT);
});

// ---- Free chưa cạn ---------------------------------------------------------

test("free còn nguồn chưa thử -> DENY · ca bắt buộc", () => {
  for (const outcome of [
    FreeAcquisitionOutcome.ATTEMPT_BUDGET_EXHAUSTED,
    FreeAcquisitionOutcome.LOCAL_DATA_SUFFICIENT,
    FreeAcquisitionOutcome.SATISFIED_AFTER_ACQUISITION,
  ]) {
    const result = run({ freeOutcome: outcome });
    assert.equal(result.decision, PaidGateDecision.DENY, outcome);
    assert.equal(result.reason, PaidGateReason.FREE_OPTIONS_NOT_EXHAUSTED, outcome);
  }
});

test("hết NGÂN SÁCH free KHÔNG phải hết NGUỒN free — tiền không mua được đường tắt", () => {
  // Đây là chỗ dễ rò tiền nhất: cứ để ngân sách free cạn rồi chuyển sang mua.
  const result = run({ freeOutcome: FreeAcquisitionOutcome.ATTEMPT_BUDGET_EXHAUSTED });
  assert.equal(result.reason, PaidGateReason.FREE_OPTIONS_NOT_EXHAUSTED);
});

// ---- Capability ------------------------------------------------------------

test("heading · nguồn TRẢ TIỀN cũng không có -> NO_PAID_CAPABILITY", () => {
  // Phát hiện của audit: response MyShipTracking không có `heading`, cả simple
  // lẫn extended. ShipFinder (MIỄN PHÍ) thì có.
  const result = run({
    need: { type: DataNeedType.POSITION, requiredFields: [VesselField.HEADING] },
    missing: [NEEDS_HEADING],
  });
  assert.equal(result.decision, PaidGateDecision.DENY);
  assert.equal(result.reason, PaidGateReason.NO_PAID_CAPABILITY);
});

test("ETA · nguồn trả tiền CÓ -> không bị chặn ở cổng capability", () => {
  // ShipFinder cho "07-29 07:01" thiếu năm; MyShipTracking cho datetime UTC.
  // Đây đúng là thứ tiền mua được.
  const result = run({
    need: { type: DataNeedType.VOYAGE, requiredFields: [VesselField.ETA] },
    missing: [NEEDS_ETA],
  });
  assert.equal(result.decision, PaidGateDecision.ALLOW);
  assert.deepEqual([...result.targetFields], [VesselField.ETA]);
});

// ---- Enrichment ------------------------------------------------------------

test("chỉ thiếu field free ĐÃ CÓ -> DENY ENRICHMENT_ONLY · ca bắt buộc", () => {
  const result = run({
    need: { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.BUILT_YEAR] },
    missing: [NEEDS_BUILT_YEAR],
  });
  assert.equal(result.decision, PaidGateDecision.DENY);
  assert.equal(result.reason, PaidGateReason.ENRICHMENT_ONLY_NEED);
});

test("grossTonnage · 0 nguồn free CONFIRMED -> ALLOW", () => {
  const result = run({
    need: { type: DataNeedType.PARTICULARS, requiredFields: [VesselField.GROSS_TONNAGE] },
    missing: [NEEDS_GROSS_TONNAGE],
  });
  assert.equal(result.decision, PaidGateDecision.ALLOW);
  assert.deepEqual([...result.targetFields], [VesselField.GROSS_TONNAGE]);
});

test("trộn enrichment + đáng tiền -> ALLOW, targetFields CHỈ gồm thứ đáng tiền", () => {
  const result = run({
    need: {
      type: DataNeedType.PARTICULARS,
      requiredFields: [VesselField.BUILT_YEAR, VesselField.GROSS_TONNAGE],
    },
    missing: [NEEDS_BUILT_YEAR, NEEDS_GROSS_TONNAGE],
  });
  assert.equal(result.decision, PaidGateDecision.ALLOW);
  assert.deepEqual([...result.targetFields], [VesselField.GROSS_TONNAGE]);
});

test("PARTICULARS trần (không field đích danh) -> DENY, không mở rộng thành mua cả nhóm", () => {
  const result = run({
    need: { type: DataNeedType.PARTICULARS },
    missing: [
      { group: VesselFieldGroup.PARTICULARS, reason: MissingReason.MISSING_GROUP },
    ],
  });
  assert.equal(result.decision, PaidGateDecision.DENY);
  assert.equal(result.reason, PaidGateReason.NO_PAID_CAPABILITY);
});

test("IDENTITY thiếu name -> DENY, cả ba nguồn free đều CONFIRMED name", () => {
  const result = run({
    need: { type: DataNeedType.IDENTITY },
    missing: [
      {
        group: VesselFieldGroup.IDENTITY,
        field: VesselField.NAME,
        reason: MissingReason.MISSING_REQUIRED_FIELD,
      },
    ],
  });
  assert.equal(result.reason, PaidGateReason.ENRICHMENT_ONLY_NEED);
});

// ---- Vị trí — lý do đáng tiền chính ---------------------------------------

test("vị trí cũ + free cạn + ngân sách còn -> ALLOW · ca bắt buộc", () => {
  const result = run({ missing: [POSITION_STALE] });

  assert.equal(result.decision, PaidGateDecision.ALLOW);
  assert.equal(result.reason, PaidGateReason.PAID_ALLOWED);
  assert.deepEqual(
    [...result.targetFields],
    [VesselField.LAT, VesselField.LNG, VesselField.POSITION_RECEIVED_AT]
  );
});

test("chưa có canonical + need POSITION -> ALLOW", () => {
  const result = run({ missing: [{ reason: MissingReason.NO_CURRENT_VESSEL }] });
  assert.equal(result.decision, PaidGateDecision.ALLOW);
});

test("FULL · vị trí thiếu kéo được cổng mở, dù các nhóm khác chỉ là enrichment", () => {
  const result = run({
    need: { type: DataNeedType.FULL },
    missing: [
      POSITION_STALE,
      { group: VesselFieldGroup.PARTICULARS, reason: MissingReason.MISSING_GROUP },
      {
        group: VesselFieldGroup.VOYAGE,
        field: VesselField.DESTINATION,
        reason: MissingReason.VOYAGE_TOO_OLD,
      },
    ],
  });

  assert.equal(result.decision, PaidGateDecision.ALLOW);
  // `destination` là ENRICHMENT_ONLY (ShipFinder có) -> không nằm trong mục tiêu.
  assert.equal(result.targetFields.includes(VesselField.DESTINATION), false);
  assert.ok(result.targetFields.includes(VesselField.LAT));
});

test("FULL · KHÔNG kéo paid chỉ vì một field tuỳ chọn thiếu", () => {
  const result = run({
    need: { type: DataNeedType.FULL, requiredFields: [VesselField.BUILT_YEAR] },
    missing: [NEEDS_BUILT_YEAR],
  });
  assert.equal(result.decision, PaidGateDecision.DENY);
  assert.equal(result.reason, PaidGateReason.ENRICHMENT_ONLY_NEED);
});

// ---- Ngân sách -------------------------------------------------------------

test("remainingCalls = 0 -> DENY BUDGET_EXHAUSTED · ca bắt buộc", () => {
  const result = run({ budget: { enabled: true, remainingCalls: 0 } });
  assert.equal(result.decision, PaidGateDecision.DENY);
  assert.equal(result.reason, PaidGateReason.BUDGET_EXHAUSTED);
});

test("remainingCalls = null -> DENY BUDGET_UNKNOWN · bảo thủ · ca bắt buộc", () => {
  const result = run({ budget: { enabled: true, remainingCalls: null } });
  assert.equal(result.decision, PaidGateDecision.DENY);
  assert.equal(result.reason, PaidGateReason.BUDGET_UNKNOWN);
  // ⚠️ `null` KHÔNG được quy ước là vô hạn. MyShipTracking không công bố giá.
});

test("tài khoản trả tiền không bật -> DENY", () => {
  const result = run({ budget: { enabled: false, remainingCalls: 1000 } });
  assert.equal(result.reason, PaidGateReason.BUDGET_EXHAUSTED);
});

test("ngân sách kiểm SAU capability — không chẩn đoán nhầm 'hết tiền'", () => {
  // Cần heading (không mua được) VÀ hết ngân sách. Lý do đúng là capability:
  // báo 'hết tiền' sẽ khiến người vận hành đi nạp quota một cách vô ích.
  const result = run({
    need: { type: DataNeedType.POSITION, requiredFields: [VesselField.HEADING] },
    missing: [NEEDS_HEADING],
    budget: { enabled: true, remainingCalls: 0 },
  });
  assert.equal(result.reason, PaidGateReason.NO_PAID_CAPABILITY);
});

// ---- Chặn theo lần đã gọi --------------------------------------------------

test("đã gọi trả tiền trong CHÍNH lượt này -> DENY · ca bắt buộc", () => {
  const result = run({
    attempts: [paidAttempt({ scope: AttemptScope.CURRENT_REQUEST })],
  });
  assert.equal(result.decision, PaidGateDecision.DENY);
  assert.equal(result.reason, PaidGateReason.PAID_ALREADY_ATTEMPTED);
});

test("vừa gọi trả tiền NOT_FOUND 1 phút trước -> DENY · ca bắt buộc", () => {
  const result = run({
    attempts: [
      paidAttempt({
        scope: AttemptScope.RECENT,
        minutesAgo: 1,
        outcome: AcquisitionOutcome.NOT_FOUND,
      }),
    ],
  });
  assert.equal(result.decision, PaidGateDecision.DENY);
  assert.equal(result.reason, PaidGateReason.RECENT_PAID_ATTEMPT);
});

test("vị trí · quá 30 phút -> được gọi lại", () => {
  const result = run({
    attempts: [paidAttempt({ scope: AttemptScope.RECENT, minutesAgo: 31 })],
  });
  assert.equal(result.decision, PaidGateDecision.ALLOW);
});

test("nhóm TĨNH dùng cửa sổ 24 giờ, dài hơn nhóm vị trí", () => {
  const need: DataNeed = {
    type: DataNeedType.PARTICULARS,
    requiredFields: [VesselField.GROSS_TONNAGE],
  };

  // 2 giờ: với vị trí thì đã qua cửa sổ, nhưng grossTonnage không đổi trong ngày.
  const blocked = run({
    need,
    missing: [NEEDS_GROSS_TONNAGE],
    attempts: [paidAttempt({ scope: AttemptScope.RECENT, minutesAgo: 120 })],
  });
  assert.equal(blocked.reason, PaidGateReason.RECENT_PAID_ATTEMPT);

  const allowed = run({
    need,
    missing: [NEEDS_GROSS_TONNAGE],
    now: new Date(NOW.getTime() + 25 * HOUR),
    attempts: [paidAttempt({ scope: AttemptScope.RECENT })],
  });
  assert.equal(allowed.decision, PaidGateDecision.ALLOW);
});

test("lần thử FREE không chặn cổng trả tiền", () => {
  const result = run({
    attempts: [
      paidAttempt({ scope: AttemptScope.CURRENT_REQUEST, source: VesselSource.SHIPFINDER }),
      paidAttempt({ scope: AttemptScope.RECENT, source: VesselSource.SHIPINFO, minutesAgo: 1 }),
    ],
  });
  assert.equal(result.decision, PaidGateDecision.ALLOW, "chúng không tốn tiền");
});

test("lần gọi trả tiền cho tàu KHÁC không chặn tàu này", () => {
  const result = run({
    attempts: [
      paidAttempt({ scope: AttemptScope.RECENT, minutesAgo: 1, key: { mmsi: "367452710" } }),
    ],
  });
  assert.equal(result.decision, PaidGateDecision.ALLOW);
});

test("tối đa MỘT lần gọi trả tiền mỗi yêu cầu", () => {
  const result = run({
    attempts: [
      paidAttempt({ scope: AttemptScope.CURRENT_REQUEST, outcome: AcquisitionOutcome.FAILED }),
    ],
  });
  // Kể cả khi lần trước HỎNG: `extended` trả cả bốn nhóm, không có endpoint nào
  // để xâu chuỗi thêm.
  assert.equal(result.reason, PaidGateReason.PAID_ALREADY_ATTEMPTED);
});

// ---- Định danh -------------------------------------------------------------

test("chỉ có IMO -> vẫn ALLOW, API nhận cả mmsi lẫn imo", () => {
  // Khác ShipFinder (404 với IMO). Đây là một trong ít lợi thế thật của paid.
  const result = run({ key: { imo: IMO } });
  assert.equal(result.decision, PaidGateDecision.ALLOW);
});

test("khoá rỗng -> DENY", () => {
  const result = run({ key: {} });
  assert.equal(result.decision, PaidGateDecision.DENY);
  assert.equal(result.reason, PaidGateReason.NO_PAID_CAPABILITY);
});

// ---- Đầu vào sai -----------------------------------------------------------

test("need sai nhóm -> ném, KHÔNG phải DENY", () => {
  assert.throws(
    () =>
      run({
        need: { type: DataNeedType.POSITION, requiredFields: [VesselField.BUILT_YEAR] },
        missing: [NEEDS_BUILT_YEAR],
      }),
    InvalidDataNeedError
  );
});

// ---- Bảng giá trị ----------------------------------------------------------

test("field chưa được audit khai -> mặc định UNSUPPORTED, không 'cứ thử xem'", () => {
  assert.equal(MYSHIPTRACKING_FIELD_VALUE[VesselField.HEADING], PaidFieldValue.UNSUPPORTED);
  // Mọi field canonical đều có mặt trong bảng — thiếu key nghĩa là "quên".
  for (const value of Object.values(MYSHIPTRACKING_FIELD_VALUE)) {
    assert.ok(Object.values(PaidFieldValue).includes(value));
  }
});

test("không field nào của nhóm vị trí bị xếp ENRICHMENT_ONLY", () => {
  for (const field of [
    VesselField.LAT,
    VesselField.LNG,
    VesselField.SPEED,
    VesselField.COURSE,
    VesselField.NAV_STATUS,
    VesselField.POSITION_RECEIVED_AT,
  ]) {
    assert.equal(MYSHIPTRACKING_FIELD_VALUE[field], PaidFieldValue.CRITICAL, field);
  }
});

// ---- Tất định --------------------------------------------------------------

test("TẤT ĐỊNH · cùng đầu vào -> cùng quyết định", () => {
  const input = {
    need: { type: DataNeedType.FULL } as DataNeed,
    missing: [POSITION_STALE, NEEDS_GROSS_TONNAGE],
  };
  const a = run(input);
  const b = run(input);
  const c = run(input);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("TẤT ĐỊNH · xáo thứ tự `missing` không đổi kết quả", () => {
  const need: DataNeed = { type: DataNeedType.FULL };
  const a = run({ need, missing: [POSITION_STALE, NEEDS_GROSS_TONNAGE] });
  const b = run({ need, missing: [NEEDS_GROSS_TONNAGE, POSITION_STALE] });
  assert.deepEqual(a, b);
});

test("`now` là THAM SỐ — cửa sổ chặn hết hạn theo nó", () => {
  const attempts = [paidAttempt({ scope: AttemptScope.RECENT, minutesAgo: 1 })];

  assert.equal(run({ attempts }).reason, PaidGateReason.RECENT_PAID_ATTEMPT);
  assert.equal(
    run({ attempts, now: new Date(NOW.getTime() + 45 * MINUTE) }).decision,
    PaidGateDecision.ALLOW
  );
});
