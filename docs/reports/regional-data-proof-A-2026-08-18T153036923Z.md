# REGIONAL-DATA-PROOF-1 — Stage A

- Database: `soosky_marine_bot_dev` · AIS **off** · paid fallback **off** · MyShipTracking calls **0**
- Duration: 1001615 ms · vessels: 90
- Sample: US=30 UK=30 NORWAY=30 (unique MMSI 90)
- Stage B eligible: **no** (severe blocks: 5, cooldown waits: 1, stopped lanes: shipinfo)

## VESSELBASICS COVERAGE — canonical, by region (§29)

| FIELD | US | UK | NORWAY | ALL |
|---|---:|---:|---:|---:|
| vesselName | 63.3% | 100% | 100% | 87.8% |
| mmsi | 100% | 100% | 100% | 100% |
| imo | 6.7% | 36.7% | 16.7% | 20% |
| vType | 20% | 93.3% | 100% | 71.1% |
| lat | 63.3% | 93.3% | 100% | 85.6% |
| lon | 63.3% | 93.3% | 100% | 85.6% |
| latLon | 63.3% | 93.3% | 100% | 85.6% |
| course | 0% | 26.7% | 36.7% | 21.1% |
| speed | 10% | 30% | 36.7% | 25.6% |
| navStatus | 0% | 26.7% | 16.7% | 14.4% |
| received | 10% | 30% | 36.7% | 25.6% |

## PROVIDER MATRIX — observations per source (§30)

| FIELD | vesselfinder | shipfinder | shipinfo | combined |
|---|---:|---:|---:|---:|
| vesselName | 86.7% | 64.4% | 4.4% | 87.8% |
| mmsi | 100% | 100% | 100% | 100% |
| imo | 14.4% | 17.8% | 2.2% | 20% |
| vType | 54.4% | 64.4% | 2.2% | 71.1% |
| lat | 86.7% | 0% | 4.4% | 85.6% |
| lon | 86.7% | 0% | 4.4% | 85.6% |
| latLon | 86.7% | 0% | 4.4% | 85.6% |
| course | 35.6% | 0% | 0% | 21.1% |
| speed | 44.4% | 0% | 4.4% | 25.6% |
| navStatus | 20% | 0% | 0% | 14.4% |
| received | 44.4% | 0% | 4.4% | 25.6% |

### US

| FIELD | vesselfinder | shipfinder | shipinfo | combined |
|---|---:|---:|---:|---:|
| vesselName | 66.7% | 0% | 13.3% | 63.3% |
| mmsi | 100% | 100% | 100% | 100% |
| imo | 0% | 0% | 6.7% | 6.7% |
| vType | 16.7% | 0% | 6.7% | 20% |
| lat | 66.7% | 0% | 13.3% | 63.3% |
| lon | 66.7% | 0% | 13.3% | 63.3% |
| latLon | 66.7% | 0% | 13.3% | 63.3% |
| course | 3.3% | 0% | 0% | 0% |
| speed | 6.7% | 0% | 13.3% | 10% |
| navStatus | 0% | 0% | 0% | 0% |
| received | 6.7% | 0% | 13.3% | 10% |

### UK

| FIELD | vesselfinder | shipfinder | shipinfo | combined |
|---|---:|---:|---:|---:|
| vesselName | 93.3% | 93.3% | 0% | 100% |
| mmsi | 100% | 100% | 100% | 100% |
| imo | 26.7% | 36.7% | 0% | 36.7% |
| vType | 46.7% | 93.3% | 0% | 93.3% |
| lat | 93.3% | 0% | 0% | 93.3% |
| lon | 93.3% | 0% | 0% | 93.3% |
| latLon | 93.3% | 0% | 0% | 93.3% |
| course | 36.7% | 0% | 0% | 26.7% |
| speed | 43.3% | 0% | 0% | 30% |
| navStatus | 33.3% | 0% | 0% | 26.7% |
| received | 43.3% | 0% | 0% | 30% |

### NORWAY

