# Standalone Bot scope audit (scope correction)

**Date:** 2026-08-18  
**Repo:** Soosky-bot-marine only  
**Rule:** Bot is a standalone FREE-source acquisition service. No Marine API integration work.

## Classification

| Path / concern | Why it exists | Decision |
|---|---|---|
| `src/infrastructure/integrations/vesselfinder/**` | Free map/detail crawl | **KEEP** |
| `src/infrastructure/integrations/shipfinder/**` | Free detail crawl | **KEEP** |
| `src/infrastructure/integrations/shipinfo/**` | Free detail crawl | **KEEP** |
| Observation / Resolver / Canonical Mongo | Core acquisition pipeline | **KEEP** |
| `src/interfaces/cli/botDataProof.ts` + `bot:*` scripts | Standalone data proof | **KEEP** |
| `src/config/databaseSafety.ts` | Isolated DB guard for proof | **KEEP** |
| `src/application/contracts/VesselBasics.ts` etc. | **Target coverage definitions only** — not Marine HTTP | **KEEP** (as coverage targets) |
| `src/infrastructure/integrations/marine-ais/**` | Optional WS client that would read **Marine API** AIS bridge | **FREEZE** — default off (`BOT_AIS_ENABLED=false`, empty `MARINE_AIS_WS_URL`). Not deleted this pass to avoid large refactor; **must not be used** for current work. |
| `src/interfaces/cli/marineAis*.ts` + `marine-ais:*` npm scripts | PoC/sim for that bridge | **FREEZE** — do not run for free-motion proof |
| `src/bootstrap/createProductionRuntime.ts` AIS branch | Wires Marine AIS only if explicitly enabled | **FREEZE** — stays dead unless flags set |
| `src/interfaces/http/internalAcquireRoute.ts` | Bot-owned internal command HTTP (comments mention Marine as future consumer) | **FREEZE** — Bot does not call Marine; optional local command surface |
| `docs/BOT_MARINE_INTEGRATION.md`, `docs/AIS_MARINE_WS_BRIDGE.md`, etc. | Historical integration design notes | **FREEZE** — reference only; not runtime |
| Nested `marine-api/` directory | Foreign project nest | **REMOVE** if present (gitignored). **Not on disk** at audit time. |
| `MarineApiClient` / `MarineSyncService` / etc. | — | **Not present** |

## Cross-project dependency check

- No `import`/`require` of Soosky-marine-api or nested `marine-api` packages: **NONE**
- Default runtime: `botAisEnabled=false`, `marineAisWsUrl=""`, `paidFallbackEnabled=false`

## Files actually removed this pass

- Nested `marine-api/`: **absent** (nothing to delete)
- No Marine client classes found to delete
- No package dependency on Marine repo

## Standalone confirmation

Bot responsibility remains:

```
VesselFinder / ShipFinder / ShipInfo
  → crawl → normalize → Observation → Resolver → Canonical → Bot MongoDB
```

VesselBasics / VesselDetails = **desired field coverage targets**, not Marine API surface.

## Do not do next (this correction)

- Do not enable Marine AIS bridge
- Do not call Marine HTTP
- Do not start architecture refactor of frozen AIS folder
- Free-motion proof (if resumed) stays under `scripts/data-proof` / CLI proof only
