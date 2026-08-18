# REGIONAL-DATA-PROOF-1 — Stage A

- Database: `soosky_marine_bot_dev` · AIS **off** · paid fallback **off** · MyShipTracking calls **0**
- Duration: 533293 ms · vessels: 90
- Sample: US=30 UK=30 NORWAY=30 (unique MMSI 90)
- Stage B eligible: **no** (severe blocks: 3)

## VESSELBASICS COVERAGE — canonical, by region (§29)

| FIELD | US | UK | NORWAY | ALL |
|---|---:|---:|---:|---:|
| vesselName | 100% | 100% | 100% | 100% |
| mmsi | 100% | 100% | 100% | 100% |
| imo | 33.3% | 56.7% | 6.7% | 32.2% |
| vType | 93.3% | 96.7% | 96.7% | 95.6% |
| lat | 100% | 100% | 100% | 100% |
| lon | 100% | 100% | 100% | 100% |
| latLon | 100% | 100% | 100% | 100% |
| course | 73.3% | 43.3% | 0% | 38.9% |
| speed | 100% | 50% | 0% | 50% |
| navStatus | 63.3% | 23.3% | 0% | 28.9% |
| received | 13.3% | 0% | 0% | 4.4% |

## PROVIDER MATRIX — observations per source (§30)

| FIELD | vesselfinder | shipfinder | shipinfo | combined |
|---|---:|---:|---:|---:|
| vesselName | 100% | 98.9% | 4.4% | 100% |
| mmsi | 100% | 100% | 100% | 100% |
| imo | 16.7% | 31.1% | 2.2% | 32.2% |
| vType | 47.8% | 95.6% | 1.1% | 95.6% |
| lat | 100% | 0% | 4.4% | 100% |
| lon | 100% | 0% | 4.4% | 100% |
| latLon | 100% | 0% | 4.4% | 100% |
| course | 40% | 0% | 3.3% | 38.9% |
| speed | 50% | 0% | 4.4% | 50% |
| navStatus | 32.2% | 0% | 0% | 28.9% |
| received | 50% | 0% | 4.4% | 4.4% |

### US

| FIELD | vesselfinder | shipfinder | shipinfo | combined |
|---|---:|---:|---:|---:|
| vesselName | 100% | 100% | 13.3% | 100% |
| mmsi | 100% | 100% | 100% | 100% |
| imo | 30% | 30% | 6.7% | 33.3% |
| vType | 93.3% | 96.7% | 3.3% | 93.3% |
| lat | 100% | 0% | 13.3% | 100% |
| lon | 100% | 0% | 13.3% | 100% |
| latLon | 100% | 0% | 13.3% | 100% |
| course | 76.7% | 0% | 10% | 73.3% |
| speed | 100% | 0% | 13.3% | 100% |
| navStatus | 73.3% | 0% | 0% | 63.3% |
| received | 100% | 0% | 13.3% | 13.3% |

### UK

| FIELD | vesselfinder | shipfinder | shipinfo | combined |
|---|---:|---:|---:|---:|
| vesselName | 100% | 96.7% | 0% | 100% |
| mmsi | 100% | 100% | 100% | 100% |
| imo | 20% | 56.7% | 0% | 56.7% |
| vType | 50% | 93.3% | 0% | 96.7% |
| lat | 100% | 0% | 0% | 100% |
| lon | 100% | 0% | 0% | 100% |
| latLon | 100% | 0% | 0% | 100% |
| course | 43.3% | 0% | 0% | 43.3% |
| speed | 50% | 0% | 0% | 50% |
| navStatus | 23.3% | 0% | 0% | 23.3% |
| received | 50% | 0% | 0% | 0% |

### NORWAY

| FIELD | vesselfinder | shipfinder | shipinfo | combined |
|---|---:|---:|---:|---:|
| vesselName | 100% | 100% | 0% | 100% |
| mmsi | 100% | 100% | 100% | 100% |
| imo | 0% | 6.7% | 0% | 6.7% |
| vType | 0% | 96.7% | 0% | 96.7% |
| lat | 100% | 0% | 0% | 100% |
| lon | 100% | 0% | 0% | 100% |
| latLon | 100% | 0% | 0% | 100% |
| course | 0% | 0% | 0% | 0% |
| speed | 0% | 0% | 0% | 0% |
| navStatus | 0% | 0% | 0% | 0% |
| received | 0% | 0% | 0% | 0% |

## Classification — canonical, all regions (§31)

| FIELD | covered | sample | pct | class |
|---|---:|---:|---:|---|
| vesselName | 90 | 90 | 100% | GOOD |
| mmsi | 90 | 90 | 100% | GOOD |
| imo | 29 | 90 | 32.2% | WEAK |
| vType | 86 | 90 | 95.6% | GOOD |
| lat | 90 | 90 | 100% | GOOD |
| lon | 90 | 90 | 100% | GOOD |
| latLon | 90 | 90 | 100% | GOOD |
| course | 35 | 90 | 38.9% | WEAK |
| speed | 45 | 90 | 50% | WEAK |
| navStatus | 26 | 90 | 28.9% | VERY_WEAK |
| received | 4 | 90 | 4.4% | VERY_WEAK |

