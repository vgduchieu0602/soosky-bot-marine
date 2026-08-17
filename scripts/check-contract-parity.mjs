import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const other = process.env.OTHER_MARINE_REPO || process.env.OTHER_BOT_REPO;
if (!other) {
  console.log("VESSEL CONTRACT V1: SKIPPED (set OTHER_MARINE_REPO or OTHER_BOT_REPO)");
  process.exit(0);
}
const local = resolve("docs/contracts/vessel-contract-v1.json");
const remote = resolve(other, "docs/contracts/vessel-contract-v1.json");
if (!existsSync(remote)) throw new Error(`VESSEL CONTRACT V1: missing ${remote}`);
if (readFileSync(local, "utf8").trim() !== readFileSync(remote, "utf8").trim()) throw new Error("VESSEL CONTRACT V1: MISMATCH");
console.log("VESSEL CONTRACT V1: MATCH");
