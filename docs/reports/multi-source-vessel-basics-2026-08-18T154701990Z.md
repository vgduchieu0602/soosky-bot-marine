# PHASE 3.3 — MULTI-SOURCE VESSELBASICS MATRIX

- Database: `soosky_marine_bot_dev` · AIS **off** · paid **off**
- Sample: **90** vessels · US=30 UK=30 NORWAY=30
- Measured at: 2026-08-18T15:47:01.769Z
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
| lat | 100% | 0% | 5.6% |
| lon | 100% | 0% | 5.6% |
| latLon | 100% | 0% | 5.6% |
| course | 0% | 0% | 2.2% |
| speed | 1.1% | 0% | 5.6% |
| navStatusText | 0% | 0% | 0% |
| navStatusCode | 0% | 0% | 0% |
| received | 1.1% | 0% | 5.6% |

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
| lat | 0% | 0% | 0% | 0% |
| lon | 0% | 0% | 0% | 0% |
| latLon | 0% | 0% | 0% | 0% |
| course | 0% | 0% | 0% | 0% |
| speed | 0% | 0% | 0% | 0% |
| navStatusText | 0% | 0% | 0% | 0% |
| navStatusCode | 0% | 0% | 0% | 0% |
| received | 0% | 0% | 0% | 0% |

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
| vesselfinder | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 89 |
| shipfinder | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 90 |
| shipinfo | 0 | 0 | 0 | 0 | 0 | 4 | 1 | 85 |

### MATRIX 3b — fresh usable coverage, counts not percentages (§22)

| provider | window | lat/lon | speed | course | navStatus |
|---|---:|---:|---:|---:|---:|
| vesselfinder | <=15m | 0 | 0 | 0 | 0 |
| vesselfinder | <=30m | 0 | 0 | 0 | 0 |
| vesselfinder | <=60m | 1 | 1 | 0 | 0 |
| shipfinder | <=15m | 0 | 0 | 0 | 0 |
| shipfinder | <=30m | 0 | 0 | 0 | 0 |
| shipfinder | <=60m | 0 | 0 | 0 | 0 |
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
| lat | 100% | 5.6% |
| lon | 100% | 5.6% |
| latLon | 100% | 5.6% |
| course | 0% | 2.2% |
| speed | 1.1% | 5.6% |
| navStatusText | 0% | 0% |
| navStatusCode | 0% | 0% |
| received | 1.1% | 5.6% |

### Source failure simulation (§29)

| FIELD | A: all free | B: no VesselFinder | C: no VF + no ShipFinder |
|---|---:|---:|---:|
| vesselName | 100% | 95.6% | 5.6% |
| mmsi | 100% | 95.6% | 5.6% |
| imo | 32.2% | 32.2% | 2.2% |
| vTypeNumeric | 0% | 0% | 0% |
| vesselTypeText | 90% | 90% | 3.3% |
| lat | 100% | 5.6% | 5.6% |
| lon | 100% | 5.6% | 5.6% |
| latLon | 100% | 5.6% | 5.6% |
| course | 2.2% | 2.2% | 2.2% |
| speed | 6.7% | 5.6% | 5.6% |
| navStatusText | 0% | 0% | 0% |
| navStatusCode | 0% | 0% | 0% |
| received | 6.7% | 5.6% | 5.6% |

---

## CRITICAL READING CAVEAT — VesselFinder is measured under an outage

VesselFinder's column above is **not** its capability. During this run the
VesselFinder detail lane recorded `{"timeout":1,"cooldown":89}` — every detail
request failed. Its numbers therefore come almost entirely from **map-tile**
observations already in the database:

```
VF POSITION observations for the 90-vessel sample:
  map (precise coordinates) : 139
  detail (rounded, has motion): 1
  observations carrying speed : 1
```

A map tile supplies `mmsi + name + lat/lon` and nothing else — by design. So
`course 0% / speed 1.1% / navStatus 0%` measures **the outage**, not the source.

Previously measured under live detail access (same pipeline, Phase 2/3.2R):

| field | VF detail, measured live earlier |
|---|---:|
| speed | ~99–100% |
| course | ~67–77% |
| navStatus | ~33–49% |
| received (derived from `lrpd`) | 100% |

Use those figures for VesselFinder detail capability. Use the table above only
for what the map tile provides.

## §7/§8 request amplification