## Request metrics (§25)

| scope | req | 200 | 3xx | 403 | 404 | 429 | 5xx | timeout | net | parse | notFound | avg ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| discovery/US | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3069 | 4929 |
| discovery/UK | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4028 | 4852 |
| discovery/NORWAY | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3249 | 5287 |
| US/vesselfinder | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6726 | 9609 |
| UK/vesselfinder | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 7322 | 9478 |
| NORWAY/vesselfinder | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — | — |
| ALL/vesselfinder | 45 | 45 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6925 | 9565 |
| US/shipfinder | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5594 | 7680 |
| UK/shipfinder | 30 | 29 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 5135 | 7566 |
| NORWAY/shipfinder | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5965 | 7810 |
| ALL/shipfinder | 90 | 89 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 5565 | 7724 |
| US/shipinfo | 8 | 5 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4549 | 8178 |
| UK/shipinfo | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — | — |
| NORWAY/shipinfo | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — | — |
| ALL/shipinfo | 8 | 5 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4549 | 8178 |
| ALL/vesselfinder-timestamp-probe | 45 | 45 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6986 | 9325 |

> HTTP 404 is folded into `notFound` by the shared crawl runtime, which classifies
> both a 404 and a provider-returned `null` as `NOT_FOUND`.

## Timestamp derivation (§21)

```json
{
  "vesselfinder": {
    "ABSOLUTE_SOURCE_TIME": 0,
    "RELATIVE_SOURCE_AGE": 45,
    "NO_SOURCE_TIME": 45
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
    "ABSOLUTE_SOURCE_TIME": 4,
    "RELATIVE_SOURCE_AGE": 0,
    "NO_SOURCE_TIME": 86
  }
}
```

## Database proof (§27)

```json
{
  "database": "soosky_marine_bot_dev",
  "vessel_observations": 6819,
  "canonical_current_vessels": 2379,
  "canonicalWithPosition": 2379,
  "canonicalWithIdentity": 2379,
  "canonicalWithParticulars": 118,
  "canonicalWithVoyage": 63,
  "sampledVessels": {
    "mmsiCount": 90,
    "vessel_observations": 580,
    "canonical_current_vessels": 90,
    "canonicalWithPosition": 90,
    "canonicalWithIdentity": 90,
    "canonicalWithParticulars": 89,
    "canonicalWithVoyage": 45
  },
  "observationsBySourceAndType": [
    {
      "source": "vesselfinder",
      "type": "POSITION",
      "count": 3448
    },
    {
      "source": "vesselfinder",
      "type": "IDENTITY",
      "count": 3008
    },
    {
      "source": "shipfinder",
      "type": "IDENTITY",
      "count": 119
    },
    {
      "source": "shipfinder",
      "type": "PARTICULARS",
      "count": 116
    },
    {
      "source": "shipfinder",
      "type": "VOYAGE",
      "count": 63
    },
    {
      "source": "vesselfinder",
      "type": "PARTICULARS",
      "count": 47
    },
    {
      "source": "shipinfo",
      "type": "IDENTITY",
      "count": 9
    },
    {
      "source": "shipinfo",
      "type": "POSITION",
      "count": 9
    }
  ]
}
```

## Operational (§32)

```json
{
  "durationMs": 533293,
  "totalRequests": 340,
  "vessels": 90,
  "requestsPerVessel": 3.78,
  "vesselsPerMinute": 10.1,
  "peakRssMb": 505,
  "peakHeapUsedMb": 411,
  "cpuUserMs": 5235,
  "cpuSystemMs": 1016
}
```

## Canonical samples (§28)

