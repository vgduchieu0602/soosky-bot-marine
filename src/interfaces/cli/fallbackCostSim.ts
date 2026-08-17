// ============================================================================
//  INTERFACE (CLI) · Đo số lần gọi nguồn TRẢ TIỀN của làn LOCAL → FREE → PAID
// ----------------------------------------------------------------------------
//  Chạy:  npm run fallback:cost
//         npm run fallback:cost -- --vessels=200 --repeat=3
//
//  🔴 Đây là ĐO, không phải dự đoán. Nó chạy chính `GetVesselWithFallback` thật
//     với hai làn bị thay bằng bản đếm, rồi in ra số credit ĐÃ BỊ GỌI. Con số
//     duy nhất do người dùng đưa vào là "tỉ lệ canonical thiếu" và "tỉ lệ nguồn
//     free hỏng" — mọi thứ còn lại (cooldown, capability, ngân sách) là hành vi
//     thật của code.
//
//  ⚠️ Tỉ lệ free-miss là THAM SỐ, không phải kết quả đo. Muốn có con số thật
//     phải chạy làn free lên nguồn thật trong một khoảng thời gian rồi lấy
//     `freeExhausted / requests` từ `getStats()`. Bảng dưới đây trả lời:
//     "với tỉ lệ đó thì hoá đơn là bao nhiêu", chứ không khai tỉ lệ đó là bao nhiêu.
//
//  ⛔ KHÔNG mạng · KHÔNG Mongo · KHÔNG một credit thật nào bị tiêu.
// ============================================================================

import { VesselSource } from "../../domain/enums/VesselSource";
import { DetailRefreshGate } from "../../application/services/vessel/DetailRefreshGate";
import {
  CanonicalVesselDetail,
  DetailGroup,
  DetailGroupStatus,
} from "../../application/services/vessel/VesselDetailProjector";
import { PaidTrackingStatus } from "../../application/use-cases/tracking/TrackVesselCurrentPosition";
import { VesselDetailStatus } from "../../application/use-cases/vessel/GetCanonicalVesselDetail";
import { RefreshAttemptStatus } from "../../application/use-cases/vessel/GetOrRefreshVesselDetail";
import {
  GetVesselWithFallback,
  VesselNeed,
} from "../../application/use-cases/vessel/GetVesselWithFallback";

/** Sinh số CÓ HẠT GIỐNG: hai lần chạy cùng cờ phải ra cùng con số. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const MISSING: Readonly<{ status: DetailGroupStatus; updatedAt: null; ageMs: null }> =
  Object.freeze({ status: DetailGroupStatus.MISSING, updatedAt: null, ageMs: null });
const AVAILABLE = Object.freeze({
  status: DetailGroupStatus.AVAILABLE,
  updatedAt: new Date(0),
  ageMs: 0,
});

/**
 * Read model tối giản. Chỉ ba nhóm trạng thái là đủ, vì `GetVesselWithFallback`
 * chỉ đọc `groups`, `missingGroups`, `staleGroups`, `needsRefresh`.
 */
function detail(mmsi: string, missing: readonly DetailGroup[]): CanonicalVesselDetail {
  const groups = {
    [DetailGroup.IDENTITY]: missing.includes(DetailGroup.IDENTITY) ? MISSING : AVAILABLE,
    [DetailGroup.POSITION]: missing.includes(DetailGroup.POSITION) ? MISSING : AVAILABLE,
    [DetailGroup.PARTICULARS]: missing.includes(DetailGroup.PARTICULARS) ? MISSING : AVAILABLE,
    [DetailGroup.VOYAGE]: missing.includes(DetailGroup.VOYAGE) ? MISSING : AVAILABLE,
  };
  return {
    identifiers: { mmsi, imo: null },
    identity: {} as never,
    position: null,
    particulars: {} as never,
    voyage: {} as never,
    groups,
    missingGroups: missing,
    staleGroups: [],
    needsRefresh: missing.length > 0,
    refreshGroups: missing,
    resolvedAt: new Date(0),
  } as CanonicalVesselDetail;
}

interface Scenario {
  readonly label: string;
  readonly need: VesselNeed;
  /** Nhóm còn thiếu khi canonical KHÔNG đủ. */
  readonly missing: readonly DetailGroup[];
  /** Tỉ lệ request mà canonical không đủ (THAM SỐ). */
  readonly localMissRatio: number;
  /** Trong số đó, tỉ lệ mà làn free cũng không lấp được (THAM SỐ). */
  readonly freeFailRatio: number;
  readonly allowPaidFallback: boolean;
}

interface Measured {
  readonly requests: number;
  readonly freeCalls: number;
  readonly paidCalls: number;
  readonly cooldownSaves: number;
  readonly capabilitySaves: number;
}

