// ============================================================================
// APPLICATION · CrawlPositionFreshnessPolicy — time classification only
// ============================================================================

export const CrawlPositionFreshness = {
  FRESH: "FRESH",
  STALE: "STALE",
  UNKNOWN: "UNKNOWN",
} as const;

export type CrawlPositionFreshness =
  (typeof CrawlPositionFreshness)[keyof typeof CrawlPositionFreshness];

export interface CrawlPositionFreshnessPolicy {
  readonly staleAfterMs: number;
  readonly futureToleranceMs: number;
}

/**
 * Operational starting point for current-map fallback. It is intentionally
 * independent from detail/voyage freshness and should be supplied by the
 * production map composition root when it differs from this baseline.
 */
export const DEFAULT_CRAWL_POSITION_FRESHNESS_POLICY: Readonly<CrawlPositionFreshnessPolicy> =
  Object.freeze({ staleAfterMs: 30 * 60 * 1000, futureToleranceMs: 5 * 60 * 1000 });

export function classifyCrawlPositionFreshness(
  observedAt: Date | null | undefined,
  now: Date,
  policy: CrawlPositionFreshnessPolicy = DEFAULT_CRAWL_POSITION_FRESHNESS_POLICY
): CrawlPositionFreshness {
  if (observedAt === null || observedAt === undefined || !Number.isFinite(observedAt.getTime())) {
    return CrawlPositionFreshness.UNKNOWN;
  }
  const ageMs = now.getTime() - observedAt.getTime();
  if (ageMs < -policy.futureToleranceMs || ageMs > policy.staleAfterMs) {
    return CrawlPositionFreshness.STALE;
  }
  return CrawlPositionFreshness.FRESH;
}
