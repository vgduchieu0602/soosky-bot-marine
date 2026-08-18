# PHASE 6 — ADAPTIVE REGION SCHEDULER + ATLAS PROOF

- Mongo: **ATLAS** / `soosky_marine_bot_dev` · host `***.rfyiyqt.mongodb.net:27017`
- AIS **OFF** · paid **OFF** · region scan concurrency **1** · VesselFinder request concurrency **1**

## Atlas collections (§34)

```
canonical_current_vessels, crawl_region_states, vessel_observations
```
Legacy collections present: **NONE**

## Atlas counts (§35)

```json
{
  "vessel_observations": 59,
  "canonical_current_vessels": 19,
  "crawl_region_states": 2,
  "canonicalWith": {
    "name": 19,
    "mmsi": 19,
    "latLon": 10,
    "speed": 10,
    "course": 8,
    "navStatus": 6,
    "vType": 0,
    "motionObservedAt": 10
  }
}
```

## Region table (§56)

| REGION | TIER | LAST COUNT | AVG COUNT | EMPTY STREAK | LAST SCAN | NEXT SCAN | INTERVAL |
|---|---|---:|---:|---:|---|---|---:|
| no-oslofjord | MEDIUM | — | — | 0 | — | 2026-08-18T19:29:55.340Z | 56m |
| uk-english-channel | HIGH | — | — | 0 | — | 2026-08-18T19:28:52.650Z | 12m |

## Canonical samples (§36)

```json
[
  {
    "mmsi": "368119660",
    "name": "CHARLESTON",
    "vType": null,
    "lat": 40.6403,
    "lon": -74.0476,
    "speed": 0.1,
    "course": 61,
    "navStatus": "At anchor",
    "observedAt": "2026-08-18T19:22:44.000Z"
  },
  {
    "mmsi": "367022790",
    "name": "QUENAMES",
    "vType": null,
    "lat": 40.531083333333335,
    "lon": -74.25165,
    "speed": 0,
    "course": 265.5,
    "navStatus": "Under way using engine",
    "observedAt": "2026-08-18T19:22:51.000Z"
  },
  {
    "mmsi": "338417325",
    "name": "PROKAT28",
    "vType": null,
    "lat": 40.55416666666667,
    "lon": -74.25605,
    "speed": 0,
    "course": 0,
    "navStatus": null,
    "observedAt": "2026-08-18T16:08:12.000Z"
  },
  {
    "mmsi": "232215000",
    "name": "SAND FALCON",
    "vType": null,
    "lat": 51.27165,
    "lon": 1.68925,
    "speed": 6.5,
    "course": 193.2,
    "navStatus": "Under way using engine",
    "observedAt": "2026-08-18T19:24:44.000Z"
  },
  {
    "mmsi": "235101095",
    "name": "RNLI LIFEBOAT 1302",
    "vType": null,
    "lat": 50.92648333333333,
    "lon": 0.97645,
    "speed": 0,
    "course": null,
    "navStatus": "Under way using engine",
    "observedAt": "2026-08-18T11:18:19.000Z"
  }
]
```