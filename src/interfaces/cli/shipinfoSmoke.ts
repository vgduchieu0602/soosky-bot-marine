// ============================================================================
//  INTERFACE (CLI) · Smoke test ShipInfo — CHẠY TAY, KHÔNG nằm trong CI
// ----------------------------------------------------------------------------
//  Chạy:  npm run shipinfo:smoke [imo1 imo2 ...]
//
//  Kiểm chứng đúng một chuỗi: ShipInfoClient -> HTML thật -> ShipInfoParser ->
//  raw DTO. KHÔNG canonical, KHÔNG observation, KHÔNG DB.
//
//  `npm test` chỉ chạy `*.test.ts` nên file này KHÔNG làm CI phụ thuộc vào
//  website ngoài — unit test dùng fixture.
//
//  Tối đa 3 tàu, nghỉ 4s giữa mỗi lần. Không bulk crawl, không quét vùng.
// ============================================================================

import { HttpClient } from "../../infrastructure/http/HttpClient";
import { ShipInfoClient } from "../../infrastructure/providers/shipinfo/ShipInfoClient";
import {
  ShipInfoParseError,
  parseShipInfoHtml,
} from "../../infrastructure/providers/shipinfo/ShipInfoParser";

/** Tàu đã dùng trong audit P6.1. */
const DEFAULT_SAMPLE = ["9467976", "8642957"];
const MAX_SAMPLE = 3;
const DELAY_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function report(imo: string, html: string): void {
  const result = parseShipInfoHtml(html);

  if (result.status === "NO_VESSEL_DATA") {
    console.log(`   ⚪ ${imo}  không có dữ liệu tàu (${result.reason}) — ${result.detail ?? ""}`);
    return;
  }

  const { vesselKey, vessel, seoContext } = result.document;
  const points = vessel.points ?? [];
  const last = points[points.length - 1];

  console.log(`   ✅ ${imo}  key=${vesselKey}  ${vessel.name ?? "?"}`);
  console.log(
    `      imo=${vessel.imo} mmsi=${vessel.mmsi} callsign=${vessel.callsign} ` +
      `flag=${vessel.flag}/${vessel.country} year=${vessel.year} dwt=${vessel.dwt}`
  );
  console.log(
    `      length=${vessel.length} width=${vessel.width}  ` +
      `(seo length_m=${seoContext?.length_m} width_m=${seoContext?.width_m})`
  );
  console.log(
    `      points=${points.length}  last: lat=${last?.lat} lng=${last?.lng} ` +
      `speed=${last?.speed} course=${last?.course} heading=${last?.heading}`
  );
  console.log(
    `      updated=${last?.updated}  seo.updated_utc=${seoContext?.updated_utc}  ` +
      `delay_hours=${vessel.fresh_access?.position_delay_hours} locked=${vessel.fresh_access?.fresh_locked}`
  );
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const sample = (requested.length > 0 ? requested : DEFAULT_SAMPLE).slice(0, MAX_SAMPLE);

  const client = new ShipInfoClient({ http: new HttpClient({ timeoutMs: 20_000 }) });
  console.log(`🔎 ShipInfo smoke: ${sample.length} tàu, nghỉ ${DELAY_MS / 1000}s/lần\n`);

  let failures = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const imo = sample[i];
    console.log(`   → ${client.buildVesselUrl({ imo })}`);
    try {
      report(imo, await client.fetchByImo(imo));
    } catch (err) {
      failures += 1;
      const label = err instanceof ShipInfoParseError ? `PARSE[${err.marker}]` : "FETCH";
      console.log(`   ❌ ${imo}  ${label}: ${(err as Error).message}`);
    }
    if (i < sample.length - 1) await sleep(DELAY_MS);
  }

  console.log(failures === 0 ? "\n🟢 Xong." : `\n🔴 ${failures} tàu lỗi.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
