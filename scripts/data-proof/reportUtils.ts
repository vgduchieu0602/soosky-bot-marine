/**
 * REGIONAL-DATA-PROOF-1 — report calculation helpers.
 *
 * Pure functions only: coverage counting, request-metric accumulation,
 * classification and markdown rendering. No HTTP, no Mongo, no provider, no
 * filesystem — the runner owns all of that.
 *
 * Coverage predicates deliberately delegate to the DOMAIN validators
 * (`domain/validators/geo`, `.../motion`, `.../identifiers`). Coordinate and
 * motion range rules are NOT duplicated here.
 */
import { isValidCoordinates, isValidLatitude, isValidLongitude } from "../../src/domain/validators/geo";
import { isValidCourse, isValidSpeed } from "../../src/domain/validators/motion";
import { isValidImo, isValidMmsi } from "../../src/domain/validators/identifiers";

// ---------------------------------------------------------------------------
//  Timestamp derivation (§21) — diagnostic classification, NOT a domain concept
// ---------------------------------------------------------------------------

export const TimestampDerivation = {
  ABSOLUTE_SOURCE_TIME: "ABSOLUTE_SOURCE_TIME",
  RELATIVE_SOURCE_AGE: "RELATIVE_SOURCE_AGE",
  NO_SOURCE_TIME: "NO_SOURCE_TIME",
} as const;

export type TimestampDerivation =
  (typeof TimestampDerivation)[keyof typeof TimestampDerivation];

// ---------------------------------------------------------------------------
//  VesselBasics sample
// ---------------------------------------------------------------------------

/**
 * One vessel as ONE source described it, already flattened out of the
 * observation/canonical shape. Every field is nullable: absent means "the
 * source did not supply it", never "the vessel does not have it".
 */
export interface VesselBasicsSample {
  mmsi: string | null;
  vesselName: string | null;
  imo: string | null;
  vesselType: string | null;
  vesselTypeCode: number | null;
  lat: number | null;
  lon: number | null;
  course: number | null;
  speed: number | null;
  navStatusCode: number | null;
  navStatusText: string | null;
  observedAt: Date | null;
  timestampDerivation: TimestampDerivation;
}

export const VESSEL_BASICS_FIELDS = [
  "vesselName",
  "mmsi",
  "imo",
  "vType",
  "lat",
  "lon",
  "latLon",
  "course",
  "speed",
  "navStatus",
  "received",
] as const;

export type VesselBasicsField = (typeof VESSEL_BASICS_FIELDS)[number];

/**
 * §19 — text is covered only when it carries actual data. Source placeholders
 * ("-", "---", "N/A", "Unknown") are NOT coverage.
 */
const TEXT_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "",
  "-",
  "--",
  "---",
  "n/a",
  "na",
  "null",
  "undefined",
  "unknown",
]);

export function isUsableText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return !TEXT_PLACEHOLDERS.has(value.trim().toLowerCase());
}

/** AIS navigational status code range. */
function isValidNavStatusCode(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 15;
}

/**
 * Is this field COVERED for this sample?
 *
 * Numeric zero counts — a source that explicitly reported `speed = 0` told us
 * something true. Absence is represented by `null`, never by `0`, because every
 * mapper in `infrastructure/integrations` already refuses to invent zeros.
 */
