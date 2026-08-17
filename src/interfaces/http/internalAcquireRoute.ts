// ============================================================================
//  INTERFACE (HTTP) · POST /internal/vessels/:id/acquire — LỆNH nội bộ
// ----------------------------------------------------------------------------
//  Marine API gọi vào đây khi canonical của nó không đủ để trả cho mobile.
//
//      POST /internal/vessels/636018086/acquire
//      X-Internal-Token: <bí mật riêng, KHÁC API_KEY công khai>
//      { "need": "POSITION", "allowPaidFallback": false }
//
//  🔴 Ba luật của biên này:
//
//  1. KHÔNG có `try { crawl() } catch { paid() }` ở đây. Route chỉ dịch HTTP
//     sang một lời gọi use case. Quyết định "có tiêu tiền không" nằm trong
//     `GetVesselWithFallback`, nơi đọc được thành luật và test được.
//
//  2. Marine KHÔNG được chọn nguồn. Body chỉ có `need` + `allowPaidFallback`.
//     Gửi kèm `source`/`provider` là 400 — nếu Marine chỉ định được nguồn thì
//     danh sách nguồn của Bot thành API công khai, và đổi nguồn thành breaking change.
//
//  3. `allowPaidFallback` của người gọi là ĐIỀU KIỆN CẦN, không phải điều kiện đủ.
//     Nó phải VÀ với công tắc phía server (`PAID_FALLBACK_ENABLED`). Marine sai
//     một dòng cấu hình thì không được phép biến thành hoá đơn của Bot.
// ============================================================================

import { timingSafeEqual } from "node:crypto";
import { NextFunction, Request, RequestHandler, Response, Router } from "express";
import {
  GetVesselWithFallback,
  VesselNeed,
} from "../../application/use-cases/vessel/GetVesselWithFallback";
import { InvalidVesselIdentifierError } from "../../application/use-cases/vessel/GetCanonicalVesselDetail";
import { isValidImo, isValidMmsi } from "../../domain/validators/identifiers";
import { AcquisitionRequestRegistry } from "./AcquisitionRequestRegistry";

export interface InternalAcquireDeps {
  useCase: GetVesselWithFallback;
  /**
   * Bí mật riêng của kênh nội bộ. RỖNG = route KHÔNG được gắn.
   *
   * Không dùng lại `API_KEY`: khoá đó đã đi qua nhiều chỗ và nó mở route đọc
   * cho client thường. Kênh này tiêu credit thật nên phải thu hồi được riêng.
   */
  token: string;
  /**
   * Công tắc phía SERVER cho nguồn trả tiền. Mặc định tắt.
   * @see docs/FREE_TO_PAID_FALLBACK.md
   */
  paidFallbackEnabled: boolean;
  /** Trần request mỗi phút cho MỘT định danh, và cho cả route. */
  perVesselPerMinute?: number;
  perRoutePerMinute?: number;
  now?: () => Date;
  logger?: { info(message: string): void };
  idempotencyRegistry?: AcquisitionRequestRegistry;
}

export const DEFAULT_INTERNAL_ACQUIRE_LIMITS = Object.freeze({
  /**
   * 3/phút cho một tàu là đủ cho người dùng bấm lại vài lần; cooldown của làn
   * trả tiền vẫn là hàng rào chi phí thật, còn cái này chặn vòng lặp hỏng.
   */
  perVesselPerMinute: 3,
  /** Trần cho cả route: một vòng lặp bên Marine không được kéo cả Bot đi. */
  perRoutePerMinute: 120,
  /** Trần số khoá nhớ được — bộ đếm rate limit không được thành rò rỉ. */
  maxTrackedKeys: 10_000,
});

function safeEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Cửa sổ cố định, KHÔNG phải token bucket.
 *
 * Cửa sổ cố định cho phép gấp đôi trần quanh mép cửa sổ. Chấp nhận: đây là
 * hàng rào chống vòng lặp hỏng, không phải hạn mức thương mại — và đơn giản
 * nghĩa là đọc xong biết chắc nó làm gì.
 */
class FixedWindowCounter {
  private windowStartedAt = 0;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly maxKeys: number
  ) {}

  /** `true` = còn lượt (và đã tính). */
  tryConsume(key: string, nowMs: number): boolean {
    const window = Math.floor(nowMs / 60_000);
    if (window !== this.windowStartedAt) {
      this.windowStartedAt = window;
      this.counts.clear();
    }
    const used = this.counts.get(key) ?? 0;
    if (used >= this.limit) return false;
    if (used === 0 && this.counts.size >= this.maxKeys) {
      // Bảng đầy: đuổi khoá cũ nhất theo thứ tự chèn, không để map phình vô hạn.
      const oldest = this.counts.keys().next();
      if (!oldest.done) this.counts.delete(oldest.value);
    }
    this.counts.set(key, used + 1);
    return true;
  }
}

