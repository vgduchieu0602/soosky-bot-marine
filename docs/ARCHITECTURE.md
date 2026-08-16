# Architecture

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

Examples:

- `AisCoalescingBuffer` is an application ingestion service.
- `PositionResolver` is an application resolution service.
- `MarineAisWebSocketClient` is an infrastructure adapter.

Repository and provider interfaces live in `application/contracts/repositories/` and `application/contracts/providers/`. Concrete adapters implement those contracts from infrastructure.

## Legacy code

`src/legacy/` retains the prior VesselFinder-oriented model, mapping and scan workflows for compatibility. It is intentionally isolated and must not be copied as the architectural pattern for new functionality. The small number of legacy imports are confined to legacy-oriented paths and adapters; canonical domain and application services do not depend on legacy code.
