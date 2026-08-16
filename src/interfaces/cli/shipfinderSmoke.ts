// ============================================================================
//  INTERFACE (CLI) · ShipFinder smoke — CHẠY TAY, KHÔNG nằm trong CI
// ----------------------------------------------------------------------------
//  Chạy:  npm run shipfinder:smoke -- --mmsi=636018086
//
//  Kiểm chứng đúng một chuỗi: ShipFinderClient -> HTML thật -> ShipFinderParser
//  -> RAW DTO. KHÔNG canonical, KHÔNG provider, KHÔNG runtime, KHÔNG observation,
//  KHÔNG MongoDB.
//
//  `npm test` chỉ chạy `*.test.ts` nên file này không làm CI phụ thuộc website
//  ngoài — unit test dùng fixture.
//
//  MỘT tàu mỗi lần. Không danh sách, không vòng lặp, không bbox, không scheduler.
// ============================================================================

import { HttpClient } from "../../infrastructure/http/HttpClient";
import { ShipFinderClient } from "../../infrastructure/integrations/shipfinder/ShipFinderClient";
import {
  SHIPFINDER_PARSER_VERSION,
  ShipFinderParseError,
  parseShipFinderHtml,
} from "../../infrastructure/integrations/shipfinder/ShipFinderParser";

function usage(): void {
  console.log("👉 Cách dùng: npm run shipfinder:smoke -- --mmsi=<MMSI>");
  console.log("   Ví dụ:     npm run shipfinder:smoke -- --mmsi=636018086");
  console.log("   Mỗi lần chạy tra ĐÚNG MỘT tàu.");
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2).find((a) => a.startsWith("--mmsi="));
  const mmsi = arg?.slice("--mmsi=".length).trim();
  if (!mmsi) {
    usage();
    process.exit(1);
  }

  const client = new ShipFinderClient({ http: new HttpClient({ timeoutMs: 20_000 }) });

  try {
    // Dựng URL BÊN TRONG try: MMSI sai là lỗi của người dùng, phải in một dòng
    // rõ ràng chứ không đổ stack trace.
    const url = client.buildVesselUrl(mmsi);
    console.log(`🔎 ShipFinder smoke · parser=${SHIPFINDER_PARSER_VERSION}\n   → ${url}\n`);

    const result = parseShipFinderHtml(await client.fetchByMmsi(mmsi));

    if (result.status === "NO_VESSEL_DATA") {
      console.log(`⚪ Không có dữ liệu tàu (${result.reason}) — ${result.detail ?? ""}`);
      process.exit(0);
    }

    const { vessel, fallbackFields } = result.document;
    console.log("✅ RAW DTO (giữ nguyên biểu diễn nguồn, chưa chuẩn hoá):");
    for (const [field, value] of Object.entries(vessel)) {
      console.log(`   ${field.padEnd(12)} = ${JSON.stringify(value)}`);
    }
    if (fallbackFields.length > 0) {
      console.log(
        `\n⚠️  ${fallbackFields.length} field phải dùng đường dự phòng (nhãn/title) ` +
          `thay vì neo id: ${fallbackFields.join(", ")} — trang có thể đang trôi.`
      );
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof ShipFinderParseError) {
      console.error(`❌ PARSE DRIFT tại neo "${err.anchor}": ${err.message}`);
    } else {
      console.error(`❌ ${(err as Error).message}`);
    }
    process.exit(1);
  }
}

void main();
