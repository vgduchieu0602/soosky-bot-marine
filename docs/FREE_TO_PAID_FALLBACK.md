# FREE-FIRST → PAID FALLBACK

Bot-side contract for `LOCAL → FREE CRAWL → PAID API`.

Owner: Soosky-bot-marine. Consumer: Soosky-marine-api.

Status: orchestration implemented and wired for **LOCAL + FREE**. The paid lane
is deliberately **not wired into the composition root** — see §9. Both switches
are off: `PAID_FALLBACK_ENABLED=false`, `INTERNAL_ACQUIRE_TOKEN=` (empty).

---

## 1. Why the fallback is not a `catch`

The shape this replaces:

```ts
// ⛔ never
try { await crawl(mmsi) } catch { await myShipTracking(mmsi) }
```

It fails for reasons that have nothing to do with style:

| Problem | Consequence |
|---|---|
| `catch` cannot tell "vessel does not exist" from "source returned 503" | a 404 spends a credit |
| A parser break throws | one HTML change turns every request into a paid request |
| The rule lives in a controller | nobody can answer "when do we spend money?" without reading route code |
| No cooldown, no capability check | 20 taps on one vessel = 20 credits |

So the decision lives in one Application-layer file,
[GetVesselWithFallback.ts](../src/application/use-cases/vessel/GetVesselWithFallback.ts),
where it is readable and testable, and the HTTP boundary only translates.

---

## 2. Lanes

Three components, each unchanged by this phase:

| Lane | Use case | Cost | Never does |
|---|---|---|---|
| LOCAL | [GetCanonicalVesselDetail](../src/application/use-cases/vessel/GetCanonicalVesselDetail.ts) | 0 | leave the process |
| FREE | [GetOrRefreshVesselDetail](../src/application/use-cases/vessel/GetOrRefreshVesselDetail.ts) | 0 | touch MyShipTracking — permanent rule |
| PAID | [TrackVesselCurrentPosition](../src/application/use-cases/tracking/TrackVesselCurrentPosition.ts) | 1 credit / success | act as an automatic free substitute without the gate |

`GetVesselWithFallback` **orchestrates only**. It contains no crawler, no HTTP
client, no source list. Two structural tests assert the lanes stay separate:
the free lane must not import anything paid, the paid lane must not import the
free lane.

---

## 3. Flow

```
{ mmsi? | imo?, need, allowPaidFallback? }
   │
   ├─ outer single-flight key = `${mmsi}/${imo}|${need}`   ← 10 taps = 1 workflow
   │
   ▼
LOCAL read (canonical, dynamic freshness recomputed)
   │  need satisfied? ──► LOCAL_HIT           0 external requests
   ▼ no
FREE lane (own source selector, 2-source ceiling, own budget, own cooldown)
   │  need satisfied? ──► FREE_UPDATED        0 paid requests
   ▼ no
paid gate: allowed? → capability? → cooldown? → time budget?
   │  any gate closed ──► PARTIAL / NOT_FOUND, with `paidSkipReason`
   ▼ all open
PAID lane (1 credit, own 9-gate check + own single-flight)
   │
   ▼
re-read canonical  ← paid data goes through Observation + Resolver first
   │
   ▼
PAID_UPDATED | PARTIAL | NOT_FOUND
```

There is **no free → paid → free loop**. After the paid lane fails, the flow
returns whatever data exists. A retry loop across lanes is the reliable way to
produce both a hung request and a growing invoice.

### `need`

Two values, because "is this enough?" has two different answers:

| `need` | Satisfied when |
|---|---|
| `POSITION` | POSITION group is `AVAILABLE` (freshness recomputed at read time) |
| `DETAIL` | no group is `MISSING` or `STALE` (`needsRefresh === false`) |

A vessel with a fresh position but no particulars is a `LOCAL_HIT` for
`POSITION` and a miss for `DETAIL`. Merging the two would either crawl for map
pins or return half a detail page.

---

## 4. The four paid gates

Checked in cheapest-first order — never ask "how much time is left?" before
"are we allowed at all?".

| Order | Gate | `paidSkipReason` | Rule |
|---|---|---|---|
| 1 | caller flag | `NOT_ALLOWED` | `allowPaidFallback !== true`. `undefined` is refusal. |
| 2 | group capability | `NO_PAID_CAPABILITY` | outstanding groups ∩ `{POSITION, IDENTITY}` = ∅ |
| 3 | per-vessel cooldown | `COOLDOWN` | `DetailRefreshGate` under key `paid:<mmsi>/<imo>` |
| 4 | total time budget | `BUDGET_EXHAUSTED` | remaining < `minPaidSliceMs` (2 s) |

Plus `NEED_SATISFIED` when local or free already answered, and
`LANE_UNAVAILABLE` when no paid lane is wired into this deployment at all —
which is the state today. `LANE_UNAVAILABLE` is kept distinct from
`NOT_ALLOWED` on purpose: one means "there is a road but the config says no",
the other means "there is no road". Merged, a forgotten adapter would look
exactly like an operational decision.