export function isFieldCovered(sample: VesselBasicsSample, field: VesselBasicsField): boolean {
  switch (field) {
    case "vesselName":
      return isUsableText(sample.vesselName);
    case "mmsi":
      return isValidMmsi(sample.mmsi);
    case "imo":
      return isValidImo(sample.imo);
    case "vType":
      return isUsableText(sample.vesselType) || Number.isFinite(sample.vesselTypeCode);
    case "lat":
      return isValidLatitude(sample.lat);
    case "lon":
      return isValidLongitude(sample.lon);
    case "latLon":
      return isValidCoordinates(sample.lat, sample.lon);
    case "course":
      return isValidCourse(sample.course);
    case "speed":
      return isValidSpeed(sample.speed);
    case "navStatus":
      return isValidNavStatusCode(sample.navStatusCode) || isUsableText(sample.navStatusText);
    case "received":
      // §20 — source observation time only. `fetchedAt` is never accepted here.
      return (
        sample.observedAt instanceof Date &&
        Number.isFinite(sample.observedAt.getTime()) &&
        sample.timestampDerivation !== TimestampDerivation.NO_SOURCE_TIME
      );
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
//  Coverage + classification
// ---------------------------------------------------------------------------

export function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((1000 * part) / whole) / 10;
}

export const CoverageClass = {
  GOOD: "GOOD",
  USABLE: "USABLE",
  WEAK: "WEAK",
  VERY_WEAK: "VERY_WEAK",
  NOT_AVAILABLE: "NOT_AVAILABLE",
} as const;

export type CoverageClass = (typeof CoverageClass)[keyof typeof CoverageClass];

/** §31 — reporting only. Never call this from runtime business logic. */
export function classifyCoverage(percentage: number): CoverageClass {
  if (percentage >= 90) return CoverageClass.GOOD;
  if (percentage >= 70) return CoverageClass.USABLE;
  if (percentage >= 30) return CoverageClass.WEAK;
  if (percentage > 0) return CoverageClass.VERY_WEAK;
  return CoverageClass.NOT_AVAILABLE;
}

export interface FieldCoverage {
  available: number;
  sample: number;
  pct: number;
  classification: CoverageClass;
}

export type CoverageBlock = Record<VesselBasicsField, FieldCoverage>;

export function coverageBlock(samples: readonly VesselBasicsSample[]): CoverageBlock {
  const out = {} as CoverageBlock;
  for (const field of VESSEL_BASICS_FIELDS) {
    const available = samples.filter((sample) => isFieldCovered(sample, field)).length;
    const percentage = pct(available, samples.length);
    out[field] = {
      available,
      sample: samples.length,
      pct: percentage,
      classification: classifyCoverage(percentage),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Request metrics (§25)
// ---------------------------------------------------------------------------

export const REQUEST_OUTCOMES = [
  "200",
  "3xx",
  "403",
  "404",
  "429",
  "5xx",
  "timeout",
  "networkError",
  "parseError",
  "notFound",
  "unknown",
  "skipped",
] as const;

export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];

export interface RequestMetrics {
  requests: number;
  outcomes: Record<RequestOutcome, number>;
  latenciesMs: number[];
}

export function newRequestMetrics(): RequestMetrics {
  const outcomes = {} as Record<RequestOutcome, number>;
  for (const outcome of REQUEST_OUTCOMES) outcomes[outcome] = 0;
  return { requests: 0, outcomes, latenciesMs: [] };
}

export function recordRequest(
  metrics: RequestMetrics,
  outcome: RequestOutcome,
  latencyMs: number
): void {
  if (outcome !== "skipped") {
    metrics.requests += 1;
    metrics.latenciesMs.push(latencyMs);
  }
  metrics.outcomes[outcome] += 1;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

export interface RequestMetricsSummary {
  requests: number;
  outcomes: Record<RequestOutcome, number>;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export function summarizeRequests(metrics: RequestMetrics): RequestMetricsSummary {
  const total = metrics.latenciesMs.reduce((a, b) => a + b, 0);
  return {
    requests: metrics.requests,
    outcomes: metrics.outcomes,
    avgLatencyMs: metrics.latenciesMs.length
      ? Math.round(total / metrics.latenciesMs.length)
      : null,
    p95LatencyMs: percentile(metrics.latenciesMs, 95),
  };
}

/** Severe blocking gate for §15 (Stage B eligibility). */
export function severeBlockCount(summary: RequestMetricsSummary): number {
  const o = summary.outcomes;
  return o["403"] + o["429"] + o.timeout + o["5xx"];
}

// ---------------------------------------------------------------------------
//  Markdown rendering
// ---------------------------------------------------------------------------

function cell(coverage: FieldCoverage | undefined): string {
  if (!coverage) return "—";
  return `${coverage.pct}%`;
}

/** §29 — VESSELBASICS COVERAGE per region. */
export function renderRegionalMatrix(
  byRegion: Record<string, CoverageBlock>,
  columns: readonly string[]
): string[] {
  const lines: string[] = [];
  lines.push(`| FIELD | ${columns.join(" | ")} |`);
  lines.push(`|---|${columns.map(() => "---:").join("|")}|`);
  for (const field of VESSEL_BASICS_FIELDS) {
    lines.push(`| ${field} | ${columns.map((c) => cell(byRegion[c]?.[field])).join(" | ")} |`);
  }
  return lines;
}

/** §30 — FIELD | VesselFinder | ShipFinder | ShipInfo | Combined. */
export function renderProviderMatrix(
  byProvider: Record<string, CoverageBlock>,
  columns: readonly string[]
): string[] {
  return renderRegionalMatrix(byProvider, columns);
}

export function renderClassificationTable(block: CoverageBlock): string[] {
  const lines: string[] = [];
  lines.push("| FIELD | covered | sample | pct | class |");
  lines.push("|---|---:|---:|---:|---|");
  for (const field of VESSEL_BASICS_FIELDS) {
    const c = block[field];
    lines.push(
      `| ${field} | ${c.available} | ${c.sample} | ${c.pct}% | ${c.classification} |`
    );
  }
  return lines;
}

export function renderRequestMetricsTable(
  rows: readonly { scope: string; summary: RequestMetricsSummary }[]
): string[] {
  const lines: string[] = [];
  lines.push(
    "| scope | req | 200 | 3xx | 403 | 404 | 429 | 5xx | timeout | net | parse | notFound | avg ms | p95 ms |"
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const { scope, summary } of rows) {
    const o = summary.outcomes;
    lines.push(
      `| ${scope} | ${summary.requests} | ${o["200"]} | ${o["3xx"]} | ${o["403"]} | ${o["404"]} | ` +
        `${o["429"]} | ${o["5xx"]} | ${o.timeout} | ${o.networkError} | ${o.parseError} | ${o.notFound} | ` +
        `${summary.avgLatencyMs ?? "—"} | ${summary.p95LatencyMs ?? "—"} |`
    );
  }
  return lines;
}
