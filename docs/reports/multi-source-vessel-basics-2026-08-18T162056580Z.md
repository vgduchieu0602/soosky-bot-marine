# PHASE 3.3 — MULTI-SOURCE VESSELBASICS MATRIX

- Database: `soosky_marine_bot_dev` · AIS **off** · paid **off**
- Sample: **90** vessels · US=30 UK=30 NORWAY=30
- Measured at: 2026-08-18T16:20:56.371Z
- All coverage computed from persisted `vessel_observations` (real pipeline), not from a diagnostic parser.

### Runtime settings per provider (§6)

| provider | timeout ms | concurrency | delay ms | retries | cooldown ms |
|---|---:|---:|---:|---:|---:|
| vesselfinder | 10000 | 1 | 2000-5000 | 2 | 300000 |
| shipfinder | 15000 | 1 | 3000-8000 | 1 | 900000 |
| shipinfo | 20000 | 1 | 3000-8000 | 1 | 900000 |

### Discovery capability — CURRENT implementation (§26)

| provider | AREA SCAN | MMSI lookup | IMO lookup |
|---|---:|---:|---:|
| vesselfinder | **yes** | yes | no |
| shipfinder | no | yes | no |
| shipinfo | no | yes | yes |

### MATRIX 1 — raw VesselBasics field coverage (§20)

| FIELD | VesselFinder | ShipFinder | ShipInfo |
|---|---:|---:|---:|
| vesselName | 100% | 95.6% | 5.6% |
| mmsi | 100% | 95.6% | 5.6% |
| imo | 0% | 32.2% | 2.2% |
| vTypeNumeric | 0% | 0% | 0% |
| vesselTypeText | 1.1% | 90% | 3.3% |
| lat | 100% | 95.6% | 5.6% |
| lon | 100% | 95.6% | 5.6% |
| latLon | 100% | 95.6% | 5.6% |
| course | 0% | 71.1% | 2.2% |
| speed | 1.1% | 95.6% | 5.6% |
| navStatusText | 0% | 51.1% | 0% |
| navStatusCode | 0% | 0% | 0% |
| received | 1.1% | 95.6% | 5.6% |

### MATRIX 2 — vesselfinder regional coverage (§21)

| FIELD | US | UK | NORWAY | ALL |
|---|---:|---:|---:|---:|
| vesselName | 100% | 100% | 100% | 100% |
| mmsi | 100% | 100% | 100% | 100% |
| imo | 0% | 0% | 0% | 0% |
| vTypeNumeric | 0% | 0% | 0% | 0% |
| vesselTypeText | 0% | 0% | 3.3% | 1.1% |
| lat | 100% | 100% | 100% | 100% |
| lon | 100% | 100% | 100% | 100% |
| latLon | 100% | 100% | 100% | 100% |
| course | 0% | 0% | 0% | 0% |
| speed | 0% | 0% | 3.3% | 1.1% |
| navStatusText | 0% | 0% | 0% | 0% |
| navStatusCode | 0% | 0% | 0% | 0% |
| received | 0% | 0% | 3.3% | 1.1% |

### MATRIX 2 — shipfinder regional coverage (§21)

| FIELD | US | UK | NORWAY | ALL |
|---|---:|---:|---:|---:|
| vesselName | 93.3% | 96.7% | 96.7% | 95.6% |
| mmsi | 93.3% | 96.7% | 96.7% | 95.6% |
| imo | 30% | 33.3% | 33.3% | 32.2% |
| vTypeNumeric | 0% | 0% | 0% | 0% |
| vesselTypeText | 83.3% | 93.3% | 93.3% | 90% |
| lat | 93.3% | 96.7% | 96.7% | 95.6% |
| lon | 93.3% | 96.7% | 96.7% | 95.6% |
| latLon | 93.3% | 96.7% | 96.7% | 95.6% |
| course | 70% | 73.3% | 70% | 71.1% |
| speed | 93.3% | 96.7% | 96.7% | 95.6% |
| navStatusText | 60% | 53.3% | 40% | 51.1% |
| navStatusCode | 0% | 0% | 0% | 0% |
| received | 93.3% | 96.7% | 96.7% | 95.6% |

### MATRIX 2 — shipinfo regional coverage (§21)

