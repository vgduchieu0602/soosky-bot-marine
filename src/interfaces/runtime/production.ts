import { createProductionRuntime } from "../../bootstrap/createProductionRuntime";

const runtime = createProductionRuntime();
let shuttingDown = false;

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[runtime] received ${signal}; graceful shutdown begins`);
  try {
    await runtime.stop();
    process.exitCode = exitCode;
  } catch (error) {
    console.error(`[runtime] shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => { void shutdown("SIGTERM", 0); });
process.once("SIGINT", () => { void shutdown("SIGINT", 0); });
process.once("uncaughtException", (error) => {
  console.error("[runtime] uncaught exception", error);
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[runtime] unhandled rejection", reason);
  void shutdown("unhandledRejection", 1);
});

void runtime.start().catch((error) => {
  console.error(`[runtime] startup failed: ${error instanceof Error ? error.message : String(error)}`);
  void shutdown("startup failure", 1);
});
