import assert from "node:assert/strict";
import test from "node:test";
import { CrawlPositionFreshness, classifyCrawlPositionFreshness } from "./CrawlPositionFreshnessPolicy";
import { toCrawlMapVessel } from "./CrawlMapVessel";

test("crawl map projection preserves null unknowns and never adds presentation sentinels", () => {
  const projected = toCrawlMapVessel({
    mmsi: "123456789", imo: null, vesselName: null, vesselTypeCode: null,
    lat: 10, lon: 106, course: null, speed: null,
    navStatusCode: null, navStatusText: null, observedAt: new Date("2026-08-17T00:00:00.000Z"),
  });
  assert.deepEqual(projected, {
    vesselName: null, mmsi: "123456789", imo: null, vType: null,
    lat: 10, lon: 106, course: null, speed: null, navStatus: null,
    observedAt: new Date("2026-08-17T00:00:00.000Z"),
  });
});

test("crawl freshness is fresh, stale, or unknown without consulting persistence", () => {
  const now = new Date("2026-08-17T12:00:00.000Z");
  assert.equal(classifyCrawlPositionFreshness(new Date("2026-08-17T11:40:00.000Z"), now), CrawlPositionFreshness.FRESH);
  assert.equal(classifyCrawlPositionFreshness(new Date("2026-08-17T11:00:00.000Z"), now), CrawlPositionFreshness.STALE);
  assert.equal(classifyCrawlPositionFreshness(null, now), CrawlPositionFreshness.UNKNOWN);
});
