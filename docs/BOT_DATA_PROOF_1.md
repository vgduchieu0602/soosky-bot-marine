# BOT-DATA-PROOF-1

**Date:** 2026-08-18  
**Bot baseline commit:** `0eb44a285c2ce10ec228f5b15ac1460d05a07dd7` (+ uncommitted proof tooling)  
**Marine:** not modified for this phase (reference only)

## Hard safety

| Control | Value |
|---|---|
| `BOT_DATA_PROOF_MODE` | `true` |
| Mongo DB | `soosky_marine_bot_dev` (local `127.0.0.1:27017`) |
| Production DB guard | `src/config/databaseSafety.ts` refuses known production names |
| `BOT_AIS_ENABLED` | `false` |
| `PAID_FALLBACK_ENABLED` | `false` |
| MyShipTracking calls | **0** (`myShipTrackingKeyPresent: false` in report) |
| Marine integration | **none** |

## Commands

```bash
export BOT_DATA_PROOF_MODE=true
export MONGODB_URI='mongodb://127.0.0.1:27017/soosky_marine_bot_dev'
export BOT_AIS_ENABLED=false
export PAID_FALLBACK_ENABLED=false

npm run build
npm test

npm run bot:discovery -- --pages=10 --reset-checkpoint
npm run bot:discovery -- --pages=100   # resumes checkpoint
npm run bot:map-proof
npm run bot:detail-proof -- --sample=30
npm run bot:data-report
```

## Pipeline proven

```
VesselFinder mp2 tiles
  → VesselFinderProvider.scanArea
  → ObservationRecorder.recordPositions
  → vessel_observations
  → ResolveAndStoreCurrentVessel
  → canonical_current_vessels
```

No crawler→canonical bypass.

## Live results (summary)

### Discovery (aggregate across runs)

| Metric | Evidence |
|---|---|
| Pages with HTTP 200 | 10 + 10 + 5 + 20 (+ earlier resume chain to tile 103) |
| Errors / 403 / 429 | **0** in successful report batches |
| Raw rows (latest 20-tile batch) | 1081 |
| Unique MMSI (that batch) | 1081 |
| Checkpoint | `bot_crawl_checkpoints` job `data-proof-discovery` → tileIndex **103**/108 |
| Resume | log: `Resuming checkpoint at tile 15/108` then later finish run |

### Map

| Metric | Value |
|---|---|
| Pages | 10 OK |
| Position rows | 154 raw / 153 unique |
| lat/lon on canonical | **2289 / 2289 = 100%** |
| course / speed / navStatus | ~0% from map tiles (provider limitation) |
| sourceObservedAt | ~0% from map tiles (no timestamp in mp2) |

### Detail sample (n=30 free multi)

| Field | Coverage |
|---|---|
| vesselType | **90%** |
| flag | **100%** |
| grossTonnage | 0% |
| deadWeight | 0% |
| yearOfBuild | 0% |
| ports / voyage | 0% |

Many attempts stopped with `NO_FREE_SOURCE_AVAILABLE` after partial identity enrichment; paid disabled by design.

### Database

| Collection | Count / notes |
|---|---|
| `vessel_observations` | 4800 |
| `canonical_current_vessels` | 2289 (all with lat/lon) |
| `bot_crawl_checkpoints` | discovery + map cursors |
| Indexes obs | mmsi/imo/source/fingerprint/expiresAt |
| Indexes canonical | mmsi, imo, **location_2dsphere** |
| Storage | ~4.59 MB data + ~2.1 MB indexes (sample) |

### Throughput (measured)

| Batch | pages/min | vessels/min |
|---|---|---|
| discovery 20 tiles / 39.3s / 1081 ships | ~30.5 | ~1650 |
| map 10 tiles / 17.2s / 154 ships | ~35 | ~540 |

**Full discovery ETA** (illustrative 31k list-pages scale; our unit is map tiles):  
- best: ~31k/40 ≈ **13h**  
- measured ~30 pages/min: **~17h**  
- conservative (errors/cooldown): **24–48h**

### Process memory

| State | RSS | heap |
|---|---|---|
| crawl peak | ~500 MB | ~410 MB |
| report idle-ish | ~480 MB | ~394 MB |

No continuous climb across empty tiles (stable ~460 MB on empty ocean tiles).

### Build / test

| | |
|---|---|
| `npm run build` | PASS |
| `npm test` | **1054/1054 PASS** |

## Capability assessment

| Need | Crawler alone? |
|---|---|
| A. Discovery (MMSI + name density) | **YES** — VesselFinder map tiles work |
| B. Map base layer (lat/lon markers) | **YES** for position pins; **NO** reliable course/speed/nav/source time from free map binary |
| C. Vessel details (GT/DWT/voyage) | **PARTIAL** — flag/type often; tonnage/voyage need better free detail sources or paid |

## Verdict

**CONDITIONALLY PASS**

Why not FULL PASS:
- No 2–6h continuous soak in this session
- Live SIGTERM drain not separately instrumented (handlers exist)
- Detail tonnage/voyage coverage still 0% on free path
- Manual 10-record source HTML cross-check not fully tabulated
- Marine working tree shows only unrelated `tmp/*` deletions; no proof-phase source edits

## Suggested commit

```
feat(runtime): prove standalone marine crawl data pipeline
```
