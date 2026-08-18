# PHASE 3.2R — LIVE MOTION RETRY GATE

| | |
|---|---|
| **Commit tested** | `4d98f585af8fce43bdfee8336a3d935690cccfea` |
| **Date** | 2026-08-18 |
| **Verdict** | **CONDITIONALLY PASS** — `SOURCE_UNAVAILABLE` |
| **Working tree** | clean before and after (no code changes were required) |

> `FULL PASS` is forbidden by §36: `sampleSize = 0` and `detailRequests = 0`.
> No code defect is implicated — the live source was unreachable at the network layer.

---

## 1. Commit tested

`4d98f585af8fce43bdfee8336a3d935690cccfea` — *fix(runtime): validate motion persistence across live crawl cycles*.

No runtime bug was found in this phase, so no commit was produced.

## 2. Test / build

| step | result |
|---|---|
| `npm ci` | exit **0**, 0 vulnerabilities |
| `npm test` | **1091 pass / 0 fail**, exit **0** |
| `npm run build` | exit **0** |

Node `v22.22.2` · npm `10.9.7`.

## 3. Source availability probe (§6)

One conservative probe through the existing `SourceRuntimeManager`. Delay, timeout,
retry and cooldown were all left untouched.

```
runtime config: timeout=10000ms retries=2 delay=2000-5000ms cooldown=300000ms
PROBE FAIL  tile=US-EAST-COAST  category=TIMEOUT  latency=33535ms
health: state=COOLDOWN totalRequests=3 successCount=0 failureCount=3
        timeoutCount=3 blockedCount=0 rateLimitedCount=0
        cooldownUntil=2026-08-18T14:31:05.782Z
```

### Block scope diagnosis

The block is total, not endpoint-specific or rate-limit shaped.

| target | result |
|---|---|
| `vesselfinder.com` → `159.69.101.70` | TCP 443 **TIMEOUT** |
| `vesselfinder.com` → `78.47.68.175` | TCP 443 **TIMEOUT** |
| `vesselfinder.com` → `88.99.127.255` | TCP 443 **TIMEOUT** |
| `vesselfinder.com` → `116.202.2.5` | TCP 443 **TIMEOUT** |
| `shipfinder.com` | 200 in 249 ms |
| `marinetraffic.com` | 403 in 115 ms (reachable, anti-bot only) |
| `example.com` | 200 in 101 ms |

DNS resolves correctly and general egress works. **All four advertised VesselFinder
edge IPs are dropped at the packet level from this host.** This is not an HTTP 403,
not a 429, and not a challenge page — the TCP handshake never completes.

Per §7, live requests were stopped. **No** proxy rotation, **no** stealth browser,
**no** User-Agent randomisation, **no** retry escalation.

## 4. Database collections before proof

`soosky_marine_bot_dev` was dropped intentionally, then verified:

```
collections BEFORE proof: (empty)
```

Safety flags: `BOT_DATA_PROOF_MODE=true`, `BOT_AIS_ENABLED=false`,
`PAID_FALLBACK_ENABLED=false`. MyShipTracking provider never constructed → **0 calls**.

## 5–13. Live gate — NOT RUN

| item | result |
|---|---|
| sample size | **0** |
| regions represented | **none** |
| live map metrics | 1 attempt → TIMEOUT → COOLDOWN |
| live detail metrics | **0 requests** (never reached) |
| Cycle 1 matrix | `NOT_RUN` |
| PID 1 / PID 2 | `NOT_RUN` |
| restart persistence | `NOT_RUN` |
| Cycle 2 matrix | `NOT_RUN` |
| regional matrix (§28) | `NOT_RUN` |

No fake vessels were created (§11). The earlier zero-sample artifact
`docs/reports/live-motion-cycle1-2026-08-18T140436235Z.json` remains labeled
**`FAILED_SOURCE_AVAILABILITY`** (§33) and is not presented as motion evidence.

## 14–16. Motion retention

| classification | count |
|---|---|
| RETAINED | N/A |
| EXPIRED_CORRECTLY | N/A |
| **LOST_BUG** | **N/A — unmeasured live** |

`LOST_BUG = 0` is **not** proven by live traffic. It is proven deterministically
(see below), which is weaker evidence than this gate was designed to collect.

## 17–19. What *was* provable — validation of the 3.2 `motionOnly` fix

Run against **real MongoDB** with the real pipeline: 1 detail observation followed
by 5 map-only observations, then resolve.

