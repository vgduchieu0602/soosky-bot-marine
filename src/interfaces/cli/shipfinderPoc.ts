// ============================================================================
//  INTERFACE (CLI) · ShipFinder POC — MỘT tàu, chạy tay, ghi vessel_observations
// ----------------------------------------------------------------------------
//  Chạy:  npm run shipfinder:poc -- --mmsi=636018086
//         npm run shipfinder:poc -- --mmsi=636018086 --position
//
//  Đường chạy:
//      MMSI -> CollectVesselObservations -> ShipFinderProvider (P3)
//           -> SourceRequestExecutor (P4) -> ObservationRecorder (P5)
//           -> vessel_observations
//
//  ⚠️ POC, KHÔNG PHẢI CRAWLER. Cố ý chỉ nhận MỘT MMSI mỗi lần: không đọc file
//  danh sách, không vòng lặp, không sitemap, không bbox, không scheduler.
//
//  ⛔ Không có cờ --imo: ShipFinder không có đường tra theo IMO (P7.1).
//  KHÔNG ghi vào vessels / latestpositions / vesselpositions.
// ============================================================================

import { buildContainer } from "../../bootstrap/container";
import { ProviderOperation } from "../../application/contracts/providers/VesselDataProvider";
import { CollectStatus } from "../../application/use-cases/observation/CollectVesselObservations";
import {
  SourceRequestError,
  SourceUnavailableError,
} from "../../application/services/crawl-runtime/SourceError";
import { mmsiIdentifier } from "../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../domain/enums/VesselSource";

function usage(): void {
  console.log("👉 Cách dùng: npm run shipfinder:poc -- --mmsi=<MMSI> [--position]");
  console.log("   Ví dụ:     npm run shipfinder:poc -- --mmsi=636018086");
  console.log("   Mỗi lần chạy tra ĐÚNG MỘT tàu.");
  console.log("   ⛔ Không có --imo: ShipFinder chỉ tra được bằng MMSI.");
}

function readFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (readFlag(args, "imo") !== undefined) {
    console.error("❌ ShipFinder không hỗ trợ tra theo IMO — chỉ MMSI.");
    usage();
    process.exit(1);
  }

  const mmsi = readFlag(args, "mmsi");
  if (!mmsi) {
    usage();
    process.exit(1);
  }

  const operation = args.includes("--position")
    ? ProviderOperation.GET_POSITION
    : ProviderOperation.GET_DETAILS;

  const { collectVesselObservations, config, crawlRuntime } = await buildContainer();
  if (!config.mongoUri) {
    console.log("⚠️  Không có MONGODB_URI — observation sẽ chỉ nằm trong RAM rồi mất.");
  }

  const offset = config.shipFinderSourceUtcOffsetMinutes;
  if (offset === undefined) {
    console.log(
      "⚠️  Chưa đặt SHIPFINDER_SOURCE_UTC_OFFSET_MINUTES — ShipFinder sẽ KHÔNG phát\n" +
        "    nhóm POSITION (identity/particulars/voyage vẫn ghi). Nguồn không khai\n" +
        "    múi giờ; đặt 480 (UTC+8) là GIẢ ĐỊNH VẬN HÀNH theo bằng chứng P7.1."
    );
  } else {
    console.log(`ℹ️  Múi giờ nguồn: UTC${offset >= 0 ? "+" : ""}${offset / 60}h (giả định vận hành).`);
  }

  const runtimeConfig = crawlRuntime.getConfig(VesselSource.SHIPFINDER);
  console.log(
    `\n🛰️  ShipFinder POC · MMSI=${mmsi} · ${operation}\n` +
      `   runtime: concurrency=${runtimeConfig.maxConcurrency} ` +
      `delay=${runtimeConfig.minDelayMs / 1000}-${runtimeConfig.maxDelayMs / 1000}s ` +
      `timeout=${runtimeConfig.timeoutMs / 1000}s retries=${runtimeConfig.maxRetries}\n`
  );

  try {
    const result = await collectVesselObservations.execute({
      source: VesselSource.SHIPFINDER,
      identifier: mmsiIdentifier(mmsi),
      operation,
    });

    if (result.status === CollectStatus.RECORDED) {
      console.log(`✅ Ghi ${result.observations.length} observation:`);
      for (const saved of result.observations) {
        console.log(
          `   • ${saved.status}  id=${saved.id ?? "—"}  fp=${saved.fingerprint.slice(0, 16)}…`
        );
      }
    } else {
      console.log(`⚪ ${result.status} — không có observation nào được ghi.`);
    }

    if (result.health) {
      console.log(
        `\n🩺 Sức khoẻ nguồn: ${result.health.state}  ok=${result.health.successCount} ` +
          `notFound=${result.health.notFoundCount} fail=${result.health.failureCount} ` +
          `latency≈${Math.round(result.health.averageLatencyMs)}ms`
      );
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof SourceUnavailableError) {
      console.error(`🧊 ${err.code}: ${err.message}`);
    } else if (err instanceof SourceRequestError) {
      console.error(`❌ [${err.category}] sau ${err.attempts} lần thử: ${err.message}`);
    } else {
      console.error(`❌ ${(err as Error).message}`);
    }
    process.exit(1);
  }
}

void main();
