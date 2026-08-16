// ============================================================================
//  INTERFACE (CLI) · Acquisition free POC — MỘT tàu, chạy tay
// ----------------------------------------------------------------------------
//  Chạy:  npm run acquire:free:poc -- --mmsi=636018086 --need=POSITION
//         npm run acquire:free:poc -- --mmsi=636018086 --need=FULL
//         npm run acquire:free:poc -- --mmsi=636018086 --need=PARTICULARS --fields=builtYear
//
//  Đường chạy:
//      canonical_current_vessels  (đọc trước — LOCAL FIRST)
//        -> LocalDataSufficiencyChecker (P9.2)
//        -> FreeSourceSelector (P9.3)
//        -> CollectVesselObservations (P6.4/P7.4)  ->  vessel_observations
//        -> ResolveAndStoreCurrentVessel (P8.5)    ->  canonical_current_vessels
//
//  ⚠️ POC, KHÔNG PHẢI CRAWLER. Một MMSI mỗi lần: không đọc file danh sách,
//  không vòng lặp tàu, không bbox, không scheduler.
//
//  ⛔ KHÔNG nguồn trả tiền · KHÔNG MyShipTracking · KHÔNG AISStream.
//  ⛔ KHÔNG ghi vào vessels / latestpositions / vesselpositions.
// ============================================================================

import { buildContainer } from "../../bootstrap/container";
import { DataNeed, DataNeedType } from "../../application/services/acquisition/DataNeed";
import { AcquisitionStopReason } from "../../application/use-cases/acquisition/AcquireFreeVesselData";
import { isVesselField, VesselField } from "../../domain/enums/VesselField";

function usage(): void {
  console.log("👉 Cách dùng: npm run acquire:free:poc -- --mmsi=<MMSI> --need=<NEED> [--fields=a,b]");
  console.log(`   NEED: ${Object.keys(DataNeedType).join(" | ")}`);
  console.log("   Ví dụ: npm run acquire:free:poc -- --mmsi=636018086 --need=POSITION");
  console.log("   Mỗi lần chạy xử lý ĐÚNG MỘT tàu. Chỉ nguồn miễn phí.");
}

function readFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim();
}

/** `null` = cờ sai; đã in lý do. */
function parseNeed(args: string[]): DataNeed | null {
  const rawNeed = (readFlag(args, "need") ?? "").toUpperCase();
  if (!(rawNeed in DataNeedType)) {
    console.error(`❌ --need không hợp lệ: "${rawNeed || "(trống)"}"`);
    return null;
  }
  const type = DataNeedType[rawNeed as keyof typeof DataNeedType];

  const rawFields = readFlag(args, "fields");
  if (rawFields === undefined || rawFields === "") return { type };

  const fields: VesselField[] = [];
  for (const token of rawFields.split(",").map((part) => part.trim())) {
    if (!isVesselField(token)) {
      console.error(`❌ --fields chứa field không thuộc canonical model: "${token}"`);
      return null;
    }
    fields.push(token);
  }
  return { type, requiredFields: fields };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const mmsi = readFlag(args, "mmsi");
  if (!mmsi) {
    usage();
    process.exit(1);
  }

  const need = parseNeed(args);
  if (need === null) {
    usage();
    process.exit(1);
  }

  const { acquireFreeVesselData, config } = await buildContainer();
  if (!config.mongoUri) {
    console.log("⚠️  Không có MONGODB_URI — mọi thứ chỉ nằm trong RAM rồi mất.");
  }

  console.log(
    `\n🎯 Acquisition FREE · MMSI=${mmsi} · need=${need.type}` +
      (need.requiredFields ? ` · fields=${need.requiredFields.join(",")}` : "") +
      "\n   Local trước; chỉ chạm nguồn khi dữ liệu local chưa đủ.\n"
  );

  try {
    const result = await acquireFreeVesselData.execute({ mmsi }, need);

    if (result.attempts.length === 0) {
      console.log("📗 KHÔNG chạm nguồn nào.");
    } else {
      console.log(`📡 Đã chạm nguồn ${result.attempts.length} lần:`);
      for (const attempt of result.attempts) {
        const detail = attempt.failureCode ? ` (${attempt.failureCode})` : "";
        const fields = attempt.targetFields?.length
          ? `  nhắm: ${attempt.targetFields.join(",")}`
          : "";
        console.log(`   • ${attempt.source} ${attempt.operation} -> ${attempt.outcome}${detail}${fields}`);
      }
    }

    console.log(
      `\n${result.satisfied ? "✅" : "⚠️ "} satisfied=${result.satisfied} · dừng vì ${result.stopReason}`
    );

    if (!result.satisfied) {
      console.log("   Còn thiếu:");
      for (const item of result.sufficiency.missing) {
        console.log(`   • ${item.group ?? "—"}${item.field ? `.${item.field}` : ""}  ${item.reason}`);
      }
      if (result.stopReason === AcquisitionStopReason.NO_FREE_SOURCE_AVAILABLE) {
        console.log("   (Hết nguồn MIỄN PHÍ. P9.4 không có fallback trả tiền.)");
      }
    }

    const vessel = result.vessel;
    if (vessel === null) {
      console.log("\n📭 Chưa có bản canonical nào cho tàu này.");
    } else {
      console.log("\n🧭 Canonical hiện tại (giá trị ← nguồn):");
      console.log(`   name        ${vessel.identity?.name?.value ?? "—"} ← ${vessel.identity?.name?.source ?? "—"}`);
      console.log(`   vesselType  ${vessel.identity?.vesselType?.value ?? "—"} ← ${vessel.identity?.vesselType?.source ?? "—"}`);
      console.log(
        `   position    ${
          vessel.position
            ? `${vessel.position.position.lat.toFixed(5)},${vessel.position.position.lng.toFixed(5)} ` +
              `[${vessel.position.freshness}] ← ${vessel.position.source}`
            : "—"
        }`
      );
      console.log(`   length      ${vessel.particulars?.length?.value ?? "—"} ← ${vessel.particulars?.length?.source ?? "—"}`);
      console.log(`   builtYear   ${vessel.particulars?.builtYear?.value ?? "—"} ← ${vessel.particulars?.builtYear?.source ?? "—"}`);
      console.log(`   destination ${vessel.voyage?.destination?.value ?? "—"} ← ${vessel.voyage?.destination?.source ?? "—"}`);
      console.log(`   resolvedAt  ${vessel.resolvedAt.toISOString()}`);
    }

    process.exit(0);
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    process.exit(1);
  }
}

void main();
