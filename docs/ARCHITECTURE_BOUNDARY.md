# Bot / Marine Ownership Boundary

Bot is the acquisition and write owner: crawler execution, source arbitration,
paid provider integration, canonical vessel/observation writes, and the
token-protected internal acquisition route. Marine can request a capability
(`POSITION` or `DETAIL`) but cannot select a provider.

Marine is the public/read and realtime owner: public APIs, mobile compatibility,
Mongo/AIS reads, subscriptions/entitlement decisions, and its AISStream
production connection. Map endpoints read Mongo plus Marine AIS state only;
they never call Bot or a paid provider in the request path.

The normal paid design is `Marine -> Bot -> local/free -> paid when explicitly
permitted`. The current Bot composition intentionally leaves its paid adapter
unwired because a credit ledger/production adapter has not been validated.
Therefore `PAID_UPDATED` must not be treated as production-ready today.

Bot accepts an optional `acquisitionRequestId` on its internal route and keeps a
bounded, in-memory TTL registry. Repeated IDs reuse the original command,
including an ambiguous failure, so a retry cannot duplicate a paid attempt.
This is process-local only; multi-instance production needs a shared idempotency
store before enabling paid acquisition.

## Diagram

```
FREE SOURCES
    |
    v
BOT (acquisition/write)
    |
    v
CANONICAL MONGO ----> MARINE (read/public/realtime) ----> MOBILE
                         ^
                         |
                      AISSTREAM (Marine only)

PAID NORMAL:     MARINE -> BOT -> MYSHIPTRACKING
PAID EMERGENCY:  MARINE -> MYSHIPTRACKING   (only BOT_UNAVAILABLE + explicit paid)
```