/** `null` = body sai; message đã sẵn sàng trả 400. */
function parseNeed(body: unknown): VesselNeed | { error: string } {
  const record = (body ?? {}) as Record<string, unknown>;

  // §Luật 2 — Marine không chọn nguồn.
  for (const forbidden of ["source", "sources", "provider", "useMyShipTracking"]) {
    if (forbidden in record) {
      return { error: `Body không được chứa "${forbidden}": Bot tự chọn nguồn` };
    }
  }

  const need = record.need;
  if (need !== VesselNeed.POSITION && need !== VesselNeed.DETAIL) {
    return { error: `need phải là ${VesselNeed.POSITION} hoặc ${VesselNeed.DETAIL}` };
  }

  const allow = record.allowPaidFallback;
  if (allow !== undefined && typeof allow !== "boolean") {
    return { error: "allowPaidFallback phải là boolean" };
  }
  return need;
}

export function createInternalAcquireRouter(deps: InternalAcquireDeps): Router {
  const now = deps.now ?? (() => new Date());
  const perVessel = new FixedWindowCounter(
    deps.perVesselPerMinute ?? DEFAULT_INTERNAL_ACQUIRE_LIMITS.perVesselPerMinute,
    DEFAULT_INTERNAL_ACQUIRE_LIMITS.maxTrackedKeys
  );
  const perRoute = new FixedWindowCounter(
    deps.perRoutePerMinute ?? DEFAULT_INTERNAL_ACQUIRE_LIMITS.perRoutePerMinute,
    1
  );
  const idempotency = deps.idempotencyRegistry ?? new AcquisitionRequestRegistry({ ttlMs: 10 * 60_000, maxEntries: 20_000 }, now);

  const guard: RequestHandler = (req, res, next) => {
    const provided = req.header("x-internal-token") ?? "";
    if (deps.token.length === 0 || !safeEqual(provided, deps.token)) {
      // Không nói khoá sai ở đâu, không nói route có tồn tại hay không.
      res.status(401).json({ code: "UNAUTHORIZED", error: "Cần X-Internal-Token hợp lệ" });
      return;
    }
    next();
  };

  const router = Router();

  router.post(
    "/internal/vessels/:id/acquire",
    guard,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id ?? "").trim();
        // Định danh rác bị chặn Ở BIÊN: không lượt crawl hay credit nào được
        // xuất phát từ một chuỗi mà chưa ai kiểm.
        const isMmsi = isValidMmsi(id);
        const isImo = !isMmsi && isValidImo(id);
        if (!isMmsi && !isImo) {
          res.status(400).json({ code: "BAD_IDENTIFIER", error: `Định danh không hợp lệ: "${id}"` });
          return;
        }

        const parsed = parseNeed(req.body);
        if (typeof parsed !== "string") {
          res.status(400).json({ code: "BAD_REQUEST", error: parsed.error });
          return;
        }

        const nowMs = now().getTime();
        if (!perRoute.tryConsume("*", nowMs) || !perVessel.tryConsume(id, nowMs)) {
          res.status(429).json({ code: "RATE_LIMITED", error: "Quá nhiều lệnh acquire" });
          return;
        }

        // §Luật 3 — VÀ với công tắc server. `=== true` để `undefined` là TỪ CHỐI.
        const requested = (req.body as { allowPaidFallback?: boolean }).allowPaidFallback === true;
        const acquisitionRequestId = (req.body as { acquisitionRequestId?: unknown }).acquisitionRequestId;
        if (acquisitionRequestId !== undefined && (typeof acquisitionRequestId !== "string" || !/^[A-Za-z0-9-]{8,128}$/.test(acquisitionRequestId))) {
          res.status(400).json({ code: "BAD_REQUEST", error: "acquisitionRequestId phải là chuỗi 8-128 ký tự an toàn" });
          return;
        }
        const allowPaidFallback = requested && deps.paidFallbackEnabled;
        if (requested && !allowPaidFallback) {
          deps.logger?.info(
            `[internal-acquire] ${id} xin paid nhưng PAID_FALLBACK_ENABLED=false -> chỉ chạy free`
          );
        }

        const command = () => deps.useCase.execute({ ...(isMmsi ? { mmsi: id } : { imo: id }), need: parsed, allowPaidFallback });
        const result = acquisitionRequestId === undefined ? await command() : await idempotency.run(acquisitionRequestId, command);

        res.json({
          status: result.status,
          sourceUsed: result.sourceUsed,
          need: result.need,
          detail: result.detail,
          externalAttempted: result.externalAttempted,
          dataUpdated: result.dataUpdated,
          fallbackUsed: result.fallbackUsed,
          ...(result.paidSkipReason === undefined
            ? {}
            : { paidSkipReason: result.paidSkipReason }),
          ...(result.paidAttempt === undefined ? {} : { paidAttempt: result.paidAttempt }),
          remainingMissingGroups: result.remainingMissingGroups,
          remainingStaleGroups: result.remainingStaleGroups,
          durationMs: result.durationMs,
          /** Người gọi xin paid mà server tắt -> nói thẳng, không giả vờ đã thử. */
          paidRequestedButDisabled: requested && !allowPaidFallback,
          ...(acquisitionRequestId === undefined ? {} : { acquisitionRequestId }),
        });
      } catch (err) {
        if (err instanceof InvalidVesselIdentifierError) {
          res.status(400).json({ code: "BAD_IDENTIFIER", error: err.message });
          return;
        }
        next(err);
      }
    }
  );

  return router;
}