```json
{
  "US": [
    {
      "region": "US",
      "subRegion": "US-EAST-COAST",
      "mmsi": "368393930",
      "imo": "990930",
      "vesselName": "CORNUCOPIA MAJESTY",
      "vesselType": "Passenger",
      "lat": 40.50542,
      "lon": -74.28575,
      "course": null,
      "speed": 0,
      "navStatus": null,
      "observedAt": "2026-08-17T19:43:24.000Z",
      "positionSource": "shipinfo",
      "positionFreshness": "STALE",
      "resolvedAt": "2026-08-18T11:13:05.386Z"
    },
    {
      "region": "US",
      "subRegion": "US-EAST-COAST",
      "mmsi": "367022790",
      "imo": "0",
      "vesselName": "QUENAMES",
      "vesselType": "Tug",
      "lat": 41.11581,
      "lon": -72.71064,
      "course": 251,
      "speed": 7.6,
      "navStatus": null,
      "observedAt": "2026-08-17T19:44:31.000Z",
      "positionSource": "shipinfo",
      "positionFreshness": "STALE",
      "resolvedAt": "2026-08-18T11:13:05.385Z"
    },
    {
      "region": "US",
      "subRegion": "US-EAST-COAST",
      "mmsi": "338417325",
      "imo": null,
      "vesselName": "PROKAT28",
      "vesselType": "Pleasure craft",
      "lat": 41,
      "lon": -74,
      "course": 360,
      "speed": 0,
      "navStatus": "-",
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T11:13:05.386Z"
    },
    {
      "region": "US",
      "subRegion": "US-EAST-COAST",
      "mmsi": "369230000",
      "imo": "9819428",
      "vesselName": "PHILADELPHIA",
      "vesselType": "Tug",
      "lat": 40.66715,
      "lon": -74.00788,
      "course": 19,
      "speed": 0,
      "navStatus": null,
      "observedAt": "2026-08-17T19:44:31.000Z",
      "positionSource": "shipinfo",
      "positionFreshness": "STALE",
      "resolvedAt": "2026-08-18T11:13:05.382Z"
    },
    {
      "region": "US",
      "subRegion": "US-EAST-COAST",
      "mmsi": "368119660",
      "imo": "9881213",
      "vesselName": "CHARLESTON",
      "vesselType": "Local type",
      "lat": 40.49433,
      "lon": -74.25839,
      "course": 344,
      "speed": 0.1,
      "navStatus": null,
      "observedAt": "2026-08-17T19:42:16.000Z",
      "positionSource": "shipinfo",
      "positionFreshness": "STALE",
      "resolvedAt": "2026-08-18T11:13:05.436Z"
    }
  ],
  "UK": [
    {
      "region": "UK",
      "subRegion": "UK-ENGLISH-CHANNEL",
      "mmsi": "244750930",
      "imo": null,
      "vesselName": "JOIE DE VIVRE",
      "vesselType": "Pleasure craft",
      "lat": 51,
      "lon": 1,
      "course": 111.9,
      "speed": 6.9,
      "navStatus": "-",
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T11:13:05.610Z"
    },
    {
      "region": "UK",
      "subRegion": "UK-ENGLISH-CHANNEL",
      "mmsi": "235057399",
      "imo": null,
      "vesselName": "TALISMAN OF IPSWICH",
      "vesselType": "Sailing vessel",
      "lat": 51,
      "lon": 1,
      "course": 86.8,
      "speed": 6,
      "navStatus": "-",
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T11:13:05.617Z"
    },
    {
      "region": "UK",
      "subRegion": "UK-ENGLISH-CHANNEL",
      "mmsi": "235101095",
      "imo": null,
      "vesselName": "RNLI LIFEBOAT 13-02",
      "vesselType": "SAR",
      "lat": 51,
      "lon": 1,
      "course": 360,
      "speed": 0.1,
      "navStatus": "Under way",
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T11:13:05.634Z"
    },
    {
      "region": "UK",
      "subRegion": "UK-ENGLISH-CHANNEL",
      "mmsi": "247353200",
      "imo": "9570565",
      "vesselName": "CAROLINE A",
      "vesselType": "Tanker",
      "lat": 51,
      "lon": 1,
      "course": 235.8,
      "speed": 9.8,
      "navStatus": "Under way",
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T11:13:05.636Z"
    },
    {
      "region": "UK",
      "subRegion": "UK-ENGLISH-CHANNEL",
      "mmsi": "235005245",
      "imo": null,
      "vesselName": "DMS ROTHER",
      "vesselType": "Military ops",
      "lat": 51,
      "lon": 1,
      "course": 145.8,
      "speed": 0.6,
      "navStatus": "-",
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T11:13:05.637Z"
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
      "lat": 59.73096666666667,
      "lon": 10.300256666666666,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T11:13:05.794Z"
    },
    {
      "region": "NORWAY",
      "subRegion": "NO-OSLOFJORD",
      "mmsi": "257777000",
      "imo": null,
      "vesselName": "NIRO",
      "vesselType": "Pleasure craft",
      "lat": 59.61985,
      "lon": 10.41041,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T11:13:05.800Z"
    },
    {
      "region": "NORWAY",
      "subRegion": "NO-OSLOFJORD",
      "mmsi": "257053700",
      "imo": "7325681",
      "vesselName": "HURUMFERJA",
      "vesselType": "Passenger ship",
      "lat": 59.61228666666667,
      "lon": 10.412435,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T11:13:05.816Z"
    },
    {
      "region": "NORWAY",
      "subRegion": "NO-OSLOFJORD",
      "mmsi": "259023490",
      "imo": null,
      "vesselName": "MORMORA",
      "vesselType": "Pleasure craft",
      "lat": 59.62332833333333,
      "lon": 10.440048333333333,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T11:13:05.821Z"
    },
    {
      "region": "NORWAY",
      "subRegion": "NO-OSLOFJORD",
      "mmsi": "257168500",
      "imo": null,
      "vesselName": "ARMANKA II",
      "vesselType": "Pleasure craft",
      "lat": 59.83576,
      "lon": 10.4794,
      "course": null,
      "speed": null,
      "navStatus": null,
      "observedAt": null,
      "positionSource": "vesselfinder",
      "positionFreshness": "NO_SOURCE_TIME",
      "resolvedAt": "2026-08-18T11:13:05.823Z"
    }
  ]
}
```