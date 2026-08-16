# Architecture

This is the authoritative current architecture document. Earlier phase documents are historical or detailed references and do not override this structure.

## System responsibility

`Soosky-bot-marine` consumes the Marine AIS WebSocket, crawls and enriches free vessel sources, normalizes source observations, resolves multi-source data, and maintains the canonical current vessel. Paid tracking ingestion is reserved for a future phase.

`Soosky-marine-api` remains responsible for the upstream AISStream connection, its mobile-facing public API and WebSocket. This refactor does not change that production service.

## Layers and dependency rule

```text
domain
  ↑
application
  ↑
infrastructure / interfaces
  ↑
bootstrap
```

- `domain/` holds pure marine concepts: entities, value objects, enums, validators, and domain errors. It does not know transport, persistence, external providers, or other layers.
- `application/` contains complete use cases, reusable services and contracts. Application code may import domain code and application contracts, but must not import infrastructure.
- `infrastructure/` implements external integrations, persistence, generic HTTP and cache adapters.
- `interfaces/` contains HTTP and CLI entry points that call configured application objects.
- `bootstrap/` is the composition root. It creates concrete adapters and wires them into application objects; it contains no business policy.

## Main data flows

### AIS

```text
Marine production WebSocket
  → MarineAisWebSocketClient
  → MarineAisMessageMapper
  → AisCoalescingBuffer (application ingestion service)
  → observation / resolver pipeline
  → canonical current vessel
```

`AisCoalescingBuffer` accepts the small application-owned `AisIngestionEvent` shape. The Marine adapter event is structurally compatible, so the buffer has no dependency on the WebSocket client or Marine transport DTOs.

### Free-source crawling

```text
ShipFinder / ShipInfo / VesselFinder
  → provider adapter
  → observation
  → resolver
  → canonical current vessel
```

Each external source keeps its client, parser, mapper, types, fixtures and provider in its own `infrastructure/integrations/<source>/` boundary.

## Persistence

Persistence implementations are grouped by technology:

- `infrastructure/persistence/mongo/`
- `infrastructure/persistence/memory/`
- `infrastructure/persistence/file/`

Mongo schema and Mongoose model remain together in each model module. A domain entity is not a Mongoose model: domain objects never import Mongoose, while Mongo repositories implement application repository contracts and bridge application objects to Mongo documents.

## Use cases, services and contracts

A use case represents a complete application workflow, such as acquiring vessel data or resolving and storing a current vessel. A service supports one or more workflows with policy or orchestration logic.

Use cases are grouped by responsibility:

- `application/use-cases/acquisition/`
- `application/use-cases/observation/`
- `application/use-cases/resolution/`
- `application/use-cases/vessel/`
- `application/use-cases/watchlist/`

No AIS ingestion use case exists yet; AIS-4 is the phase that may introduce one.

Examples:

- `AisCoalescingBuffer` is an application ingestion service.
- `PositionResolver` is an application resolution service.
- `MarineAisWebSocketClient` is an infrastructure adapter.

Contracts live next to their responsibility: repositories in `application/contracts/repositories/`, provider contracts in `application/contracts/providers/`, cache contracts in `application/contracts/cache/`, and geographic scanning primitives in `application/contracts/geo/`. Concrete adapters implement those contracts from infrastructure.

## Bootstrap

`bootstrap/container.ts` remains the composition root. It makes the two compatibility boundaries explicit:

- `createLegacyDependencies.ts` wires the retained VesselFinder-oriented HTTP/CLI compatibility path.
- `createCanonicalDependencies.ts` wires multi-source providers, observations, resolvers, and canonical current-vessel dependencies.

Both factories only compose dependencies. They do not start a crawler, scheduler, or AIS client.

## Legacy code

`src/legacy/` retains the prior VesselFinder-oriented model, mapping and scan workflows for compatibility. It is intentionally isolated and must not be copied as the architectural pattern for new functionality. The small number of legacy imports are confined to legacy-oriented paths and adapters; canonical domain and application services do not depend on legacy code.
