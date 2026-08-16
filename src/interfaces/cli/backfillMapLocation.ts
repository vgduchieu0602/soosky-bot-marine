// ============================================================================
//  INTERFACE (CLI) · Bù `location` cho canonical đã có — CHẠY TAY, CÓ TRẦN
// ----------------------------------------------------------------------------
//  Chạy:  npm run map:backfill-location                    (DRY-RUN, mặc định)
//         npm run map:backfill-location -- --confirm
//         npm run map:backfill-location -- --confirm --batch-size=1000 --limit=50000
//
//  ⛔ KHÔNG BAO GIỜ tự chạy. Không service nào, không lệnh khởi động nào gọi nó.
//     Migration tự động lúc boot trên một collection hàng triệu document là cách
//     chắc chắn nhất để một lần deploy bình thường biến thành sự cố.
//
//  Document ghi TỪ MAP-1 trở đi đã có `location` sẵn — script này chỉ dành cho
//  dữ liệu có TRƯỚC đó.
// ============================================================================

import { config } from "../../config";
import { isValidCoordinates } from "../../domain/validators/geo";
import { connectMongo } from "../../infrastructure/persistence/mongo/connection";
import { CurrentVesselModel } from "../../infrastructure/persistence/mongo/currentVesselModel";

const DEFAULTS = { batchSize: 500, limit: 0 };

function readNumberFlag(args: string[], name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim();
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`❌ --${name} phải là số không âm, nhận "${raw}".`);
    process.exit(1);
  }
  return Math.floor(value);
}

/** Che credential — URI có thể mang user/password. */
function safeUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "(không phân tích được URI)";
  }
}

interface Row {
  _id: unknown;
  position?: { position?: { lat?: unknown; lng?: unknown } } | null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes("--confirm");
  const batchSize = Math.max(1, readNumberFlag(args, "batch-size", DEFAULTS.batchSize));
  const limit = readNumberFlag(args, "limit", DEFAULTS.limit);

  if (config.mongoUri === "") {
    console.error("❌ Chưa đặt MONGODB_URI.");
    process.exit(1);
  }

  await connectMongo(config.mongoUri);
  console.log(
    `\n🗺️  Bù location cho canonical_current_vessels\n` +
      `   target=${safeUri(config.mongoUri)}\n` +
      `   chế độ=${write ? "GHI THẬT (--confirm)" : "DRY-RUN (mặc định — chưa ghi gì)"}\n` +
      `   mẻ=${batchSize}${limit > 0 ? ` trần=${limit}` : ""}\n`
  );

  let scanned = 0;
  let eligible = 0;
  let updated = 0;
  let skippedInvalid = 0;
  let skippedMissingPosition = 0;

  // Chỉ quét document THIẾU `location` — đã bù rồi thì không đụng lại.
  const cursor = CurrentVesselModel.find({ location: { $exists: false } })
    .select({ _id: 1, "position.position.lat": 1, "position.position.lng": 1 })
    .lean<Row>()
    .cursor();

  let operations: Array<Record<string, unknown>> = [];

  const flush = async (): Promise<void> => {
    if (operations.length === 0) return;
    // bulkWrite: một round-trip cho cả mẻ. Vòng lặp update từng document trên
    // collection lớn là hàng giờ round-trip thuần tuý.
    if (write) await CurrentVesselModel.bulkWrite(operations as never[], { ordered: false });
    updated += operations.length;
    operations = [];
  };

  for await (const row of cursor as unknown as AsyncIterable<Row>) {
    scanned += 1;

    const report = row.position?.position;
    if (report === undefined || report === null) {
      skippedMissingPosition += 1;
    } else if (!isValidCoordinates(report.lat, report.lng)) {
      // Toạ độ rác -> KHÔNG dựng Point. Mongo sẽ từ chối khoá geo và làm hỏng
      // cả mẻ; hơn nữa một toạ độ sai trên map tệ hơn một tàu không hiện.
      skippedInvalid += 1;
    } else {
      eligible += 1;
      operations.push({
        updateOne: {
          filter: { _id: row._id },
          update: {
            $set: {
              location: {
                type: "Point",
                // ⚠️ [kinh độ, vĩ độ] — đảo là tàu nhảy sang bán cầu khác.
                coordinates: [report.lng as number, report.lat as number],
              },
            },
          },
        },
      });
      if (operations.length >= batchSize) await flush();
    }

    if (limit > 0 && scanned >= limit) break;
  }
  await flush();

  console.log("📊 Kết quả");
  console.log(`   quét               : ${scanned.toLocaleString("en-US")}`);
  console.log(`   đủ điều kiện       : ${eligible.toLocaleString("en-US")}`);
  console.log(`   đã ghi             : ${write ? updated.toLocaleString("en-US") : "0 (dry-run)"}`);
  console.log(`   bỏ · toạ độ hỏng   : ${skippedInvalid.toLocaleString("en-US")}`);
  console.log(`   bỏ · chưa có vị trí: ${skippedMissingPosition.toLocaleString("en-US")}`);
  if (!write && eligible > 0) {
    console.log(`\n💡 Thêm --confirm để ghi thật ${eligible.toLocaleString("en-US")} document.`);
  }

  process.exit(0);
}

void main().catch((error) => {
  console.error(`❌ ${(error as Error).message}`);
  process.exit(1);
});
