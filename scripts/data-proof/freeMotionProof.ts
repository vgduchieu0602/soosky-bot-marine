/**
 * FREE-MOTION-PROOF — diagnostic only.
 *
 * Discovers live MMSIs via VesselFinder map tiles (US/UK/Norway),
 * then probes VesselFinder / ShipFinder / ShipInfo getPosition in isolation.
 * Does NOT write Observation/Canonical. Does NOT use AIS or paid.
 *
 * Usage:
 *   npx ts-node scripts/data-proof/freeMotionProof.ts --stage=A
 *   npx ts-node scripts/data-proof/freeMotionProof.ts --stage=B
 */
import * as fs from "fs";
import * as path from "path";
import { buildContainer } from "../../src/bootstrap/container";
import { BoundingBox } from "../../src/application/contracts/geo/Geo";
import { VesselDataProvider } from "../../src/application/contracts/providers/VesselDataProvider";
import { mmsiIdentifier } from "../../src/domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../src/domain/enums/VesselSource";
import { VesselFinderHtmlSource } from "../../src/infrastructure/integrations/vesselfinder/VesselFinderHtmlSource";
import { HttpClient } from "../../src/infrastructure/http/HttpClient";
// Source-specific parsing belongs to the source's own folder. This script must
// never carry a second, independent copy of it (PHASE-3 §6).
import { parseVesselFinderNavStatusCode } from "../../src/infrastructure/integrations/vesselfinder/vesselFinderNavStatus";
import { parseVesselFinderRelativeAgeMs } from "../../src/infrastructure/integrations/vesselfinder/vesselFinderPositionTime";
// Range rules live in the domain; a proof script must not hold a second opinion
// about what a valid speed or course is.
import { isValidCourse, isValidSpeed } from "../../src/domain/validators/motion";

type Region = "US" | "UK" | "NORWAY";
type ProviderKey = "vesselfinder" | "shipfinder" | "shipinfo";
type TimestampDerivation = "ABSOLUTE_SOURCE_TIME" | "RELATIVE_SOURCE_AGE" | "NO_SOURCE_TIME";

type MotionRow = {
  mmsi: string;
  region: Region;
  provider: ProviderKey;
  ok: boolean;
  httpClass: string;
  latencyMs: number;
  speedKn: number | null;
  courseDeg: number | null;
  navStatusCode: number | null;
  navStatusText: string | null;
  observedAt: string | null;
  timestampDerivation: TimestampDerivation;
  ageMinutes: number | null;
  error?: string;
  surface: string;
};

type TileSpec = { region: Region; name: string; box: BoundingBox };

/** Multi-area discovery tiles (not a single port). */
const TILES: TileSpec[] = [
  // US
  { region: "US", name: "US-East-NY-NJ", box: { minLat: 40.4, minLon: -74.3, maxLat: 40.9, maxLon: -73.7 } },
  { region: "US", name: "US-East-Chesapeake", box: { minLat: 36.8, minLon: -76.5, maxLat: 37.4, maxLon: -75.8 } },
  { region: "US", name: "US-Gulf-Houston", box: { minLat: 29.2, minLon: -95.2, maxLat: 29.8, maxLon: -94.5 } },
  { region: "US", name: "US-West-LA-LB", box: { minLat: 33.5, minLon: -118.4, maxLat: 33.9, maxLon: -118.0 } },
  { region: "US", name: "US-West-Seattle", box: { minLat: 47.4, minLon: -122.6, maxLat: 47.8, maxLon: -122.2 } },
  // UK
  { region: "UK", name: "UK-Channel-Dover", box: { minLat: 50.8, minLon: 0.8, maxLat: 51.3, maxLon: 1.6 } },
  { region: "UK", name: "UK-Thames-Estuary", box: { minLat: 51.3, minLon: 0.4, maxLat: 51.7, maxLon: 1.2 } },
  { region: "UK", name: "UK-Southampton", box: { minLat: 50.7, minLon: -1.6, maxLat: 51.0, maxLon: -1.1 } },
  { region: "UK", name: "UK-Irish-Sea-Liverpool", box: { minLat: 53.2, minLon: -3.3, maxLat: 53.6, maxLon: -2.8 } },
  { region: "UK", name: "UK-Firth-of-Forth", box: { minLat: 55.9, minLon: -3.4, maxLat: 56.2, maxLon: -2.8 } },
  // Norway
  { region: "NORWAY", name: "NO-Oslofjord", box: { minLat: 59.6, minLon: 10.3, maxLat: 59.95, maxLon: 10.9 } },
  { region: "NORWAY", name: "NO-Bergen", box: { minLat: 60.2, minLon: 4.9, maxLat: 60.5, maxLon: 5.5 } },
  { region: "NORWAY", name: "NO-Stavanger", box: { minLat: 58.8, minLon: 5.4, maxLat: 59.1, maxLon: 5.9 } },
  { region: "NORWAY", name: "NO-Trondheim", box: { minLat: 63.3, minLon: 10.1, maxLat: 63.6, maxLon: 10.6 } },
  { region: "NORWAY", name: "NO-Tromso-coast", box: { minLat: 69.5, minLon: 18.7, maxLat: 69.8, maxLon: 19.3 } },
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function flag(args: string[], name: string): string | undefined {
  const p = `--${name}=`;
  return args.find((a) => a.startsWith(p))?.slice(p.length);
}

function flagInt(args: string[], name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`bad --${name}`);
  return Math.floor(n);
}