```
§24 map burst: 1 detail + 5 map-only observations
  POSITION observations stored     : 6

§26 bounded (max 4 per source)
  recent candidates loaded         : 4
  motionOnly candidates loaded     : 1
  bounded?                         : true

§25 motionOnly returns the older detail candidate
  motion candidate has speed       : true
  detail excluded from recent set  : true      <-- top-N bug WOULD have struck

canonical after burst
  coords precise                   : true (51.25 / 1.25)
  motion                           : speed=9.4 course=187 navStatus=0
  motion observedAt / freshness    : 2026-08-18T14:23:54.763Z / LIVE
```

This is the key result of the phase. The burst genuinely pushed the detail
observation out of the newest-4 window — exactly the condition under which the
original bug re-appears — and the motion-bearing query recovered it. Coordinates
still advanced to the newest precise map tile, and `motion.observedAt` kept the
detail observation's own source time.

The equivalent case is also locked into the deterministic suite (6 map refreshes
after a detail page) among the 1091 passing tests.

## 20. Mongo indexes / explain (§27)

```
indexes: _id_ | mmsi_1_type_1_fetchedAt_-1 | imo_1_type_1_fetchedAt_-1
         | source_1_fetchedAt_-1 | fingerprint_1_fetchedAt_-1 | expiresAt_1

motionOnly scan stages : IXSCAN, FETCH
motionOnly index used  : mmsi_1_type_1_fetchedAt_-1
```

The `data.speed / data.course / data.heading / data.navStatus` predicate is a
residual filter applied after `FETCH`. No `COLLSCAN`. **No new index added** —
explain shows no real problem to solve.

## 21. Resource metrics

| checkpoint | RSS | heapUsed |
|---|---|---|
| baseline Node process | 29 MB | 4 MB |
| Cycle 1 / post-restart / Cycle 2 | `NOT_RUN` | `NOT_RUN` |

## 22–23. Final collections and cleanup

```
final collections : canonical_current_vessels, vessel_observations
legacy present    : NONE
live-motion-gate-sample present : false
counts            : observations=8  canonical=1
```

Legacy gate (§16) checked for `latestpositions`, `latestPositions`, `vesselpositions`,
`vesselPositions`, `vessels`, `watchlistitems` → **none present**.

The proof-only `live-motion-gate-sample` collection was never created, because the
live gate stopped before sampling. Nothing to clean up (§31). `vessel_observations`
and `canonical_current_vessels` were not deleted.

## 24. Files changed

None. `git status` is clean — this phase changed no production or test code.

## 25. Architecture audit

| check | result |
|---|---|
| folders reorganised | no |
| new architecture layers | no |
| generic `utils/` `helpers/` `shared/` `common/` | none |
| Redis / queues / new provider / AIS / paid source | none added |
| resolver design (`PositionResolver`, `ResolveCurrentPosition`, motion provenance) | unchanged (§1) |
| stale comments claiming "canonical storage does not exist" / "legacy is active storage" | none remain (§32, fixed in 3.2) |

## 26. Final verdict

### CONDITIONALLY PASS — `SOURCE_UNAVAILABLE`

**Passed**

- clean install, 1091 tests, build
- clean database, only current collections bootstrap
- no legacy collection resurrection
- candidate queries bounded, `motionOnly` retrieval proven on real Mongo
- \>4-map-observation test passes
- AIS off, paid off, architecture unchanged

**Not run (blocks FULL PASS)**

- real VesselFinder map traffic
- real vessel sampling (`sampleSize = 0`)
- real detail requests (`detailRequests = 0`)
- Cycle 1 → restart → persistence check → Cycle 2
- live `LOST_BUG = 0` verification
- live regional matrix

---

## Operational note

This is the **third consecutive phase** blocked by the same cause, and the diagnosis
has now narrowed from "probably rate-limited" to **"all four VesselFinder edge IPs
are dropped at TCP from this host."**

Re-running this gate from this machine will keep returning `SOURCE_UNAVAILABLE`
regardless of how the sample is scoped or how small the volume is. Unblocking it
requires a **change of egress** — a different network, VPN, or a host outside this
IP's block — not another retry.

The runner is ready to execute unchanged from any unblocked network:

```bash
export BOT_DATA_PROOF_MODE=true
export MONGODB_URI="mongodb://127.0.0.1:27017/soosky_marine_bot_dev"
export BOT_AIS_ENABLED=false PAID_FALLBACK_ENABLED=false

npx ts-node scripts/data-proof/liveMotionGate.ts --cycle=1          # PID 1
npx ts-node scripts/data-proof/liveMotionGate.ts --mode=persist-check # PID 2
npx ts-node scripts/data-proof/liveMotionGate.ts --cycle=2
npx ts-node scripts/data-proof/liveMotionGate.ts --mode=report
```