### Gate 2 in detail — the most important cost barrier

MyShipTracking `response=simple` returns exactly ten fields: `vessel_name`,
`mmsi`, `imo`, `vtype`, `lat`, `lng`, `course`, `speed`, `nav_status`,
`received`.

That covers **POSITION** and the basic part of **IDENTITY**. It contains no
`length`/`beam`/`draught`/`gt`/`dwt`/`built` (PARTICULARS) and no
`destination`/`eta`/port fields (VOYAGE). Those exist only on `extended`
(3 credits), which TRACK-1 deliberately does not call.

So: **PARTICULARS missing + every free source failing ⇒ return partial data.**
Calling a position endpoint and reporting "particulars refreshed" would be both
a wasted credit and a lie about the data. Enforced by
`PAID_CAPABLE_GROUPS = [POSITION, IDENTITY]` and by a test that fails if anyone
adds a group to that list.

### Gate 4 — one budget for the whole flow

`FREE_FALLBACK_TOTAL_TIMEOUT_MS` (15 s) covers local + free + paid together,
not per leg. Per-leg timeouts (10 s free + 10 s paid + …) turn one tap into 30 s
of waiting. The free lane already has its own 10 s ceiling; the remainder is
room for exactly one paid request. Starting a paid request that is certain to be
cut off is the worst available outcome: a credit spent and nobody receives the
result.

---

## 5. Result contract

```ts
{
  status: LOCAL_HIT | FREE_UPDATED | PAID_UPDATED | PARTIAL | NOT_FOUND | UNAVAILABLE,
  sourceUsed: LOCAL | FREE | PAID | NONE,
  need, detail,
  externalAttempted: boolean,   // did anything leave the process?
  dataUpdated: boolean,         // did we actually gain data?
  fallbackUsed: boolean,        // did we reach the paid lane?
  freeAttempts: [{ source, status, durationMs }],
  paidAttempt?: { status, creditCharged? },
  paidSkipReason?: ...,         // absent when the paid lane ran
  remainingMissingGroups, remainingStaleGroups, durationMs
}
```

The three booleans are **deliberately separate**. A single `refreshed` flag
collapsed all three, so `refreshed: true` could mean "we spent a credit and
gained nothing" and nobody could tell. The interesting combination is
`externalAttempted: true, dataUpdated: false, fallbackUsed: true` — money spent,
no data gained — and it now has a name.

`creditCharged` comes from the `x-credit-charged` response header when the
source sends it; absent means the source did not say, never means zero.

`detail` is always the **re-read canonical** projection, never a source
response. A paid position that arrives older than the last AIS frame loses to
AIS in the resolver: paying does not buy the right to overwrite newer data.

Never in the result: raw HTML, source error text, stack traces, API keys.
Asserted by a test.

---

## 6. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PAID_FALLBACK_ENABLED` | `false` | server master switch; only the literal `"true"` enables it |
| `FREE_FALLBACK_TOTAL_TIMEOUT_MS` | `15000` | budget for the whole flow |
| `PAID_FALLBACK_COOLDOWN_MS` | `600000` | rest period after a paid call for one vessel |
| `INTERNAL_ACQUIRE_TOKEN` | *(empty)* | secret for the internal command channel; empty = channel refuses everything |
| `MYSHIPTRACKING_API_KEY` | *(empty)* | paid credential; server-side only, never returned, never logged |

The parse is `=== "true"`, not `!== "false"`. Every typo — `"1"`, `"yes"`,
`"TRUE!"`, empty — must land on OFF. Enabling by typo is an invoice, not a bug.

Two switches must both be on for a paid request: the server's
`PAID_FALLBACK_ENABLED` **and** the caller's `allowPaidFallback`. One
misconfigured line in Marine cannot become Bot's invoice.

---

## 7. Internal command channel

```
POST /internal/vessels/:id/acquire
X-Internal-Token: <INTERNAL_ACQUIRE_TOKEN>
{ "need": "POSITION" | "DETAIL", "allowPaidFallback": false }
```

| Property | Behaviour |
|---|---|
| Mounting | only when `internalAcquire` deps are supplied; otherwise 404 |
| Auth | `X-Internal-Token`, constant-time compare. **Not** `API_KEY` — this channel spends money and must be revocable on its own. Empty configured token rejects everything. |
| Bind | loopback (`HTTP_HOST=127.0.0.1`) or a private network. Never public. |
| Identifier | validated at the edge with the domain validators; junk gets 400 before any lane runs |
| Body | `need` + `allowPaidFallback` only. `source`/`sources`/`provider`/`useMyShipTracking` ⇒ 400 |
| `allowPaidFallback` | must be a boolean; the string `"true"` is a 400, not a yes |
| Rate limit | 3/min per identifier, 120/min for the route, fixed window, bounded key table |
| Timeout | the use case's total budget; the route adds no second timeout |
| Response | the result contract above, plus `paidRequestedButDisabled` |