| FIELD | vesselfinder | shipfinder | shipinfo | combined |
|---|---:|---:|---:|---:|
| vesselName | 100% | 100% | 0% | 100% |
| mmsi | 100% | 100% | 100% | 100% |
| imo | 16.7% | 16.7% | 0% | 16.7% |
| vType | 100% | 100% | 0% | 100% |
| lat | 100% | 0% | 0% | 100% |
| lon | 100% | 0% | 0% | 100% |
| latLon | 100% | 0% | 0% | 100% |
| course | 66.7% | 0% | 0% | 36.7% |
| speed | 83.3% | 0% | 0% | 36.7% |
| navStatus | 26.7% | 0% | 0% | 16.7% |
| received | 83.3% | 0% | 0% | 36.7% |

## Classification — canonical, all regions (§31)

| FIELD | covered | sample | pct | class |
|---|---:|---:|---:|---|
| vesselName | 79 | 90 | 87.8% | USABLE |
| mmsi | 90 | 90 | 100% | GOOD |
| imo | 18 | 90 | 20% | VERY_WEAK |
| vType | 64 | 90 | 71.1% | USABLE |
| lat | 77 | 90 | 85.6% | USABLE |
| lon | 77 | 90 | 85.6% | USABLE |
| latLon | 77 | 90 | 85.6% | USABLE |
| course | 19 | 90 | 21.1% | VERY_WEAK |
| speed | 23 | 90 | 25.6% | VERY_WEAK |
| navStatus | 13 | 90 | 14.4% | VERY_WEAK |
| received | 23 | 90 | 25.6% | VERY_WEAK |

## Request metrics (§25)

| scope | req | 200 | 3xx | 403 | 404 | 429 | 5xx | timeout | net | parse | notFound | avg ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| discovery/US | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1833 | 3022 |
| discovery/UK | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2987 | 4795 |
| discovery/NORWAY | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3132 | 4766 |
| US/vesselfinder | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3556 | 5129 |
| UK/vesselfinder | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3473 | 5498 |
| NORWAY/vesselfinder | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3632 | 5612 |
| ALL/vesselfinder | 90 | 90 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3554 | 5405 |
| US/shipfinder | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5649 | 7914 |
| UK/shipfinder | 30 | 29 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 5339 | 7882 |
| NORWAY/shipfinder | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5510 | 7484 |
| ALL/shipfinder | 90 | 89 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 5499 | 7882 |
| US/shipinfo | 15 | 10 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5008 | 7769 |
| UK/shipinfo | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — | — |
| NORWAY/shipinfo | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — | — |
| ALL/shipinfo | 15 | 10 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5008 | 7769 |

> HTTP 404 is folded into `notFound` by the shared crawl runtime, which classifies
> both a 404 and a provider-returned `null` as `NOT_FOUND`.

## Source health — crawl runtime counters

```json
{
  "vesselfinder": {
    "source": "vesselfinder",
    "state": "HEALTHY",
    "totalRequests": 99,
    "successCount": 99,
    "failureCount": 0,
    "consecutiveFailures": 0,
    "notFoundCount": 0,
    "timeoutCount": 0,
    "blockedCount": 0,
    "rateLimitedCount": 0,
    "serverErrorCount": 0,
    "networkErrorCount": 0,
    "parseErrorCount": 0,
    "unknownErrorCount": 0,
    "lastSuccessAt": "2026-08-18T15:19:39.716Z",
    "averageLatencyMs": 3466.050505050505
  },
  "shipfinder": {
    "source": "shipfinder",
    "state": "HEALTHY",
    "totalRequests": 90,
    "successCount": 89,
    "failureCount": 0,
    "consecutiveFailures": 0,
    "notFoundCount": 1,
    "timeoutCount": 0,
    "blockedCount": 0,
    "rateLimitedCount": 0,
    "serverErrorCount": 0,
    "networkErrorCount": 0,
    "parseErrorCount": 0,
    "unknownErrorCount": 0,
    "lastSuccessAt": "2026-08-18T15:22:34.782Z",
    "averageLatencyMs": 5504.595505617977
  },
  "shipinfo": {
    "source": "shipinfo",
    "state": "DEGRADED",
    "totalRequests": 15,
    "successCount": 10,
    "failureCount": 5,
    "consecutiveFailures": 2,
    "notFoundCount": 0,
    "timeoutCount": 0,
    "blockedCount": 5,
    "rateLimitedCount": 0,
    "serverErrorCount": 0,
    "networkErrorCount": 0,
    "parseErrorCount": 0,
    "unknownErrorCount": 0,
    "lastSuccessAt": "2026-08-18T15:30:25.708Z",
    "lastFailureAt": "2026-08-18T15:30:36.013Z",
    "averageLatencyMs": 5012.6
  }
}
```