| FIELD | US | UK | NORWAY | ALL |
|---|---:|---:|---:|---:|
| vesselName | 16.7% | 0% | 0% | 5.6% |
| mmsi | 16.7% | 0% | 0% | 5.6% |
| imo | 6.7% | 0% | 0% | 2.2% |
| vTypeNumeric | 0% | 0% | 0% | 0% |
| vesselTypeText | 10% | 0% | 0% | 3.3% |
| lat | 16.7% | 0% | 0% | 5.6% |
| lon | 16.7% | 0% | 0% | 5.6% |
| latLon | 16.7% | 0% | 0% | 5.6% |
| course | 6.7% | 0% | 0% | 2.2% |
| speed | 16.7% | 0% | 0% | 5.6% |
| navStatusText | 0% | 0% | 0% | 0% |
| navStatusCode | 0% | 0% | 0% | 0% |
| received | 16.7% | 0% | 0% | 5.6% |

### MATRIX 3a — position freshness distribution (§19)

| provider | <=5m | 5-15m | 15-30m | 30-60m | 1-6h | 6-24h | >24h | unknown |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| vesselfinder | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 89 |
| shipfinder | 28 | 38 | 3 | 1 | 11 | 5 | 0 | 4 |
| shipinfo | 0 | 0 | 0 | 0 | 0 | 4 | 1 | 85 |

### MATRIX 3b — fresh usable coverage, counts not percentages (§22)

| provider | window | lat/lon | speed | course | navStatus |
|---|---:|---:|---:|---:|---:|
| vesselfinder | <=15m | 0 | 0 | 0 | 0 |
| vesselfinder | <=30m | 0 | 0 | 0 | 0 |
| vesselfinder | <=60m | 0 | 0 | 0 | 0 |
| shipfinder | <=15m | 66 | 66 | 53 | 39 |
| shipfinder | <=30m | 69 | 69 | 53 | 39 |
| shipfinder | <=60m | 70 | 70 | 54 | 39 |
| shipinfo | <=15m | 0 | 0 | 0 | 0 |
| shipinfo | <=30m | 0 | 0 | 0 | 0 |
| shipinfo | <=60m | 0 | 0 | 0 | 0 |

### MATRIX 4 — fallback with VesselFinder OFF (§23)

| FIELD | VF only (case A component) | ShipFinder+ShipInfo (case B) |
|---|---:|---:|
| vesselName | 100% | 95.6% |
| mmsi | 100% | 95.6% |
| imo | 0% | 32.2% |
| vTypeNumeric | 0% | 0% |
| vesselTypeText | 1.1% | 90% |
| lat | 100% | 95.6% |
| lon | 100% | 95.6% |
| latLon | 100% | 95.6% |
| course | 0% | 71.1% |
| speed | 1.1% | 95.6% |
| navStatusText | 0% | 51.1% |
| navStatusCode | 0% | 0% |
| received | 1.1% | 95.6% |

### Source failure simulation (§29)

| FIELD | A: all free | B: no VesselFinder | C: no VF + no ShipFinder |
|---|---:|---:|---:|
| vesselName | 100% | 95.6% | 5.6% |
| mmsi | 100% | 95.6% | 5.6% |
| imo | 32.2% | 32.2% | 2.2% |
| vTypeNumeric | 0% | 0% | 0% |
| vesselTypeText | 90% | 90% | 3.3% |
| lat | 100% | 95.6% | 5.6% |
| lon | 100% | 95.6% | 5.6% |
| latLon | 100% | 95.6% | 5.6% |
| course | 71.1% | 71.1% | 2.2% |
| speed | 95.6% | 95.6% | 5.6% |
| navStatusText | 51.1% | 51.1% | 0% |
| navStatusCode | 0% | 0% | 0% |
| received | 95.6% | 95.6% | 5.6% |

---

# PHASE 4 — ALL MAP SOURCES AUDIT

## §5 Source status — all five, none skipped