function pct(n: number, d: number): number {
  if (d <= 0) return 0;
  return Math.round((1000 * n) / d) / 10;
}

function mapNavCode(text: string | null | undefined, code: number | null | undefined): number | null {
  if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 15) return code;
  return parseVesselFinderNavStatusCode(text);
}

function classifyHttp(err: unknown): string {
  const msg = ((err as Error)?.message ?? String(err)).toLowerCase();
  if (msg.includes("403") || msg.includes("forbidden")) return "403";
  if (msg.includes("429") || msg.includes("too many")) return "429";
  if (msg.includes("404") || msg.includes("not found")) return "404";
  if (msg.includes("timeout") || msg.includes("etimedout") || msg.includes("aborted")) return "timeout";
  if (msg.includes("5") && (msg.includes("50") || msg.includes("502") || msg.includes("503"))) return "5xx";
  if (msg.includes("parse")) return "parseError";
  if (msg.includes("captcha") || msg.includes("challenge") || msg.includes("cloudflare")) return "challenge";
  return "error";
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function discoverRegion(
  vf: VesselDataProvider,
  region: Region,
  target: number,
  tileDelayMs: number
): Promise<{ mmsis: string[]; tilesUsed: { name: string; box: BoundingBox; ships: number }[] }> {
  const seen = new Set<string>();
  const tilesUsed: { name: string; box: BoundingBox; ships: number }[] = [];
  const regionTiles = TILES.filter((t) => t.region === region);

  for (const tile of regionTiles) {
    if (seen.size >= target) break;
    if (!vf.scanArea) throw new Error("VesselFinder scanArea missing");
    try {
      const rows = await vf.scanArea(tile.box);
      let n = 0;
      for (const row of rows) {
        const mmsi = row.position?.mmsi ?? row.identity?.mmsi ?? null;
        if (!mmsi || !/^\d{9}$/.test(mmsi)) continue;
        if (seen.has(mmsi)) continue;
        seen.add(mmsi);
        n += 1;
        if (seen.size >= target) break;
      }
      tilesUsed.push({ name: tile.name, box: tile.box, ships: n });
      console.log(`[discover ${region}] ${tile.name} +${n} unique total=${seen.size}`);
    } catch (err) {
      console.log(`[discover ${region}] ${tile.name} ERROR ${(err as Error).message}`);
      tilesUsed.push({ name: tile.name, box: tile.box, ships: 0 });
    }
    await sleep(tileDelayMs);
  }
  return { mmsis: Array.from(seen).slice(0, target), tilesUsed };
}

async function probeProvider(
  provider: VesselDataProvider,
  providerKey: ProviderKey,
  mmsi: string,
  region: Region,
  vfHtml: VesselFinderHtmlSource | null
): Promise<MotionRow> {
  const t0 = Date.now();
  const base: MotionRow = {
    mmsi,
    region,
    provider: providerKey,
    ok: false,
    httpClass: "error",
    latencyMs: 0,
    speedKn: null,
    courseDeg: null,
    navStatusCode: null,
    navStatusText: null,
    observedAt: null,
    timestampDerivation: "NO_SOURCE_TIME",
    ageMinutes: null,
    surface:
      providerKey === "vesselfinder"
        ? "HTML detail #djson ship_sog/ship_cog + Navigation Status + lrpd"
        : providerKey === "shipfinder"
          ? "HTML /ship/detail/mmsi/{mmsi} speed/course/status/Last update"
          : "HTML embedded JSON points speed/course/timestamp",
  };

  try {
    const id = mmsiIdentifier(mmsi);
    // Prefer getPosition; fall back to getDetails.position
    let pos =
      provider.getPosition !== undefined ? (await provider.getPosition(id))?.position ?? null : null;
    if (!pos && provider.getDetails) {
      const d = await provider.getDetails(id);
      pos = d?.position ?? null;
    }
    base.latencyMs = Date.now() - t0;

    if (!pos) {
      base.httpClass = "null";
      base.error = "provider returned null (not found or no position)";
      return base;
    }

    base.ok = true;
    base.httpClass = "200";
    base.speedKn = isValidSpeed(pos.speed) ? pos.speed : null;
    base.courseDeg = isValidCourse(pos.course) ? pos.course : null;
    base.navStatusText = pos.navStatus?.text ?? null;
    base.navStatusCode = mapNavCode(pos.navStatus?.text, pos.navStatus?.code ?? null);

    const srcAt = pos.metadata?.sourceReceivedAt ?? null;
    const fetchedAt = pos.metadata?.fetchedAt ?? new Date();

    if (srcAt instanceof Date && Number.isFinite(srcAt.getTime())) {
      base.observedAt = srcAt.toISOString();
      base.timestampDerivation = "ABSOLUTE_SOURCE_TIME";
      base.ageMinutes = Math.round((fetchedAt.getTime() - srcAt.getTime()) / 60_000);
    } else if (providerKey === "vesselfinder" && vfHtml) {
      // Diagnostic only: production provider refuses lrpd as sourceReceivedAt.
      // Measure whether relative age EXISTS on the HTML surface.
      try {
        const raw = await vfHtml.getDetails(mmsi);
        const ageMs = parseVesselFinderRelativeAgeMs(raw.position.positionTime);
        if (ageMs !== null) {
          const obs = new Date(fetchedAt.getTime() - ageMs);
          base.observedAt = obs.toISOString();
          base.timestampDerivation = "RELATIVE_SOURCE_AGE";
          base.ageMinutes = Math.round(ageMs / 60_000);
          // speed/course already from provider; if missing, fill from raw
          if (base.speedKn === null && isValidSpeed(raw.position.speedKn)) base.speedKn = raw.position.speedKn;
          if (base.courseDeg === null && isValidCourse(raw.position.courseDeg))
            base.courseDeg = raw.position.courseDeg;
          if (base.navStatusText === null && raw.position.navStatusText && raw.position.navStatusText !== "Unknown") {
            base.navStatusText = raw.position.navStatusText;
            base.navStatusCode = mapNavCode(raw.position.navStatusText, raw.position.navStatusCode);
          }
        } else {
          base.timestampDerivation = "NO_SOURCE_TIME";
        }
      } catch {
        base.timestampDerivation = "NO_SOURCE_TIME";
      }
    } else {
      // Do NOT treat position.receivedAt (= fetch clock) as source observation time.
      base.timestampDerivation = "NO_SOURCE_TIME";
      base.observedAt = null;
    }

    return base;
  } catch (err) {
    base.latencyMs = Date.now() - t0;
    base.httpClass = classifyHttp(err);
    base.error = (err as Error).message?.slice(0, 240);
    return base;
  }
}

type FieldStats = { available: number; sample: number; pct: number };

function fieldStats(rows: MotionRow[], pick: (r: MotionRow) => boolean): FieldStats {
  const sample = rows.length;
  const available = rows.filter(pick).length;
  return { available, sample, pct: pct(available, sample) };
}

function freshnessBuckets(rows: MotionRow[]): Record<string, number> {
  const b = {
    "<=5min": 0,
    "5-15min": 0,
    "15-30min": 0,
    "30-60min": 0,
    ">60min": 0,
    unknown: 0,
  };
  for (const r of rows) {
    if (r.ageMinutes === null || r.timestampDerivation === "NO_SOURCE_TIME") {
      b.unknown += 1;
      continue;
    }
    const a = r.ageMinutes;
    if (a <= 5) b["<=5min"] += 1;
    else if (a <= 15) b["5-15min"] += 1;
    else if (a <= 30) b["15-30min"] += 1;
    else if (a <= 60) b["30-60min"] += 1;
    else b[">60min"] += 1;
  }
  return b;
}

function matrixBlock(rows: MotionRow[]): Record<string, FieldStats> {
  return {
    speedKn: fieldStats(rows, (r) => r.speedKn !== null),
    courseDeg: fieldStats(rows, (r) => r.courseDeg !== null),
    navStatusCode: fieldStats(rows, (r) => r.navStatusCode !== null),
    observedAt: fieldStats(rows, (r) => r.observedAt !== null && r.timestampDerivation !== "NO_SOURCE_TIME"),
  };
}

function combinedByMmsi(rows: MotionRow[]): MotionRow[] {
  const by = new Map<string, MotionRow[]>();
  for (const r of rows) {
    const k = `${r.region}:${r.mmsi}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(r);
  }
  const out: MotionRow[] = [];
  for (const group of Array.from(by.values())) {
    const first = group[0];
    const pick = (fn: (r: MotionRow) => number | string | null): number | string | null => {
      for (const g of group) {
        const v = fn(g);
        if (v !== null && v !== undefined && v !== "") return v;
      }
      return null;
    };
    const speedKn = pick((r) => r.speedKn) as number | null;
    const courseDeg = pick((r) => r.courseDeg) as number | null;
    const navStatusCode = pick((r) => r.navStatusCode) as number | null;
    let observedAt: string | null = null;
    let derivation: TimestampDerivation = "NO_SOURCE_TIME";
    let ageMinutes: number | null = null;
    for (const order of ["ABSOLUTE_SOURCE_TIME", "RELATIVE_SOURCE_AGE"] as TimestampDerivation[]) {
      const hit = group.find((r) => r.timestampDerivation === order && r.observedAt);
      if (hit) {
        observedAt = hit.observedAt;
        derivation = hit.timestampDerivation;
        ageMinutes = hit.ageMinutes;
        break;
      }
    }
    out.push({
      mmsi: first.mmsi,
      region: first.region,
      provider: "combined" as ProviderKey,
      ok: group.some((g) => g.ok),
      httpClass: "combined",
      latencyMs: 0,
      speedKn,
      courseDeg,
      navStatusCode,
      navStatusText: (pick((r) => r.navStatusText) as string | null) ?? null,
      observedAt,
      timestampDerivation: derivation,
      ageMinutes,
      surface: "union of free providers",
    });
  }
  return out;
}

function classifyProvider(cov: Record<string, FieldStats>, blocks: number, reqPerVessel: number): string {
  const motionAvg =
    (cov.speedKn.pct + cov.courseDeg.pct + cov.navStatusCode.pct + cov.observedAt.pct) / 4;
  if (blocks > 5) return "NOT_PRACTICAL";
  if (motionAvg < 5) return "NOT_AVAILABLE";
  if (motionAvg >= 60 && reqPerVessel <= 1.2 && blocks === 0) return "GOOD";
  if (motionAvg >= 25) return "USABLE";
  if (motionAvg > 5 && reqPerVessel > 1) return "NOT_PRACTICAL";
  return "USABLE";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stage = (flag(args, "stage") ?? "A").toUpperCase();
  const perRegion = stage === "B" ? flagInt(args, "n", 100) : flagInt(args, "n", 30);
  const delayMs = flagInt(args, "delay-ms", 2500);
  const tileDelayMs = flagInt(args, "tile-delay-ms", 3000);
  const globalConcurrency = flagInt(args, "concurrency", 2);
  const providerFilter = (flag(args, "providers") ?? "vesselfinder,shipfinder,shipinfo")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) as ProviderKey[];

  // Hard isolation: no AIS/paid (do not read those flags for motion path).
  const container = await buildContainer({ connectMongo: false });
  const registry = container.providerRegistry;
  const vf = registry.get(VesselSource.VESSELFINDER);
  const sf = registry.get(VesselSource.SHIPFINDER);
  const si = registry.get(VesselSource.SHIPINFO);
  if (!vf || !sf || !si) throw new Error("Missing free providers in registry");

  const vfHtml = new VesselFinderHtmlSource(new HttpClient({ timeoutMs: 12_000 }));

  console.log("\n========== FREE MOTION PROOF ==========");
  console.log(`stage=${stage} perRegion=${perRegion} delayMs=${delayMs} concurrency=${globalConcurrency}`);
  console.log("providers=vesselfinder,shipfinder,shipinfo | AIS=OFF | paid=OFF | no canonical write");
  console.log("=======================================\n");

  const discovery: Record<Region, { mmsis: string[]; tilesUsed: unknown[] }> = {
    US: { mmsis: [], tilesUsed: [] },
    UK: { mmsis: [], tilesUsed: [] },
    NORWAY: { mmsis: [], tilesUsed: [] },
  };

  for (const region of ["US", "UK", "NORWAY"] as Region[]) {
    discovery[region] = await discoverRegion(vf, region, perRegion, tileDelayMs);
    console.log(`[discover ${region}] final sample=${discovery[region].mmsis.length}`);
  }

  type Job = { region: Region; mmsi: string; provider: ProviderKey; p: VesselDataProvider };
  const providerMap: Record<ProviderKey, VesselDataProvider> = {
    vesselfinder: vf,
    shipfinder: sf,
    shipinfo: si,
  };
  const jobs: Job[] = [];
  for (const region of ["US", "UK", "NORWAY"] as Region[]) {
    for (const mmsi of discovery[region].mmsis) {
      for (const pk of providerFilter) {
        if (!providerMap[pk]) continue;
        jobs.push({ region, mmsi, provider: pk, p: providerMap[pk] });
      }
    }
  }
  console.log(`providers active: ${providerFilter.join(",")}`);

  const rows: MotionRow[] = [];
  let idx = 0;
  const blockCount: Record<ProviderKey, number> = { vesselfinder: 0, shipfinder: 0, shipinfo: 0 };
  const stopProvider: Record<ProviderKey, boolean> = {
    vesselfinder: false,
    shipfinder: false,
    shipinfo: false,
  };

  async function worker(): Promise<void> {
    while (idx < jobs.length) {
      const i = idx++;
      const job = jobs[i];
      if (stopProvider[job.provider]) {
        rows.push({
          mmsi: job.mmsi,
          region: job.region,
          provider: job.provider,
          ok: false,
          httpClass: "skipped_block",
          latencyMs: 0,
          speedKn: null,
          courseDeg: null,
          navStatusCode: null,
          navStatusText: null,
          observedAt: null,
          timestampDerivation: "NO_SOURCE_TIME",
          ageMinutes: null,
          error: "provider stopped after severe block",
          surface: "skipped",
        });
        continue;
      }
      const row = await probeProvider(job.p, job.provider, job.mmsi, job.region, job.provider === "vesselfinder" ? vfHtml : null);
      rows.push(row);
      if (row.httpClass === "403" || row.httpClass === "429" || row.httpClass === "challenge") {
        blockCount[job.provider] += 1;
        console.log(`[block] ${job.provider} ${row.httpClass} count=${blockCount[job.provider]}`);
        if (blockCount[job.provider] >= 5) {
          stopProvider[job.provider] = true;
          console.log(`[stop] ${job.provider} severe blocking — remaining skipped`);
        } else {
          await sleep(60_000);
        }
      }
      console.log(
        `[${row.provider}] ${row.region} ${row.mmsi} ${row.httpClass} ` +
          `sog=${row.speedKn ?? "—"} cog=${row.courseDeg ?? "—"} nav=${row.navStatusCode ?? "—"} ` +
          `ts=${row.timestampDerivation} ${row.latencyMs}ms`
      );
      await sleep(delayMs);
    }
  }

  const tRun0 = Date.now();
  await Promise.all(Array.from({ length: Math.max(1, globalConcurrency) }, () => worker()));
  const durationMs = Date.now() - tRun0;

  const providers: ProviderKey[] = ["vesselfinder", "shipfinder", "shipinfo"];
  const regions: Region[] = ["US", "UK", "NORWAY"];

  const motionMatrix: Record<string, Record<string, Record<string, FieldStats>>> = {};
  for (const region of regions) {
    motionMatrix[region] = {};
    for (const provider of providers) {
      const subset = rows.filter((r) => r.region === region && r.provider === provider);
      motionMatrix[region][provider] = matrixBlock(subset);
    }
    const comb = combinedByMmsi(rows.filter((r) => r.region === region));
    motionMatrix[region].combined = matrixBlock(comb);
  }
  motionMatrix.ALL = {};
  for (const provider of [...providers, "combined" as const]) {
    const subset =
      provider === "combined"
        ? combinedByMmsi(rows)
        : rows.filter((r) => r.provider === provider);
    motionMatrix.ALL[provider] = matrixBlock(subset);
  }

  const operational: Record<string, unknown> = {};
  for (const provider of providers) {
    const subset = rows.filter((r) => r.provider === provider);
    const latencies = subset.map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
    const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
    const http: Record<string, number> = {};
    for (const r of subset) http[r.httpClass] = (http[r.httpClass] ?? 0) + 1;
    const vessels = new Set(subset.map((r) => r.mmsi)).size || 1;
    operational[provider] = {
      requests: subset.length,
      reqPerVessel: Math.round((subset.length / vessels) * 100) / 100,
      avgLatencyMs: avg,
      p95LatencyMs: percentile(latencies, 95),
      http,
      blocks403: http["403"] ?? 0,
      blocks429: http["429"] ?? 0,
      timeouts: http.timeout ?? 0,
      classification: classifyProvider(
        matrixBlock(subset),
        (http["403"] ?? 0) + (http["429"] ?? 0) + (http.challenge ?? 0),
        subset.length / vessels
      ),
    };
  }

  const discoveryRequests = TILES.length; // upper bound attempted
  const actualDiscoveryTiles = regions.reduce((n, r) => n + discovery[r].tilesUsed.length, 0);
  const totalVessels = regions.reduce((n, r) => n + discovery[r].mmsis.length, 0);
  const enrichmentRequests = rows.filter((r) => r.httpClass !== "skipped_block").length;
  const extraRequestsPerVessel =
    totalVessels > 0 ? Math.round((enrichmentRequests / totalVessels) * 100) / 100 : 0;

  const minutes = durationMs / 60_000;
  const usableCombined = combinedByMmsi(rows).filter(
    (r) => r.speedKn !== null || r.courseDeg !== null || r.navStatusCode !== null
  ).length;
  const throughput = {
    durationMs,
    enrichmentRequestsPerMin: minutes > 0 ? Math.round((enrichmentRequests / minutes) * 10) / 10 : 0,
    usableMotionVesselsPerMin: minutes > 0 ? Math.round((usableCombined / minutes) * 10) / 10 : 0,
    estimateMinutes: {
      vessels1000: minutes > 0 ? Math.round((1000 / Math.max(usableCombined / minutes, 0.01)) * 10) / 10 : null,
      vessels10000: minutes > 0 ? Math.round((10000 / Math.max(usableCombined / minutes, 0.01)) * 10) / 10 : null,
      vessels50000: minutes > 0 ? Math.round((50000 / Math.max(usableCombined / minutes, 0.01)) * 10) / 10 : null,
    },
  };

  // Freshness overall + per provider
  const freshness = {
    ALL: freshnessBuckets(rows.filter((r) => r.ok)),
    vesselfinder: freshnessBuckets(rows.filter((r) => r.provider === "vesselfinder")),
    shipfinder: freshnessBuckets(rows.filter((r) => r.provider === "shipfinder")),
    shipinfo: freshnessBuckets(rows.filter((r) => r.provider === "shipinfo")),
  };

  const derivation = {
    ABSOLUTE_SOURCE_TIME: rows.filter((r) => r.timestampDerivation === "ABSOLUTE_SOURCE_TIME").length,
    RELATIVE_SOURCE_AGE: rows.filter((r) => r.timestampDerivation === "RELATIVE_SOURCE_AGE").length,
    NO_SOURCE_TIME: rows.filter((r) => r.timestampDerivation === "NO_SOURCE_TIME").length,
  };

  // Manual validation samples: up to 5/region with any motion
  const samples: MotionRow[] = [];
  for (const region of regions) {
    const hits = rows.filter(
      (r) =>
        r.region === region &&
        r.ok &&
        (r.speedKn !== null || r.courseDeg !== null || r.navStatusCode !== null)
    );
    samples.push(...hits.slice(0, 5));
  }

  // Manual validation subset: 10 per provider where motion found
  const manual: Record<string, MotionRow[]> = {};
  for (const provider of providers) {
    manual[provider] = rows
      .filter(
        (r) =>
          r.provider === provider &&
          r.ok &&
          (r.speedKn !== null || r.courseDeg !== null || r.navStatusCode !== null || r.observedAt !== null)
      )
      .slice(0, 10);
  }

  const combAll = combinedByMmsi(rows);
  const vesselBasicsImpact = {
    note: "Free-only estimate from THIS motion sample + known map discovery strengths. No AIS/paid.",
    discoveryMapKnown: {
      vesselName: "~98% on VF map tiles (prior proof)",
      mmsi: "100% (discovery key)",
      latLon: "100% on VF map tiles",
      imo: "low on map; partial on detail",
      vType: "partial on detail",
    },
    motionCombinedPct: {
      speedKn: matrixBlock(combAll).speedKn.pct,
      courseDeg: matrixBlock(combAll).courseDeg.pct,
      navStatusCode: matrixBlock(combAll).navStatusCode.pct,
      received: matrixBlock(combAll).observedAt.pct,
    },
    estimatedVesselBasicsFreeOnly: {
      vesselName: "high (map)",
      mmsi: "100%",
      imo: "low–moderate (detail dependent)",
      vType: "moderate (detail)",
      latLon: "high (map)",
      speed: `${matrixBlock(combAll).speedKn.pct}% (targeted free detail)`,
      course: `${matrixBlock(combAll).courseDeg.pct}% (targeted free detail)`,
      navStatus: `${matrixBlock(combAll).navStatusCode.pct}% (targeted free detail)`,
      received: `${matrixBlock(combAll).observedAt.pct}% (source time only)`,
    },
  };

  // Decision
  const c = matrixBlock(combAll);
  const blockTotal =
    ((operational.vesselfinder as any).blocks403 ?? 0) +
    ((operational.vesselfinder as any).blocks429 ?? 0) +
    ((operational.shipfinder as any).blocks403 ?? 0) +
    ((operational.shipfinder as any).blocks429 ?? 0) +
    ((operational.shipinfo as any).blocks403 ?? 0) +
    ((operational.shipinfo as any).blocks429 ?? 0);

  let recommendation: "A" | "B" | "C";
  let recommendationText: string;
  const motionCore = (c.speedKn.pct + c.courseDeg.pct) / 2;
  if (motionCore >= 70 && c.observedAt.pct >= 50 && extraRequestsPerVessel <= 3 && blockTotal < 10) {
    recommendation = "A";
    recommendationText = "FREE CRAWLER SUFFICIENT FOR MOTION";
  } else if (motionCore >= 25 || c.speedKn.pct >= 30 || c.courseDeg.pct >= 30) {
    recommendation = "B";
    recommendationText = "FREE CRAWLER PARTIALLY SUFFICIENT, AIS LIKELY NEEDED FOR GAPS";
  } else {
    recommendation = "C";
    recommendationText = "FREE CRAWLER NOT PRACTICAL FOR MOTION, AIS SHOULD OWN MOTION DATA";
  }

  // Amplification note: discovery is cheap (1 tile many ships); motion is 1 req/provider/vessel
  const amplification = {
    discoveryTilesUsed: actualDiscoveryTiles,
    discoveryTileBudget: discoveryRequests,
    vesselsDiscovered: totalVessels,
    enrichmentRequests,
    extraRequestsPerVessel,
    note:
      "Map tile: 1 HTTP → many vessels (identity+lat/lon only). " +
      "Motion requires separate detail GET per vessel per provider. " +
      `Measured enrichment ≈ ${extraRequestsPerVessel} requests/vessel across 3 providers.`,
  };

  const report = {
    meta: {
      phase: "FREE-MOTION-PROOF",
      stage,
      commit: process.env.GIT_COMMIT ?? "local",
      startedAt: new Date(tRun0).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs,
      ais: false,
      paid: false,
      marineApi: false,
      canonicalWrite: false,
    },
    sampleSize: {
      US: discovery.US.mmsis.length,
      UK: discovery.UK.mmsis.length,
      NORWAY: discovery.NORWAY.mmsis.length,
      totalVessels,
      enrichmentAttempts: rows.length,
    },
    regions: discovery,
    surfaces: {
      vesselfinder: [
        "map mp2 tiles — discovery only (no speed/course/nav/time)",
        "HTML /vessels/details/{id} #djson ship_sog/ship_cog, table Navigation Status, lrpd relative age",
      ],
      shipfinder: ["HTML https://www.shipfinder.com/ship/detail/mmsi/{mmsi} speed/course/status/Last update"],
      shipinfo: ["HTML vessel page embedded JSON track points speed/course/timestamp"],
    },
    motionMatrix,
    timestampDerivation: derivation,
    freshness,
    operational,
    amplification,
    throughput,
    vesselBasicsImpact,
    samples,
    manualValidationCandidates: manual,
    manualValidationNote:
      "Automated extraction via existing providers. Manual spot-check: compare samples[] fields to live provider pages. " +
      "VF lrpd counted as RELATIVE_SOURCE_AGE only in diagnostic path (production mapping still sets sourceReceivedAt=null).",
    recommendation: { code: recommendation, text: recommendationText },
    missingFieldsSummary: {
      mapTilesAlone: ["speedKn", "courseDeg", "navStatusCode", "observedAt"],
      afterTargetedFreeDetail: {
        stillWeak: Object.entries(c)
          .filter(([, v]) => v.pct < 40)
          .map(([k]) => k),
        stronger: Object.entries(c)
          .filter(([, v]) => v.pct >= 40)
          .map(([k]) => k),
      },
    },
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const dir = path.join(process.cwd(), "docs", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `free-motion-proof-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push(`# FREE-MOTION-PROOF ${stage}`);
  md.push("");
  md.push(`- Duration: ${durationMs} ms`);
  md.push(`- Sample: US=${discovery.US.mmsis.length} UK=${discovery.UK.mmsis.length} NO=${discovery.NORWAY.mmsis.length}`);
  md.push(`- Recommendation: **${recommendation}** — ${recommendationText}`);
  md.push("");
  md.push("## Motion matrix (pct)");
  md.push("");
  md.push("| Region | Provider | speedKn | courseDeg | navStatusCode | observedAt |");
  md.push("|---|---|---:|---:|---:|---:|");
  for (const region of [...regions, "ALL" as const]) {
    for (const provider of ["vesselfinder", "shipfinder", "shipinfo", "combined"]) {
      const block = (report.motionMatrix as any)[region]?.[provider];
      if (!block) continue;
      md.push(
        `| ${region} | ${provider} | ${block.speedKn.pct}% | ${block.courseDeg.pct}% | ${block.navStatusCode.pct}% | ${block.observedAt.pct}% |`
      );
    }
  }
  md.push("");
  md.push("## Operational");
  md.push("```json");
  md.push(JSON.stringify(operational, null, 2));
  md.push("```");
  md.push("");
  md.push("## Amplification");
  md.push("```json");
  md.push(JSON.stringify(amplification, null, 2));
  md.push("```");
  md.push("");
  md.push("## Freshness");
  md.push("```json");
  md.push(JSON.stringify(freshness, null, 2));
  md.push("```");
  md.push("");
  md.push("## Samples (sanitized)");
  for (const s of samples.slice(0, 15)) {
    md.push(
      `- ${s.region} ${s.provider} ${s.mmsi} sog=${s.speedKn} cog=${s.courseDeg} nav=${s.navStatusCode} ts=${s.timestampDerivation} ageMin=${s.ageMinutes}`
    );
  }
  const mdPath = path.join(dir, `free-motion-proof-${stamp}.md`);
  fs.writeFileSync(mdPath, md.join("\n"), "utf8");

  console.log("\n" + md.join("\n"));
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

void main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