## Timestamp derivation (§21)

```json
{
  "vesselfinder": {
    "ABSOLUTE_SOURCE_TIME": 0,
    "RELATIVE_SOURCE_AGE": 40,
    "NO_SOURCE_TIME": 50
  },
  "shipfinder": {
    "ABSOLUTE_SOURCE_TIME": 0,
    "RELATIVE_SOURCE_AGE": 0,
    "NO_SOURCE_TIME": 90
  },
  "shipinfo": {
    "ABSOLUTE_SOURCE_TIME": 4,
    "RELATIVE_SOURCE_AGE": 0,
    "NO_SOURCE_TIME": 86
  },
  "canonical": {
    "ABSOLUTE_SOURCE_TIME": 3,
    "RELATIVE_SOURCE_AGE": 20,
    "NO_SOURCE_TIME": 67
  }
}
```

## Database proof (§27)

```json
{
  "database": "soosky_marine_bot_dev",
  "vessel_observations": 1590,
  "canonical_current_vessels": 80,
  "canonicalWithPosition": 78,
  "canonicalWithIdentity": 80,
  "canonicalWithParticulars": 65,
  "canonicalWithVoyage": 21,
  "sampledVessels": {
    "mmsiCount": 90,
    "vessel_observations": 438,
    "canonical_current_vessels": 79,
    "canonicalWithPosition": 77,
    "canonicalWithIdentity": 79,
    "canonicalWithParticulars": 64,
    "canonicalWithVoyage": 21
  },
  "observationsBySourceAndType": [
    {
      "source": "vesselfinder",
      "type": "POSITION",
      "count": 825
    },
    {
      "source": "vesselfinder",
      "type": "IDENTITY",
      "count": 568
    },
    {
      "source": "shipfinder",
      "type": "PARTICULARS",
      "count": 58
    },
    {
      "source": "shipfinder",
      "type": "IDENTITY",
      "count": 58
    },
    {
      "source": "vesselfinder",
      "type": "PARTICULARS",
      "count": 51
    },
    {
      "source": "shipfinder",
      "type": "VOYAGE",
      "count": 21
    },
    {
      "source": "shipinfo",
      "type": "POSITION",
      "count": 4
    },
    {
      "source": "shipinfo",
      "type": "IDENTITY",
      "count": 4
    },
    {
      "source": "shipinfo",
      "type": "PARTICULARS",
      "count": 1
    }
  ]
}
```

## Operational (§32)

```json
{
  "durationMs": 1001615,
  "totalRequests": 399,
  "vessels": 90,
  "requestsPerVessel": 4.43,
  "vesselsPerMinute": 5.4,
  "peakRssMb": 510,
  "peakHeapUsedMb": 418,
  "cpuUserMs": 6141,
  "cpuSystemMs": 1797
}
```

## Canonical samples (§28)