| source | status | evidence |
|---|---|---|
| VesselFinder | `SOURCE_UNAVAILABLE` (this run) | TCP 443 timeout on all 4 advertised IPs; runtime recorded 1 timeout → 89 cooldowns |
| ShipInfo | `LOOKUP_ONLY` | HTML provider works (5×200 then 403); public Agent API is key-gated |
| ShipFinder | `LOOKUP_ONLY` | 90 req · 86×200 · 4 notFound; no bbox/area endpoint implemented or exposed |
| BoatNerd | `NOT_USABLE` | `/api/v1/vessels*` → 401 `Invalid or missing API key` — see `docs/sources/BOATNERD_AUDIT.md` |
| MarineTraffic.live | `NOT_USABLE` | Cloudflare challenge, HTTP 403 `Just a moment...` — see `docs/sources/MARINETRAFFIC_LIVE_AUDIT.md` |

## MATRIX A — MAP DIRECT (§16)

Only data obtainable from an area/bbox scan with **no per-vessel follow-up**.

| SOURCE | Name | MMSI | IMO | vTypeNum | LatLon | Course | Speed | Status | Received |
|---|---|---|---|---|---|---|---|---|---|
| VesselFinder MAP | 100% | 100% | 0% | 0% | 100% | 0% | 0% | 0% | 0% |
| ShipInfo MAP | N/A — LOOKUP ONLY | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| ShipFinder MAP | N/A — LOOKUP ONLY | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| BoatNerd MAP | NOT_USABLE (API key) | — | — | — | — | — | — | — | — |
| MarineTraffic.live MAP | NOT_USABLE (challenge) | — | — | — | — | — | — | — | — |

VesselFinder map figures are from its own tile decoder: `mmsi + name + lat/lon`
only, by design. Motion and timestamps are **not** on the map surface.

## MATRIX B — LOOKUP (§17)

| SOURCE | Name | MMSI | IMO | vTypeNum | LatLon | Course | Speed | Status | Received |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| VesselFinder LOOKUP | * | * | * | 0% | * | ~67–77%* | ~99%* | ~33–49%* | 100%* |
| ShipInfo LOOKUP | 5.6% | 5.6% | 2.2% | 0% | 5.6% | 2.2% | 5.6% | 0% | 5.6% |
| **ShipFinder LOOKUP** | **95.6%** | **95.6%** | **32.2%** | 0% | **95.6%** | **71.1%** | **95.6%** | **51.1%** | **95.6%** |
| BoatNerd LOOKUP | NOT_USABLE | — | — | — | — | — | — | — | — |
| MarineTraffic.live LOOKUP | NOT_USABLE | — | — | — | — | — | — | — | — |

\* VesselFinder lookup could not be exercised this run (source unavailable).
Values marked `*` are from earlier live measurement in this same pipeline
(Phase 2/3.2R) and are labelled, not re-measured. ShipInfo's low numbers are an
availability artifact (403 after 5 reads), not a field-capability statement.

## MATRIX C — OPERATIONAL (§34)

| SOURCE | areaScan | geographicScope | req/100 vessels | avgLatency | p95 | 403 | 429 | timeout |
|---|---|---|---:|---:|---:|---:|---:|---:|
| VesselFinder | **yes** | GLOBAL (measured US/UK/NO) | **~1.2** (map) | n/a this run | n/a | 0 | 0 | 1 → 89 cooldown |
| ShipInfo | no | KNOWN-VESSEL-ONLY | 100 | 4437 ms | 7893 ms | 3 | 0 | 0 |
| ShipFinder | no | KNOWN-VESSEL-ONLY | 100 | 5491 ms | 7647 ms | 0 | 0 | 0 |
| BoatNerd | unknown (key-gated) | unmeasurable | — | 270–735 ms (401) | — | — | — | — |
| MarineTraffic.live | unknown (challenge) | unmeasurable | — | 138 ms (403) | — | — | — | — |

**The amplification gap (§18):** VesselFinder map = **1.2 requests per 100
vessels**. Every lookup source = **100 requests per 100 vessels** — an ~83×
difference. Discovery and refresh must never be conflated operationally.

## MATRIX D — FAILURE (§34)

| FIELD | ALL SOURCES | VF OFF |
|---|---:|---:|
| vesselName | 100% | 95.6% |
| mmsi | 100% | 95.6% |
| imo | 32.2% | 32.2% |
| vTypeNumeric | **0%** | **0%** |
| lat/lon | 100% | 95.6% |
| course | 71.1% | 71.1% |
| speed | 95.6% | 95.6% |
| navStatus (text) | 51.1% | 51.1% |
| received | 95.6% | 95.6% |

