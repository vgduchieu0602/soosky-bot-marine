# PHASE 5 — VESSELBASICS COMPLETION

- Database: `soosky_marine_bot_dev` · AIS off · paid off
- Sample: 90 known vessels · US=30 UK=30 NORWAY=30
- ShipFinder UTC offset: 480

## MAP-only vs AFTER BasicCompletion (§10)

| FIELD | BEFORE | AFTER |
|---|---:|---:|
| vesselName | 98.9% | 98.9% |
| mmsi | 98.9% | 98.9% |
| imo | 35.6% | 35.6% |
| vType | 0% | 92.2% |
| latLon | 98.9% | 98.9% |
| course | 70% | 71.1% |
| speed | 94.4% | 98.9% |
| navStatus | 50% | 52.2% |
| received | 94.4% | 98.9% |

## Regional (§9)

| FIELD | US | UK | NORWAY | ALL |
|---|---:|---:|---:|---:|
| vesselName | 96.7% | 100% | 100% | 98.9% |
| mmsi | 96.7% | 100% | 100% | 98.9% |
| imo | 40% | 33.3% | 33.3% | 35.6% |
| vType | 96.7% | 100% | 80% | 92.2% |
| latLon | 96.7% | 100% | 100% | 98.9% |
| course | 73.3% | 73.3% | 66.7% | 71.1% |
| speed | 96.7% | 100% | 100% | 98.9% |
| navStatus | 63.3% | 53.3% | 40% | 52.2% |
| received | 96.7% | 100% | 100% | 98.9% |

## Request amplification (§11/§12)

| cycle | vessels | lookup requests | per 100 vessels | statuses |
|---|---:|---:|---:|---|
| 1 | 90 | **210** | 233 | {"COMPLETED":29,"PARTIAL":60,"NO_SOURCE_AVAILABLE":1} |
| 3 | 90 | **66** | 73 | {"ALREADY_SUFFICIENT":28,"NO_SOURCE_AVAILABLE":57,"PARTIAL":4,"COMPLETED":1} |

## Source contribution

- cycle 1: {"vesselfinder":90,"shipfinder":61,"shipinfo":62}
- cycle 3: {"shipfinder":61,"vesselfinder":53,"shipinfo":62}