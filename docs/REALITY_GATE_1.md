# REALITY GATE 1 — Bot

**Commit tested:** `822d147fc013b8f388b96fd2906b5a7acdc8f5a9`  
**Date:** 2026-08-17  
**Node:** v22.22.2 · **npm:** 10.9.7

## Commands / results

| Gate | Result | Evidence |
|---|---|---|
| clean `npm ci` | **PASS** | exit 0, 124 packages |
| `npm test` | **PASS** | 1050/1050 pass, exit 0 |
| `npm run build` | **PASS** | `tsc` exit 0 |
| contract parity → Marine | **PASS** | `VESSEL CONTRACT V1: MATCH` |
| NO_DATA misuse | **PASS** | `"---"` only in contracts/mapper/tests; resolver `NO_DATA` is status enum, not persistence sentinel |
| Mongo DB | **PASS** | local `mongodb://127.0.0.1:27017/soosky_marine_reality_gate` |
| 2dsphere index | **PASS** | `location_2dsphere` created via `CurrentVesselModel.createIndexes()` |
| Bot pipeline write | **PASS** | `scripts/reality-gate-seed.ts` → `IngestAisBatch` → 26 vessels, 52 observations saved, 26 resolved |
| sample canonical doc | **PASS** | mmsi/imo/identity/position.position.lat|lng/observedAt/location present (see Marine report for JSON) |
| explain 2dsphere | **PASS** | winning plan `IXSCAN` `location_2dsphere`; nReturned=5 keysExamined=5 docsExamined=5 |
| Bot start AIS off | **PASS** | `BOT_AIS_ENABLED=false`; process served `/health` on :3200 without AISStream config |
| internal acquire free | **PASS** | HTTP 200 `PARTIAL`/`LOCAL_HIT`, `fallbackUsed=false`, `acquisitionRequestId` echoed |
| idempotency concurrent | **PASS** | same `acquisitionRequestId` → both 200 `LOCAL_HIT` (one workflow) |
| different request ids | **PASS*** | after rate budget exhausted → HTTP 429 (per-vessel limit protects external spend) |
| real paid MyShipTracking | **NOT RUN** | intentionally mocked/disabled; no credits |

\* Different IDs after 3/min vessel limit correctly rate-limited — credit-safe behavior.

## Bot responsibility confirmed

Acquisition/write owner. Internal command channel token-protected. Paid lane off.
