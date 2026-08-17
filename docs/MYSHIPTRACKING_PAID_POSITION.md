# MyShipTracking paid current-position lane

## Context

TRACK-1 adds one explicitly invoked paid refresh for one vessel. It is isolated from map reads, free detail refreshes, database misses, crawler failures, and scheduling.

## Problem

A paid API must not become an accidental free fallback or spend multiple credits for one user action.

## Key Learning

The official Vessel Status documentation was audited on 2026-08-17: `GET https://api.myshiptracking.com/api/v2/vessel`, authenticated by `Authorization: Bearer <key>` (or `x-api-key`), accepts exactly one `mmsi` or `imo`, and supports `simple` (1 credit) and `extended` (3 credits). A no-result response is not charged. `X-Credit-Charged`, when present, is the actual charge.

The lane always sends `response=simple`: TRACK-1 needs current position, while free acquisition retains responsibility for enrichment. The documentation sample contains `lat: 0, lng: 0`, so zero coordinates remain valid under the existing coordinate validator. It also shows numeric `nav_status` despite the field table saying text; the mapper safely accepts either an AIS code 0..15 or non-empty text.

## Decision

- `TrackVesselCurrentPosition` is the only paid entry point. It uses `PaidFallbackGate` with `EXPLICIT_TRACKING`, one MMSI/IMO (MMSI wins when both were supplied), an explicit known budget, and a process-local per-vessel single-flight map.
- `MyShipTrackingClient` makes exactly one `GET /api/v2/vessel?response=simple` request with timeout and no automatic retry. Ambiguous billing after network/5xx errors is safer than risking a second charge.
- HTTP/API failures are classified as: 404 `NOT_FOUND`, 402 `NO_CREDITS`, 429 `RATE_LIMITED`, 401/403 `UNAUTHORIZED`, 400 `BAD_REQUEST`, and 5xx `SERVER_ERROR`. Only success creates observations.
- Success maps to `ProviderDetailsResult`, then `VesselObservation`, then the existing resolver and canonical store. It never writes canonical state directly and has no paid-source priority override.
- Paid position observations are retained for seven days, matching the resolver candidate window. They are infrequent and credit-bearing, but are not retained indefinitely.

## Action Items

- TRACK-2 may design authorization, scheduling, product billing, and a production API route. None are part of TRACK-1.
- Any manual POC must require an explicit paid confirmation and never print the key.

## Related Notes

[[ACQUISITION_POLICY]] [[RESOLVER_POLICY]] [[OBSERVATION_STORAGE]]
