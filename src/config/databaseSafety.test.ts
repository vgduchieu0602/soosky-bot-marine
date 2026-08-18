import assert = require("node:assert/strict");
import { test } from "node:test";
import {
  assertProductionDatabase,
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

// ---------------------------------------------------------------------------
//  Production runtime guard — KHÁC hẳn guard của proof mode
// ---------------------------------------------------------------------------

test("production: URI thiếu tên database -> ném, không im lặng rơi về default", () => {
  for (const uri of ["mongodb://127.0.0.1:27017", "mongodb+srv://user:pw@cluster.mongodb.net/?retryWrites=true"]) {
    assert.throws(() => assertProductionDatabase(uri), /explicit database name/);
  }
});

test("production: URI rỗng -> ném", () => {
  assert.throws(() => assertProductionDatabase(""), /MONGODB_URI is required/);
  assert.throws(() => assertProductionDatabase("   "), /MONGODB_URI is required/);
});

test("production ĐƯỢC PHÉP dùng tên DB production — guard proof KHÔNG áp vào đây", () => {
  // Chính những tên này bị `assertSafeBotDatabase(proofMode)` từ chối.
  for (const name of ["soosky_marine", "marine", "production"]) {
    const uri = `mongodb+srv://user:pw@cluster.mongodb.net/${name}?retryWrites=true`;
    assert.equal(assertProductionDatabase(uri).dbName, name);
    // ...và guard proof vẫn phải từ chối chúng, không bị nới lỏng.
    assert.throws(
      () => assertSafeBotDatabase({ mongoUri: uri, proofMode: true }),
      /production DB name/
    );
  }
});

test("production: BOT_DATA_PROOF_MODE không liên quan tới guard này", () => {
  const uri = "mongodb+srv://user:pw@cluster.mongodb.net/soosky_marine_bot_dev";
  for (const flag of ["true", "false", undefined]) {
    if (flag === undefined) delete process.env.BOT_DATA_PROOF_MODE;
    else process.env.BOT_DATA_PROOF_MODE = flag;
    assert.equal(assertProductionDatabase(uri).dbName, "soosky_marine_bot_dev");
  }
  delete process.env.BOT_DATA_PROOF_MODE;
});
