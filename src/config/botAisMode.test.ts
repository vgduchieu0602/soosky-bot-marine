import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./index";

test("BOT_AIS_ENABLED is off by default and requires the literal true", () => {
  assert.equal(loadConfig({}).botAisEnabled, false);
  assert.equal(loadConfig({ BOT_AIS_ENABLED: "yes" }).botAisEnabled, false);
  assert.equal(loadConfig({ BOT_AIS_ENABLED: "true" }).botAisEnabled, true);
});
