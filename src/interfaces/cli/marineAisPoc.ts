// ============================================================================
//  INTERFACE (CLI) · Marine AIS bridge POC — chạy TAY, có giới hạn, không ghi DB
// ----------------------------------------------------------------------------
//  Chạy:  npm run marine-ais:poc
//         npm run marine-ais:poc -- --max-messages=50 --max-seconds=30
//         npm run marine-ais:poc -- --samples=5
//
//  Đường chạy:
//      MARINE_AIS_WS_URL -> MarineAisWebSocketClient -> mapper (AIS-1)
//                        -> in vài sample + bảng đếm -> tự dừng
//
//  ⚠️ POC, KHÔNG PHẢI SERVICE:
//     • KHÔNG ghi Mongo, không ObservationRecorder, không resolver.
//     • KHÔNG chạy vô hạn — luôn có trần message VÀ trần thời gian.
//     • KHÔNG in mọi frame: stream toàn cầu vài nghìn frame/giây.
// ============================================================================

import { config } from "../../config";
import {
  MarineAisClientEvent,
  MarineAisNormalizedEvent,
  MarineAisWebSocketClient,
} from "../../infrastructure/ais/MarineAisWebSocketClient";

const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_MAX_SECONDS = 60;
const DEFAULT_SAMPLES = 3;

function usage(): void {
  console.log("👉 Cách dùng: npm run marine-ais:poc [-- --max-messages=N --max-seconds=N --samples=N]");
  console.log(`   Mặc định: --max-messages=${DEFAULT_MAX_MESSAGES} --max-seconds=${DEFAULT_MAX_SECONDS} --samples=${DEFAULT_SAMPLES}`);
  console.log("   Cần MARINE_AIS_WS_URL trong .env, VD ws://127.0.0.1:3000/ais-stream");
}

function readFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim();
}

function readNumberFlag(args: string[], name: string, fallback: number): number {
  const raw = readFlag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`❌ --${name} phải là số dương, nhận "${raw}".`);
    process.exit(1);
  }
  return value;
}

/** Một dòng ngắn cho mỗi sample. Không dump cả object. */
function describe(event: MarineAisNormalizedEvent): string {
  const position = event.result.position;
  if (position !== undefined) {
    return (
      `POSITION mmsi=${position.mmsi} ` +
      `lat=${position.lat.toFixed(5)} lng=${position.lng.toFixed(5)} ` +
      `sog=${position.speed ?? "—"} cog=${position.course ?? "—"} ` +
      `nav=${position.navStatus?.text ?? position.navStatus?.code ?? "—"} ` +
      `sourceReceivedAt=${position.receivedAt.toISOString()}`
    );
  }
  const identity = event.result.identity;
  return (
    `IDENTITY mmsi=${identity?.mmsi} imo=${identity?.imo ?? "—"} ` +
    `name=${identity?.name ?? "—"} typeCode=${identity?.vesselTypeCode ?? "—"} ` +
    "sourceReceivedAt=— (message 5 không mang mốc)"
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = config.marineAisWsUrl;

  if (url === "") {
    console.error("❌ Chưa đặt MARINE_AIS_WS_URL.");
    usage();
    process.exit(1);
  }

  const maxMessages = readNumberFlag(args, "max-messages", DEFAULT_MAX_MESSAGES);
  const maxSeconds = readNumberFlag(args, "max-seconds", DEFAULT_MAX_SECONDS);
  const maxSamples = readNumberFlag(args, "samples", DEFAULT_SAMPLES);

  let client: MarineAisWebSocketClient;
  try {
    // Cổng chặn URL nằm trong constructor -> URL sai thì hỏng NGAY, chưa mở socket.
    client = new MarineAisWebSocketClient({ url });
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(
    `\n🛰️  Marine AIS bridge POC\n` +
      `   url=${url}\n` +
      `   dừng khi: ${maxMessages} message HOẶC ${maxSeconds}s\n` +
      `   in tối đa ${maxSamples} sample. KHÔNG ghi DB.\n`
  );

  let normalized = 0;
  let printed = 0;
  let stopping = false;

  const finish = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearTimeout(deadline);
    await client.stop();

    const stats = client.getStats();
    console.log(`\n⏹️  Dừng: ${reason}`);
    console.log("\n📊 Bộ đếm");
    console.log(`   frame nhận         : ${stats.receivedFrames}`);
    console.log(`   frame chào server  : ${stats.serverNotices}`);
    console.log(`   đúng hợp đồng      : ${stats.validMessages}`);
    console.log(`   map thành công     : ${stats.mappingSuccess}`);
    console.log(`   map bị loại        : ${stats.mappingRejected}`);
    console.log(`   JSON hỏng          : ${stats.malformedJson}`);
    console.log(`   lệch hợp đồng      : ${stats.contractMismatch}`);
    console.log(`   connection         : ${stats.connections}`);
    console.log(`   lần nối lại        : ${stats.reconnects}`);
    const reasons = Object.entries(stats.rejectionsByReason);
    if (reasons.length > 0) {
      console.log("   lý do loại:");
      for (const [name, count] of reasons) console.log(`      • ${name}: ${count}`);
    }
    process.exit(0);
  };

  const deadline = setTimeout(() => void finish(`hết ${maxSeconds}s`), maxSeconds * 1000);

  client.on(MarineAisClientEvent.CONNECTED, () => console.log("✅ connected"));
  client.on(MarineAisClientEvent.DISCONNECTED, (info: { intentional: boolean; code?: number }) => {
    if (!info.intentional) console.log(`⚠️  disconnected (code=${info.code ?? "—"})`);
  });
  client.on(MarineAisClientEvent.ERROR, (err: Error) => console.error(`❌ ${err.message}`));

  client.on(MarineAisClientEvent.NORMALIZED_DATA, (event: MarineAisNormalizedEvent) => {
    normalized += 1;
    if (printed < maxSamples) {
      printed += 1;
      console.log(`   ${printed}. ${describe(event)}`);
    }
    if (normalized >= maxMessages) void finish(`đủ ${maxMessages} message`);
  });

  // Ctrl-C / SIGTERM -> đóng sạch, đúng thứ mà container sẽ làm ở phase sau.
  process.on("SIGINT", () => void finish("SIGINT"));
  process.on("SIGTERM", () => void finish("SIGTERM"));

  client.start();
}

void main();
