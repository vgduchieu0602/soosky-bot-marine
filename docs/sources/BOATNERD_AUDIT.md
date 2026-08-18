# BOATNERD AUDIT — `https://ais.boatnerd.com/`

**Audited:** 2026-08-18 · **Phase:** 4 (all map sources VesselBasics proof)
**Status:** `NOT_USABLE` — API key required on every vessel endpoint
**Provider code written:** none (§11 forbids implementing an unusable source)

---

## 1. What the site is

`ais.boatnerd.com` is a JavaScript single-page application (Vite build, React +
MapLibre GL). The root document is 1001 bytes and contains no vessel data at all:

```html
<title>BoatNerd Map</title>
<script type="module" crossorigin src="/assets/index.382b0c02.js"></script>
<div id="root"></div>
```

All data is fetched at runtime by the bundle. There is no server-rendered HTML
to parse and no embedded bootstrap JSON.

## 2. Data path found

From the application bundle (2,314,453 bytes), the API base is same-origin:

```js
API_BASE_URL = "/api/v1"
```

Vessel-related endpoints referenced by the bundle:

```
${API_BASE_URL}/vessels
${API_BASE_URL}/vessels/search
${API_BASE_URL}/fleets
${API_BASE_URL}/fleets/with-vessels
${API_BASE_URL}/fleets/{id}/vessels
${API_BASE_URL}/fleets/vessels/mmsis
```

Map layers referenced: `vessels-source`, `vessels-icon-layer`,
`vessels-label-layer`, `vessel-symbol-layer` — consistent with a bbox/tile vessel
feed. Weather tiles are served from `/api/v1/tiles/{layer}/{z}/{x}/{y}.png`.

The bundle also loads Firebase auth and Google reCAPTCHA
(`https://www.google.com/recaptcha/enterprise.js`), and fleet calls are wrapped
in `getAuthHeaders()`.

## 3. Live probe result

Three unauthenticated requests, ordinary `GET`, browser-like User-Agent and
`Referer: https://ais.boatnerd.com/`:

| endpoint | status | body |
|---|---:|---|
| `/api/v1/vessels` | **401** | `{"success":false,"message":"Invalid or missing API key"}` |
| `/api/v1/vessels/search?q=algoma` | **401** | same |
| `/api/v1/vessels?bbox=-92,41,-76,49` | **401** | same |

Latency 270–735 ms, `content-type: application/json`. The endpoint exists and
responds; it simply refuses unkeyed callers.

## 4. Why the audit stopped here

The API key used by the public web app is present inside the JavaScript bundle.
Extracting it and replaying it would mean **using a credential to reach a private
authenticated endpoint**, which Phase 4 §4 explicitly forbids alongside stealth
browsers, captcha bypass and signature reverse-engineering.

No attempt was made to extract, derive or replay any key.

## 5. Classification

| question | answer |
|---|---|
| Area/bbox scan available? | endpoint exists but is **key-gated** |
| MMSI lookup available? | `/vessels/search` exists but is **key-gated** |
| VesselBasics fields obtainable? | **none** without a key |
| Position freshness | not measurable |
| Request cost | not measurable |
| Requires authentication? | **yes — API key** |
| Operationally usable now? | **no** |

**Source status (§5): `NOT_USABLE`**

## 6. Geographic scope note (§9)

BoatNerd is a Great Lakes / St. Lawrence Seaway community project. Its public
material and map framing are region-specific. **Geographic coverage could not be
measured** because no vessel data was retrievable — so no global claim, and no
regional claim, is made here from data. Documentation alone is explicitly not
treated as confirmation (§9).

## 7. If this source is wanted later

The legitimate route is to request API access from BoatNerd and configure a key
as operator-supplied configuration — the same pattern already used for
`MYSHIPTRACKING_API_KEY`. That is a business/licensing decision, not a crawling
one. Until then this source contributes **nothing** to VesselBasics resilience.