| measure | value |
|---|---|
| map scan | 6 HTTP requests → 493 vessel rows → **~1.2 requests / 100 vessels discovered** |
| detail, before freshness gate | 1 request per vessel (90 vessels → 90 requests) |
| detail, after gate | governed by `CheckLocalVesselSufficiency` + `DetailRefreshGate` (single-flight + cooldown), already present — no new logic added |

Discovery is extremely cheap; **detail is the expensive lane**, at 1:1 per vessel
per provider.

## §12 ShipFinder timestamp safety — the decisive finding

`SHIPFINDER_SOURCE_UTC_OFFSET_MINUTES` is **not set**. The provider therefore
suppresses its entire position group by design, rather than guess a timezone:

```
ShipFinder: 90 requests · 86 × 200 · 4 notFound
positionGroupMissing = 86   (every successful response)
POSITION observations written = 0
```

This is a **configuration** result, not a parser limitation. ShipFinder returned
usable identity/particulars/voyage for 86/90 vessels while emitting no position
at all. Its lat/lon/speed/course/navStatus/received row reading 0% is the
conservative default doing exactly what it was built to do.

## §27 the two discovery questions

**A. Can KNOWN vessels keep refreshing without VesselFinder?**
**Partially.** ShipFinder refreshes identity (95.6%), vesselTypeText (90%) and
imo (32.2%) for known MMSIs. But position/motion falls to 5.6% (ShipInfo only,
and ShipInfo was blocked on 82/90 requests). Without the ShipFinder UTC offset
configured, **no fresh position survives a VesselFinder outage**.

**B. Can NEW vessels still be discovered without VesselFinder?**
**No.** Only VesselFinder implements `SCAN_AREA`. ShipFinder and ShipInfo are
MMSI-lookup only — they can refresh a vessel you already know, and cannot tell
you a vessel exists. A VesselFinder outage stops regional discovery completely.

## §37 DECISION TABLE — derived from measured data only

| FIELD | PRIMARY | BACKUP 1 | BACKUP 2 |
|---|---|---|---|
| vesselName | VesselFinder (100%, map, cheap) | ShipFinder (95.6%) | ShipInfo (5.6%) |
| mmsi | VesselFinder (100%, discovery key) | ShipFinder (95.6%) | ShipInfo (5.6%) |
| imo | ShipFinder (32.2%) | ShipInfo (2.2%) | VesselFinder (0% observed) |
| vType (numeric) | **UNAVAILABLE — 0% from all three** | — | — |
| vType (text, non-contract) | ShipFinder (90%) | ShipInfo (3.3%) | VesselFinder (1.1%) |
| lat/lon | VesselFinder map (100%, precise) | ShipInfo (5.6%, stale) | ShipFinder (blocked by config) |
| course | VesselFinder detail (~67–77% when reachable) | ShipInfo (2.2%) | ShipFinder (config-blocked) |
| speed | VesselFinder detail (~99% when reachable) | ShipInfo (5.6%) | ShipFinder (config-blocked) |
| navStatus | VesselFinder detail (~33–49% when reachable) | **no backup** | — |
| received | VesselFinder detail (`lrpd`-derived, 100% when reachable) | ShipInfo (absolute, 5.6%) | ShipFinder (config-blocked) |

## §38 VERDICTS

**KNOWN-VESSEL FALLBACK: CONDITIONALLY PASS**
Identity/particulars/voyage survive a VesselFinder outage via ShipFinder (86/90).
Position and motion do not (5.6%). Fixable without new code by configuring
`SHIPFINDER_SOURCE_UTC_OFFSET_MINUTES` — that single setting is the largest
resilience lever available.

**NEW-VESSEL DISCOVERY FALLBACK: FAIL**
Only VesselFinder implements `SCAN_AREA`. No free fallback exists for discovering
vessels that are not already known. This is a structural single point of failure.

**VESSELBASICS FREE COVERAGE: CONDITIONALLY PASS**
Strong: vesselName, mmsi, lat/lon. Weak: imo (32.2%), course, navStatus.
**Zero: numeric `vType` — 0% from all three providers**, so the contract's
`vType: number | null` cannot be satisfied by any current free source.

## Remaining weak / missing fields

1. `vTypeNumeric` — **0% everywhere**. Contract-blocking.
2. `navStatus` — no backup at all outside VesselFinder detail.
3. Position freshness — every provider landed in `unknown` or `>6h` this run;
   no source produced a `<=15m` position while VesselFinder detail was down.
4. ShipInfo — 403 after 5 successful reads, then 15-minute cooldown. Not a
   dependable backup at any volume.