```json
{
  "US": [
    {
      "region": "US",
      "subRegion": "US-EAST-COAST",
      "mmsi": "367022790",
      "imo": null,
      "vesselName": "QUENAMES",
      "vesselType": "Tug",
      "lat": 40.531075,
      "lon": -74.25169166666667,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:19:47.372Z"
    },
    {
      "region": "US",
      "subRegion": "US-EAST-COAST",
      "mmsi": "338417325",
      "imo": null,
      "vesselName": "PROKAT28",
      "vesselType": "Pleasure craft",
      "lat": 40.55417166666667,
      "lon": -74.25603833333334,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:19:47.395Z"
    },
    {
      "region": "US",
      "subRegion": "US-EAST-COAST",
      "mmsi": "368119660",
      "imo": null,
      "vesselName": "CHARLESTON",
      "vesselType": "Local type",
      "lat": 40.49666,
      "lon": -74.25842166666666,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:19:47.404Z"
    },
    {
      "region": "US",
      "subRegion": "US-EAST-COAST",
      "mmsi": "369230000",
      "imo": null,
      "vesselName": "PHILADELPHIA",
      "vesselType": null,
      "lat": 40.49171333333334,
      "lon": -74.25492666666666,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:30:36.051Z"
    },
    {
      "region": "US",
      "subRegion": "US-EAST-COAST",
      "mmsi": "368327980",
      "imo": null,
      "vesselName": "HENRY GIRLS",
      "vesselType": null,
      "lat": 40.539051666666666,
      "lon": -74.25416833333334,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:30:36.068Z"
    }
  ],
  "UK": [
    {
      "region": "UK",
      "subRegion": "UK-ENGLISH-CHANNEL",
      "mmsi": "244181179",
      "imo": null,
      "vesselName": "LAAXUM",
      "vesselType": "Pleasure craft",
      "lat": 50.80009833333333,
      "lon": 0.9599683333333333,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:19:47.432Z"
    },
    {
      "region": "UK",
      "subRegion": "UK-ENGLISH-CHANNEL",
      "mmsi": "235101095",
      "imo": null,
      "vesselName": "RNLI LIFEBOAT 13-02",
      "vesselType": "SAR",
      "lat": 50.92648833333333,
      "lon": 0.9764983333333334,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:18:46.746Z"
    },
    {
      "region": "UK",
      "subRegion": "UK-ENGLISH-CHANNEL",
      "mmsi": "232215000",
      "imo": "9151553",
      "vesselName": "SAND FALCON",
      "vesselType": "Dredging or UW ops",
      "lat": 50.898316666666666,
      "lon": 1.008115,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:19:47.447Z"
    },
    {
      "region": "UK",
      "subRegion": "UK-ENGLISH-CHANNEL",
      "mmsi": "235052005",
      "imo": null,
      "vesselName": "JOSEPHINE",
      "vesselType": "Sailing",
      "lat": 50.986705,
      "lon": 1.0261333333333333,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:30:36.215Z"
    },
    {
      "region": "UK",
      "subRegion": "UK-ENGLISH-CHANNEL",
      "mmsi": "244900007",
      "imo": null,
      "vesselName": "ALCESTE",
      "vesselType": "Pleasure craft",
      "lat": 50.91515833333333,
      "lon": 1.0750333333333333,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:30:36.216Z"
    }
  ],
  "NORWAY": [
    {
      "region": "NORWAY",
      "subRegion": "NO-OSLOFJORD",
      "mmsi": "258083180",
      "imo": null,
      "vesselName": "DELIGHT",
      "vesselType": "Pleasure craft",
      "lat": 59.73097833333333,
      "lon": 10.300258333333334,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:21:22.316Z"
    },
    {
      "region": "NORWAY",
      "subRegion": "NO-OSLOFJORD",
      "mmsi": "257777000",
      "imo": null,
      "vesselName": "NIRO",
      "vesselType": "Pleasure craft",
      "lat": 59.61985,
      "lon": 10.410396666666667,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:21:22.340Z"
    },
    {
      "region": "NORWAY",
      "subRegion": "NO-OSLOFJORD",
      "mmsi": "258220920",
      "imo": null,
      "vesselName": "BORGEZIN",
      "vesselType": "Sailing vessel",
      "lat": 59.606335,
      "lon": 10.411201666666667,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:21:22.350Z"
    },
    {
      "region": "NORWAY",
      "subRegion": "NO-OSLOFJORD",
      "mmsi": "259023490",
      "imo": null,
      "vesselName": "MORMORA",
      "vesselType": "Pleasure craft",
      "lat": 59.62352666666666,
      "lon": 10.439618333333334,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:30:36.407Z"
    },
    {
      "region": "NORWAY",
      "subRegion": "NO-OSLOFJORD",
      "mmsi": "257168500",
      "imo": null,
      "vesselName": "ARMANKA II",
      "vesselType": "Pleasure craft",
      "lat": 59.835766666666665,
      "lon": 10.479406666666666,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T15:30:36.408Z"
    }
  ]
}
```