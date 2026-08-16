# AIS Bulk Persistence

## Context

AIS-4 connects the bounded, per-MMSI `AisCoalescingBuffer` to canonical observation storage and current-vessel resolution. It is wired by `createCanonicalDependencies`, but remains inert until an explicit runtime creates a Marine AIS coordinator.

## Problem

The previous Mongo `saveMany()` called `save()` once per item: each observation made an `exists()` query followed by a `create()`. That is not viable for a global AIS stream and also provides no bounded batch operation.

## Key Learning

`MongoVesselObservationRepository.saveMany()` now computes every fingerprint first, keeps the first occurrence per fingerprint in input order, and queries existing rows with one `$or` query grouped by dedupe cutoff. It then performs one ordered `insertMany()` only for candidates absent from both the batch and MongoDB. Returned results still align exactly with input order.

The existing `save()` behavior is intentionally unchanged. In-memory persistence keeps the same observable order and duplicate semantics for tests and development.

## Decision

`IngestAisBatch` converts coalesced entries through `detailsResultToObservations()`, calls `saveMany()` once, then resolves each affected MMSI once. A small worker pool uses `AIS_RESOLVE_CONCURRENCY` (default `10`) instead of an unbounded `Promise.all`.

The Marine coordinator permits only one persistent flush at a time. While persistence is slow, the buffer continues to coalesce current state; it does not accumulate a second queue of drained batches. A failed batch is accepted back through the same buffer, so an older requeued frame cannot overwrite a newer frame received during the failure.

Each successful or failed persistent batch produces one aggregate log line and coordinator counters only; it never logs individual vessels.

## Action Items

- AIS observation retention is not implemented in AIS-4. Global streams can grow `vessel_observations` quickly; retention policy and any TTL/index decision belong to a later phase.
- Resolver reads remain per-vessel work. Measure Mongo load under a bounded ingest simulation before considering resolver batching in AIS-5.
- AIS-5 may add map/GeoJSON concerns only after separate design and load evidence.

## Related Notes

- [[AIS_COALESCING_BUFFER]]
- [[AIS_CANONICAL_INGESTION]]
- [[RESOLVER_POLICY]]
