# Canonical Vessel Contract V1

`VesselBasics` and `VesselDetails` are public boundary DTOs. They are duplicated
verbatim in Soosky-bot-marine and Soosky-marine-api; they are intentionally not
a shared package or a persistence/domain model.

The machine-checkable snapshot is `vessel-contract-v1.json`. Run
`OTHER_MARINE_REPO=<path> npm run contract:parity` before publishing a Bot
change. Any breaking change requires an explicit version increment and Marine
review.

Rules:

- missing boundary strings are `---`; boundary numeric fields are `null`;
- `received` is an ISO-8601 timestamp from the selected position snapshot or
  `---`; position fields must come from that one snapshot;
- voyage is `current`, `last`, `next`; every port key is `portUnlocode`;
- mapping happens at the application boundary, never in Mongo schema or domain
  entities.

Bot owns crawling, paid-provider credentials, canonical storage, and writes.
Its canonical data Marine may consume is MMSI/IMO, vessel identity
(name/type/IMO), position (lat/lon/course/speed/navigation status), selected
observation timestamp, and voyage/location fields when available. Bot schema
changes are not public-contract changes until this mapper changes.
