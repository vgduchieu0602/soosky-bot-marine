import assert = require("node:assert/strict");
import { test } from "node:test";
import {
  assertSafeBotDatabase,
  extractMongoDatabaseName,
  isProofModeEnabled,
} from "./databaseSafety";

test("extractMongoDatabaseName reads path segment", () => {
  assert.equal(
    extractMongoDatabaseName("mongodb://127.0.0.1:27017/soosky_marine_bot_dev"),
    "soosky_marine_bot_dev"
  );
  assert.equal(
    extractMongoDatabaseName("mongodb+srv://u:p@cluster0.example/soosky_marine?retryWrites=true"),
    "soosky_marine"
  );
  assert.equal(extractMongoDatabaseName("mongodb://127.0.0.1:27017"), null);
});

test("proof mode refuses production DB names", () => {
  assert.throws(
    () =>
      assertSafeBotDatabase({
        mongoUri: "mongodb://127.0.0.1:27017/soosky_marine",
        proofMode: true,
      }),
    /refused database/
  );
});

test("proof mode allows isolated bot DB", () => {
  const { dbName } = assertSafeBotDatabase({
    mongoUri: "mongodb://127.0.0.1:27017/soosky_marine_bot_dev",
    proofMode: true,
  });
  assert.equal(dbName, "soosky_marine_bot_dev");
});

test("isProofModeEnabled requires literal true", () => {
  assert.equal(isProofModeEnabled({ BOT_DATA_PROOF_MODE: "yes" }), false);
  assert.equal(isProofModeEnabled({ BOT_DATA_PROOF_MODE: "true" }), true);
});