**Marine never names a source.** If it could, Bot's source list becomes a public
API and swapping a crawler becomes a breaking change for mobile.

**Bot never decides whether a user paid.** Auth, subscription and payment belong
to Marine. Bot only answers "am I allowed to spend a credit on this call?".

---

## 8. Cost measurement

`npm run fallback:cost` runs the real orchestrator with counting doubles for
both lanes and prints the paid calls actually made. It measures the code's
behaviour; the local-miss and free-failure ratios are **inputs**, not findings.

Measured on 2026-08-17, 100 distinct vessels, seed 20260817, simulated clock
advancing 1 s per request:

| Scenario | 100 req | 1 000 req | 10 000 req | credit/req |
|---|---|---|---|---|
| POSITION, 20 % miss, 10 % free failure, **paid OFF** | 0 | 0 | 0 | 0 |
| POSITION, 20 % miss, 10 % free failure, paid ON | 3 | 25 | 197 | ~0.020 |
| POSITION, 20 % miss, **free lane dead**, paid ON | 26 | 186 | 1 764 | ~0.176 |
| DETAIL, only PARTICULARS missing, free dead, paid ON | 0 | 0 | 0 | 0 |

Reading it:

- Row 1 is production today. The switch is off, so the bill is zero regardless
  of traffic. This is the only row that holds without further measurement.
- Row 3 is the worst realistic case: even with every free source dead, the
  per-vessel cooldown keeps paid calls sublinear — 968 of 2 732 free-exhausted
  requests were blocked by cooldown at 10 000 requests.
- Row 4 is gate 2 doing its job: 9 660 requests, 0 credits, because a position
  endpoint has no particulars.

**Not measured yet: the real free-miss ratio.** Getting it requires running the
free lane against live sources and reading `freeExhausted / requests` from
`GetVesselWithFallback.getStats()`. Until that number exists, no
`PAID_FALLBACK_ENABLED=true` in production.

---

## 9. What is wired, and what is not

[createVesselAcquisitionDependencies.ts](../src/bootstrap/createVesselAcquisitionDependencies.ts)
builds `GetCanonicalVesselDetail`, `GetOrRefreshVesselDetail` and
`GetVesselWithFallback`, exposed through `buildContainer()`. Construction is
inert: no crawl, no request, no credit.

`server.ts` mounts the internal channel **only** when `INTERNAL_ACQUIRE_TOKEN`
is non-empty. Empty token ⇒ the route does not exist.

The **paid lane is not constructed**, because `TrackVesselCurrentPosition` needs
two things this repo does not have yet:

1. an adapter implementing `PaidPositionSource` on top of `MyShipTrackingClient`;
2. a credit ledger for `PaidBudgetSnapshot`. The gate treats
   `remainingCalls: null` as a refusal, so a stub ledger would either lie about
   the balance or refuse everything while pretending the lane exists.

Until both exist, the orchestrator answers `paidSkipReason: LANE_UNAVAILABLE`
and serves LOCAL + FREE. That is the honest state, and it is also the safe one.

Gate instances: the free lane and the paid cooldown use **separate**
`DetailRefreshGate` instances, and the orchestrator additionally prefixes its
keys with `paid:`. A free-crawl cooldown must never silence a paid call, and the
reverse. The paid gate uses the same cooldown for failure and success —
retrying quickly after a failed charge is how one broken vessel record becomes
repeat charges.

## 10. Rollout

1. Keep `PAID_FALLBACK_ENABLED=false` and `INTERNAL_ACQUIRE_TOKEN` empty.
2. Set `INTERNAL_ACQUIRE_TOKEN` in a staging environment only; measure
   `freeExhausted / requests` from `getStats()` over a real traffic sample.
3. Re-run `npm run fallback:cost` with the measured ratio; decide a monthly
   credit ceiling from that table.
4. Enable Marine's `USE_BOT_VESSEL_ACQUISITION` for a small subset — see
   [BOT_ACQUISITION_FALLBACK.md](../../soosky-marine-api-clone/docs/BOT_ACQUISITION_FALLBACK.md).
5. Build the paid adapter + credit ledger (§9), then consider
   `PAID_FALLBACK_ENABLED=true`, still per-request.

Not done, deliberately: no production cutover, no scheduler, no bulk or history
MyShipTracking endpoints, no removal of Marine's existing MyShipTracking
adapter.

---

## 11. Related

- [BOT_MARINE_INTEGRATION.md](BOT_MARINE_INTEGRATION.md) — field-level contract matrices
- [GetVesselWithFallback.test.ts](../src/application/use-cases/vessel/GetVesselWithFallback.test.ts) — 23 tests, cost gates included
- [internalAcquireRoute.test.ts](../src/interfaces/http/internalAcquireRoute.test.ts) — 14 tests on the boundary
- [fallbackCostSim.ts](../src/interfaces/cli/fallbackCostSim.ts) — `npm run fallback:cost`
