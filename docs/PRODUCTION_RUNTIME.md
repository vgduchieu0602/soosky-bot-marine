# Production runtime

## Context

RUNTIME-1 runs one Node.js bot process on one VPS. It owns AIS ingestion, the existing watchlist crawl, and maintenance; optional enrichment remains a separate process.

## Problem

Unowned intervals, reconnect timers, and unbounded backlogs can duplicate work or prevent a clean PM2 restart.

## Key Learning

The bot has two intended process forms:

- `marine-bot`: `npm run build` then `npm run start:bot`; one forked PM2 process owns Mongo, AIS (when configured), crawl and cleanup.
- `npm run enrich`: optional standalone enrichment worker. It is not started by the bot.

`ProductionRuntime` is the lifecycle owner. Start order is Mongo connection, dependency construction, AIS coordinator, then recurring schedulers. Shutdown reverses work generation: stop schedulers, stop AIS/reconnect and drain its bounded final batches, then close Mongo. `SIGTERM`, `SIGINT`, uncaught exceptions, and unhandled rejections use one guarded shutdown path. Shutdown is bounded by `RUNTIME_SHUTDOWN_TIMEOUT_MS` (15s default).

AIS reconnect starts at 1s, doubles to 30s maximum, adds 20% jitter in the production bootstrap, resets after a successful connection, and cancels a pending reconnect on stop. No protocol ping is invented: the internal Marine WebSocket does not advertise one. Optional stale detection remains disabled unless an operator supplies a proven timeout.

## Decision

- AIS input is coalesced by MMSI. `AisCoalescingBuffer` retains the latest position and latest identity per vessel, not raw frames. It is LRU-bounded by `AIS_MAX_BUFFERED_VESSELS` (50,000 default); when full it evicts the least-recently-touched vessel and counts dirty evictions. The pending set is a subset of the same bounded map.
- Each flush drains at most 500 vessels (`AIS_FLUSH_BATCH_SIZE`); the coordinator processes at most 20 batches per cycle and is single-flight. Slow/failed Mongo persistence requeues only the latest state, never an unbounded message queue. A failure is visible through persistence counters and degraded health.
- `IngestAisBatch` uses one `saveMany` per coalesced batch and resolves affected vessels with a fixed concurrency of 10. Incoming frames, observation inserts, and canonical resolves are deliberately different rates.
- `IntervalScheduler` is idempotent and skips overlapping ticks instead of queuing them. Its `skippedOverlaps` counter makes overload visible.
- PM2 must use `instances: 1` and `exec_mode: fork`; cluster mode would duplicate AIS connections and crawls without distributed coordination.

Long-lived process-local structures:

| Structure | Bound / cleanup |
| --- | --- |
| AIS entries + pending MMSI | 50,000 LRU maximum; pending is a subset; batches drain it |
| AIS rejection reasons / log suppression | finite enum-derived keys |
| AIS reconnect/stale timers | one each; cleared on stop |
| Detail refresh gate | existing 20,000-entry LRU cap and TTL |
| Detail and paid single-flight maps | entry removed in `finally`, including failures |
| Scheduler timer | one timer, cleared by `stop()` |

Health is an in-process snapshot, not a public endpoint: `{ status, mongo, ais: { enabled, connected, pending }, workers, memory }`. A connected Mongo plus reconnecting AIS is `DEGRADED`; missing Mongo never becomes `READY`.

## Action Items

Run `npm run runtime:load-poc -- --vessels=10000 --events=60000` (or with `node --expose-gc`) before selecting a VPS. The harness is deterministic and uses in-memory repositories only; it reports frames, coalesced entries, observations, canonical resolves, repository reads/writes, RSS/heap, and max buffered vessels. It does not claim production Mongo throughput.

Local in-memory baseline (1,000 vessels, drain every 1,000 frames) was 1,000/5,000/10,000 synthetic frames, representing 10 seconds at 100/500/1000 msg/s: 203ms/1.57s/4.69s elapsed; 1.00/0.98/0.98 observation writes per frame; 2/10/20 `saveMany` calls; 4 repository reads per resolved vessel; max pending 1,000 and no evictions. Heap end was 183.7/153.6/182.7 MiB in the already-loaded test process, so these figures are regression signals only, not VPS capacity promises. A separate 60,000-unique-vessel buffer stress with the 50,000 cap retained exactly 50,000 entries, evicted 10,000 dirty oldest entries, then drained to zero; its buffer delta was about 17.3 MiB (about 362 bytes per retained vessel in that run).

At 100/500/1000 incoming messages per second, input volume is 8.64M/43.2M/86.4M frames per day. The observation and canonical write rates depend on unique MMSIs per coalesce window, not that incoming rate. A single vessel at the default 60s window has at most 1,440 retained position observations/day; actual global storage must be measured with the synthetic sample/BSON indexes before capacity is promised.

Start with 2 vCPU / 2GB RAM and external Mongo for an initial small deployment. A 1GB VPS is not recommended without a measured low-water RSS plus Mongo being external. Mongo on the same VPS competes for RAM, CPU, and disk IOPS; global AIS ingestion needs external Mongo or a larger host. The PM2 700M restart cap is a conservative guardrail, not a capacity claim.

## Related Notes

[[AIS_COALESCING_BUFFER]] [[AIS_BULK_PERSISTENCE]] [[CRAWL_RUNTIME]]
