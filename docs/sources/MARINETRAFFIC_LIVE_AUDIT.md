# MARINETRAFFIC.LIVE AUDIT — `https://marinetraffic.live/`

**Audited:** 2026-08-18 · **Phase:** 4 (all map sources VesselBasics proof)
**Status:** `NOT_USABLE` — Cloudflare interactive challenge on the document root
**Provider code written:** none (§11 forbids implementing an unusable source)

---

## 1. Live probe result

Ordinary `GET` with a browser-like User-Agent and `Accept: text/html`:

```
status  : 403
server  : cloudflare
cf-ray  : a2d2313268be0540-HKG
bytes   : 5537
latency : 138 ms
```

Response body is the Cloudflare interstitial:

```html
<title>Just a moment...</title>
<meta http-equiv="content-security-policy"
      content="... script-src 'nonce-…' 'unsafe-eval' https://challenges.cloudflare.com; …
               frame-src 'self' https://challenges.cloudflare.com blob:; …">
```

Markers present in the body: `cloudflare`, `challenge`, `Just a moment`.

The host is reachable and fast — this is an **anti-bot challenge**, not an
outage and not a network block.

## 2. Why the audit stopped here

Getting past this page requires executing the Cloudflare challenge in a browser
runtime (or replaying a solved clearance cookie). Phase 4 §4 forbids:

- browser stealth
- captcha bypass
- signature reverse-engineering
- private authenticated endpoints

Solving or evading the challenge falls squarely inside those prohibitions, so no
further requests were made. In particular **no attempt** was made to enumerate
map/XHR endpoints behind the challenge, because reaching them requires the
prohibited step first.

Per §10, the fact that the public UI visibly shows vessel data was **not**
treated as evidence that an unauthenticated area-scan endpoint is reusable. It
was not proven, therefore it is not claimed.

## 3. Classification

| question | answer |
|---|---|
| Area/bbox scan available? | **not determinable** — challenge blocks the document |
| MMSI lookup available? | **not determinable** |
| VesselBasics fields obtainable? | **none** |
| Position freshness | not measurable |
| Request cost | not measurable |
| Requires authentication? | not reached; challenge precedes any auth question |
| Operationally usable now? | **no** |

**Source status (§5): `NOT_USABLE`**

Note this is a *different* failure mode from VesselFinder's. VesselFinder is
dropped at TCP from this egress (packet-level). MarineTraffic.live answers
instantly at HTTP level and then demands an interactive challenge.

## 4. If this source is wanted later

Options that stay inside the rules:

1. Ask the operator for documented API access or a crawl allowance.
2. Check whether a published/licensed feed exists.

An automated challenge-solving path is **not** a legitimate option and is not
recommended.