async function measure(
  scenario: Scenario,
  requests: number,
  vessels: number,
  seed: number
): Promise<Measured> {
  const random = lcg(seed);
  // Đồng hồ giả tiến 1 giây mỗi request: cooldown 10 phút phải nhìn thấy được,
  // và ngân sách 15 giây của một lượt không bị chính đồng hồ này làm cạn.
  let clockMs = Date.UTC(2026, 7, 17);
  const now = () => new Date(clockMs);

  let freeCalls = 0;
  let paidCalls = 0;
  let cooldownSaves = 0;
  let capabilitySaves = 0;

  /** Con tàu này đang thiếu gì. Làn free thành công thì xoá khỏi map. */
  const state = new Map<string, readonly DetailGroup[]>();

  const read = {
    async execute(input: { mmsi?: string }) {
      const missing = state.get(input.mmsi ?? "");
      if (missing === undefined) {
        return { status: VesselDetailStatus.FOUND, detail: detail(input.mmsi ?? "", []) };
      }
      return {
        status: VesselDetailStatus.FOUND,
        detail: detail(input.mmsi ?? "", missing),
      };
    },
  };

  const free = {
    async execute(input: { mmsi?: string }) {
      freeCalls += 1;
      const mmsi = input.mmsi ?? "";
      const failed = random() < scenario.freeFailRatio;
      if (!failed) state.delete(mmsi);
      const current = state.get(mmsi);
      return {
        detail: detail(mmsi, current ?? []),
        status: VesselDetailStatus.FOUND,
        refreshed: true,
        requestedGroups: [],
        refreshedGroups: failed ? [] : scenario.missing,
        remainingMissingGroups: current ?? [],
        remainingStaleGroups: [],
        attempts: [
          {
            source: VesselSource.SHIPFINDER,
            status: failed ? RefreshAttemptStatus.TIMEOUT : RefreshAttemptStatus.SUCCESS,
            durationMs: 0,
          },
        ],
      };
    },
  };

  const paid = {
    async execute(input: { mmsi?: string }) {
      paidCalls += 1;
      state.delete(input.mmsi ?? "");
      return {
        status: PaidTrackingStatus.UPDATED,
        source: VesselSource.MYSHIPTRACKING,
        expectedCreditCost: 1,
        actualCreditCharged: 1,
        observationsSaved: 1,
        requestSent: true,
      };
    },
  };

  const sut = new GetVesselWithFallback({
    read: read as never,
    free: free as never,
    paid: paid as never,
    gate: new DetailRefreshGate({ now }),
    now,
  });

  for (let index = 0; index < requests; index += 1) {
    clockMs += 1_000;
    const mmsi = `9${(100000 + (index % vessels)).toString()}`;
    if (random() < scenario.localMissRatio) state.set(mmsi, scenario.missing);

    const before = sut.getStats();
    const result = await sut.execute({
      mmsi,
      need: scenario.need,
      allowPaidFallback: scenario.allowPaidFallback,
    });
    if (result.paidSkipReason === "COOLDOWN") cooldownSaves += 1;
    if (result.paidSkipReason === "NO_PAID_CAPABILITY") capabilitySaves += 1;
    void before;
  }

  return { requests, freeCalls, paidCalls, cooldownSaves, capabilitySaves };
}

const SCENARIOS: readonly Scenario[] = [
  {
    label: "POSITION · thiếu 20% · free hỏng 10% · paid TẮT (mặc định production)",
    need: VesselNeed.POSITION,
    missing: [DetailGroup.POSITION],
    localMissRatio: 0.2,
    freeFailRatio: 0.1,
    allowPaidFallback: false,
  },
  {
    label: "POSITION · thiếu 20% · free hỏng 10% · paid BẬT",
    need: VesselNeed.POSITION,
    missing: [DetailGroup.POSITION],
    localMissRatio: 0.2,
    freeFailRatio: 0.1,
    allowPaidFallback: true,
  },
  {
    label: "POSITION · thiếu 20% · free hỏng 100% (nguồn free chết) · paid BẬT",
    need: VesselNeed.POSITION,
    missing: [DetailGroup.POSITION],
    localMissRatio: 0.2,
    freeFailRatio: 1,
    allowPaidFallback: true,
  },
  {
    label: "DETAIL · chỉ thiếu PARTICULARS · free hỏng 100% · paid BẬT",
    need: VesselNeed.DETAIL,
    missing: [DetailGroup.PARTICULARS],
    localMissRatio: 0.2,
    freeFailRatio: 1,
    allowPaidFallback: true,
  },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: number): number => {
    const raw = args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const vessels = flag("vessels", 100);
  const seed = flag("seed", 20260817);
  const volumes = [100, 1_000, 10_000];

  console.log("== ĐO CHI PHÍ LÀN LOCAL -> FREE -> PAID ==");
  console.log(`   tàu riêng biệt: ${vessels} · hạt giống: ${seed} · 1 credit = 1 lần gọi paid`);
  console.log("   ⚠️ tỉ lệ thiếu / tỉ lệ free hỏng là THAM SỐ, không phải số đo được.\n");

  for (const scenario of SCENARIOS) {
    console.log(`— ${scenario.label}`);
    for (const requests of volumes) {
      const measured = await measure(scenario, requests, vessels, seed);
      const perRequest = measured.paidCalls / measured.requests;
      console.log(
        `   ${String(requests).padStart(6)} request  ` +
          `free=${String(measured.freeCalls).padStart(5)}  ` +
          `paid=${String(measured.paidCalls).padStart(5)}  ` +
          `credit/request=${perRequest.toFixed(4)}  ` +
          `cooldown chặn=${measured.cooldownSaves}  ` +
          `capability chặn=${measured.capabilitySaves}`
      );
    }
    console.log("");
  }

  console.log("Đọc bảng:");
  console.log("  · paid=0 ở dòng đầu là hàng rào quan trọng nhất: cờ tắt thì hoá đơn là 0.");
  console.log("  · cooldown 10 phút là thứ giữ 'paid' không tỉ lệ thuận với lượng request.");
  console.log("  · dòng PARTICULARS phải luôn paid=0: endpoint vị trí không có nhóm đó.");
}

main().catch((error: unknown) => {
  console.error("Sim thất bại:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
