// ============================================================================
//  INTERFACE (CLI) · ShipInfo POC — MỘT tàu, chạy tay, ghi vào vessel_observations
// ----------------------------------------------------------------------------
//  Chạy:  npm run shipinfo:poc -- --imo=9467976
//         npm run shipinfo:poc -- --mmsi=636018086
//         npm run shipinfo:poc -- --imo=9467976 --position   (chỉ lấy vị trí)
//
//  Đường chạy:
//      identifier -> CollectVesselObservations -> ShipInfoProvider (P3)
//                 -> SourceRequestExecutor (P4) -> ObservationRecorder (P5)
//                 -> vessel_observations
//
//  ⚠️ ĐÂY LÀ POC, KHÔNG PHẢI CRAWLER. Cố ý chỉ nhận MỘT định danh mỗi lần:
//  không đọc file danh sách, không vòng lặp, không bbox, không scheduler,
//  không cron. Muốn nhiều tàu thì chạy lại tay, và nhịp nghỉ của P4 vẫn áp dụng.
//
//  KHÔNG ghi vào vessels / latestpositions / vesselpositions — chỉ collection
//  observation.
// ============================================================================

import { buildContainer } from "../../bootstrap/container";
import { ProviderOperation } from "../../application/contracts/providers/VesselDataProvider";
import { CollectStatus } from "../../application/use-cases/CollectVesselObservations";
import {
  SourceRequestError,
  SourceUnavailableError,
} from "../../application/services/crawl-runtime/SourceError";
import {
  VesselIdentifier,
  imoIdentifier,
  mmsiIdentifier,
} from "../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../domain/enums/VesselSource";

function usage(): void {
  console.log("👉 Cách dùng: npm run shipinfo:poc -- --imo=<IMO> | --mmsi=<MMSI> [--position]");
  console.log("   Ví dụ:     npm run shipinfo:poc -- --imo=9467976");
  console.log("              npm run shipinfo:poc -- --mmsi=636018086 --position");
  console.log("   Mỗi lần chạy tra ĐÚNG MỘT tàu.");
}

function readFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length).trim();
}

/** Đúng một định danh. Cả hai hoặc không cái nào -> từ chối. */
function readIdentifier(args: string[]): VesselIdentifier | null {
  const imo = readFlag(args, "imo");
  const mmsi = readFlag(args, "mmsi");

  if (imo && mmsi) {
    console.error("❌ Chỉ truyền MỘT trong --imo hoặc --mmsi.");
    return null;
  }
  if (imo) return imoIdentifier(imo);
  if (mmsi) return mmsiIdentifier(mmsi);
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const identifier = readIdentifier(args);
  if (identifier === null) {
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

  const runtimeConfig = crawlRuntime.getConfig(VesselSource.SHIPINFO);
  console.log(
    `🛰️  ShipInfo POC · ${identifier.type}=${identifier.value} · ${operation}\n` +
      `   runtime: concurrency=${runtimeConfig.maxConcurrency} ` +
      `delay=${runtimeConfig.minDelayMs / 1000}-${runtimeConfig.maxDelayMs / 1000}s ` +
      `timeout=${runtimeConfig.timeoutMs / 1000}s retries=${runtimeConfig.maxRetries}\n`
  );

  try {
    const result = await collectVesselObservations.execute({
      source: VesselSource.SHIPINFO,
      identifier,
      operation,
    });

    if (result.status === CollectStatus.RECORDED) {
      console.log(`✅ Ghi ${result.observations.length} observation:`);
      for (const saved of result.observations) {
        console.log(`   • ${saved.status}  id=${saved.id ?? "—"}  fp=${saved.fingerprint.slice(0, 16)}…`);
      }
    } else {
      console.log(`⚪ ${result.status} — không có observation nào được ghi.`);
    }

    const health = result.health;
    if (health) {
      console.log(
        `\n🩺 Sức khoẻ nguồn: ${health.state}  ok=${health.successCount} ` +
          `notFound=${health.notFoundCount} fail=${health.failureCount} ` +
          `latency≈${Math.round(health.averageLatencyMs)}ms`
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
    console.error(
      `🩺 Sức khoẻ nguồn: ${JSON.stringify(crawlRuntime.getHealth(VesselSource.SHIPINFO).state)}`
    );
    process.exit(1);
  }
}

void main();
