# Crawl data ownership

## Context

The crawl bot discovers vessels, collects free crawl data, normalizes it into observations, resolves canonical state, and stores that state in `canonical_current_vessels`.

## Problem

Two independent upstream AISStream connections would duplicate paid traffic and create competing realtime ownership.

## Key Learning

`CrawlMapVessel` is a crawl-only read projection: unknown values stay `null`. Mobile compatibility placeholders are not canonical data. Map position freshness is an operational concern independent from detail/voyage freshness.

## Decision

Soosky-marine-api is the sole production upstream AISStream owner. The Bot's existing AIS client remains available for explicit test/staging ingestion, but `BOT_AIS_ENABLED=false` by default prevents its runtime from opening any connection. Production consumes canonical crawl state and merges it with its own in-memory AIS snapshot.

## Action Items

Keep scan/watchlist cadence under review: the current six-hour crawl schedules are slower than the initial 30-minute map freshness window, so wide-area map freshness must be measured before relying on crawl-only coverage.

## Related Notes

[[AIS_CANONICAL_INGESTION]] · [[CRAWL_AIS_MAP_WRAPPER]]
