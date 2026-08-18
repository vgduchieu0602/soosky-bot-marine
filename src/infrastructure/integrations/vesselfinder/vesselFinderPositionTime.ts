// ============================================================================
//  INFRASTRUCTURE · VesselFinder: `lrpd` — tuổi TƯƠNG ĐỐI của bản tin vị trí
// ----------------------------------------------------------------------------
//  Trang chi tiết KHÔNG cho mốc thời gian tuyệt đối. Nó cho một chuỗi kiểu
//  "5 min ago" trong `#djson.lrpd`. Đây là kiến thức RIÊNG của nguồn này nên nó
//  sống cạnh provider/mapper của nguồn, không phải trong domain, application
//  hay trong script proof (PROVIDER_ARCHITECTURE.md §2).
//
//  Trước đây logic này chỉ tồn tại trong `scripts/data-proof/*` — nghĩa là bản
//  chẩn đoán "nhìn thấy" mốc thời gian còn production thì không, và canonical
//  vĩnh viễn xếp mọi vị trí VesselFinder vào bậc NO_SOURCE_TIME.
//
//  ⚠️ Tuổi tương đối KHÔNG phải mốc tuyệt đối. Nó chỉ dùng được khi neo vào
//  `fetchedAt` — mốc mà CHÍNH TA đo được lúc tải trang:
//
//      observedAt = fetchedAt - age
//
//  Không đọc được tuổi -> `null`. TUYỆT ĐỐI không rơi về `fetchedAt`: đó là
//  bịa độ tươi, và resolver sẽ tin rằng một vị trí cũ 5 ngày là vừa mới.
// ============================================================================

import { isValidDate } from "../../../domain/value-objects/SourceMetadata";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Tuổi tương đối lớn nhất còn coi là dùng được. Quá mốc này thì bản tin đã
 * ngoài mọi ngưỡng của `PositionResolverPolicy` (EXPIRED > 24h) và chuỗi nguồn
 * cũng hay là rác ("a long time ago") -> trả null thay vì một Date vô nghĩa.
 */
export const MAX_RELATIVE_AGE_MS = 30 * DAY_MS;

/** Chuỗi nguồn coi như "không có dữ liệu". */
const PLACEHOLDERS: ReadonlySet<string> = new Set(["", "-", "--", "---", "n/a", "na", "unknown"]);

/**
 * "5 min ago" / "1 hour ago" / "2 days ago" / "just now" -> milliseconds.
 *
 * @returns null khi chuỗi vắng mặt, là placeholder, không khớp dạng nào, hoặc
 *          vượt `MAX_RELATIVE_AGE_MS`. Không đoán, không làm tròn mò.
 */
export function parseVesselFinderRelativeAgeMs(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const text = raw.trim().toLowerCase();
  if (PLACEHOLDERS.has(text)) return null;

  // "just now" và "0 min ago" đều nghĩa là tuổi 0 — GIỮ số 0, không coi là thiếu.
  if (text === "just now" || text === "now") return 0;

  const patterns: Array<[RegExp, number]> = [
    [/^(\d+)\s*s(?:ec(?:ond)?s?)?\s*ago$/, 1_000],
    [/^(\d+)\s*m(?:in(?:ute)?s?)?\s*ago$/, MINUTE_MS],
    [/^(\d+)\s*h(?:(?:ou)?rs?)?\s*ago$/, HOUR_MS],
    [/^(\d+)\s*d(?:ays?)?\s*ago$/, DAY_MS],
  ];

  for (const [pattern, unitMs] of patterns) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const ageMs = Number(match[1]) * unitMs;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_RELATIVE_AGE_MS) return null;
    return ageMs;
  }
  return null;
}

/**
 * Mốc quan sát của NGUỒN, neo vào lúc ta tải được trang.
 *
 * @param raw       giá trị `lrpd` thô của trang chi tiết
 * @param fetchedAt lúc bot tải trang (đồng hồ của ta) — bắt buộc hợp lệ
 * @returns `fetchedAt - age`, hoặc null khi nguồn không nói tuổi. KHÔNG bao giờ
 *          trả về chính `fetchedAt` khi thiếu tuổi.
 */
export function deriveVesselFinderObservedAt(
  raw: string | null | undefined,
  fetchedAt: Date
): Date | null {
  if (!isValidDate(fetchedAt)) return null;
  const ageMs = parseVesselFinderRelativeAgeMs(raw);
  if (ageMs === null) return null;
  return new Date(fetchedAt.getTime() - ageMs);
}