## §8 ShipFinder timezone — validated, not assumed

Validation evidence (live, 2026-08-18):

```
now UTC                       = 2026-08-18T16:11:42Z
MMSI 232007487 "Last update"  = 2026-08-19 00:08:19
MMSI 367022790 "Last update"  = 2026-08-19 00:09:12
```

Source-local clock runs ~7h57m ahead of UTC → **UTC+8 (480 minutes)**, matching
the earlier audit inference. Two independent vessels agree to within 1 minute.

Effect of supplying `SHIPFINDER_SOURCE_UTC_OFFSET_MINUTES=480`:

| metric | before | after |
|---|---:|---:|
| responses with no position group | 86 / 86 | **0 / 86** |
| POSITION observations written | 0 | **86** |
| lat/lon coverage | 0% | **95.6%** |
| speed coverage | 0% | **95.6%** |
| positions ≤15 min old | 0 | **66 / 90** |

`fetchedAt` is never used as `received` — every timestamp above is derived from
the source's own `Last update` anchored to the validated offset.

## §27 Single point of failure analysis

**A. Another GLOBAL area-scan source if VesselFinder is down?** **No.**
Only VesselFinder implements `SCAN_AREA`.

**B. A REGIONAL area-scan backup?** **No usable one.** BoatNerd would be the
Great-Lakes candidate but is API-key gated; MarineTraffic.live is challenge-gated.

**C. Can known MMSIs keep refreshing?** **Yes — strongly.** ShipFinder alone
delivers name/mmsi/lat-lon/speed at 95.6%, course 71.1%, navStatus 51.1%,
received 95.6%, with 66/90 positions fresher than 15 minutes.

**D. Which fields remain unavailable?** `vTypeNumeric` (**0% from every
source**) and `navStatusCode` (0% — only text is exposed).

## §28 Contract completeness

| result | vesselName | mmsi | imo | vType(num) | lat/lon | course | speed | navStatus | received |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **A. MAP-DIRECT** | 100% | 100% | 0% | **0%** | 100% | 0% | 0% | 0% | 0% |
| **B. FREE COMBINED** | 100% | 100% | 32.2% | **0%** | 100% | 71.1% | 95.6% | 51.1% | 95.6% |
| **C. VF-OFF** | 95.6% | 95.6% | 32.2% | **0%** | 95.6% | 71.1% | 95.6% | 51.1% | 95.6% |

## §30 Details sources — classification only, nothing implemented

| source | status | evidence |
|---|---|---|
| ShipTraffic `/vessels` | `PUBLIC_USABLE` — LIST/DISCOVERY | 200, 32 KB, 11 table rows, no login/paywall wording. External hosts referenced are ads/analytics plus a sibling site only; **no embedded upstream marine provider found** (§32) — it is not merely a front-end, but it is also not proven to hold independent AIS positions |
| ShipInfo `vessels_list.php` | `LOGIN_REQUIRED` | 200 but 0 table rows and login/subscribe wording present |
| VesselTracker `/en/vessels.html` | `LOGIN_REQUIRED` | 200 but 0 table rows and login/premium wording present — public ShipDB does **not** expose the paid dataset (§31) |

## §35 VERDICTS

**MAP-DIRECT VESSELBASICS: FAIL**
A map scan yields only name/mmsi/lat-lon. Course, speed, navStatus and received
are 0% map-direct, and `vType` numeric is 0% everywhere. VesselBasics cannot be
satisfied without per-vessel lookup.

**KNOWN-VESSEL FREE VESSELBASICS: CONDITIONALLY PASS**
9 of 10 contract fields reach usable coverage. Blocked solely by
`vType: number | null` at **0% from all five sources**.

**VF-OFF KNOWN-VESSEL: CONDITIONALLY PASS**
ShipFinder alone sustains refresh at ~95% for identity+position+speed+received
with genuinely fresh timestamps. Same single blocker: numeric `vType`.
This is a large improvement over the pre-offset measurement (was FAIL-grade 5.6%).

**VF-OFF DISCOVERY: FAIL**
No free source other than VesselFinder can discover an unknown vessel. This
remains a structural single point of failure and is unchanged by this phase.
