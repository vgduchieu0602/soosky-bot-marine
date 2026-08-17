import { NO_DATA, VesselBasics, VesselDetails } from "./VesselDetails";

type Field<T> = T | { value: T } | null | undefined;

export type CanonicalDetailContractInput = {
  identifiers: { mmsi: string | null; imo: string | null };
  identity: { name: Field<string>; vesselType: Field<string>; vesselTypeCode: Field<number>; flagName: Field<string> };
  position: { lat: number; lon: number; course: number | null; speed: number | null; navStatusText?: string | null; observedAt: Date | string | null } | null;
  particulars: { grossTonnage: Field<number>; deadweight: Field<number>; builtYear: Field<number> };
  voyage: { currentPort: Field<string>; lastPort: Field<string>; nextPort: Field<string> };
};

function value<T>(field: Field<T>): T | null {
  if (field === null || field === undefined) return null;
  return typeof field === "object" && "value" in field ? field.value : field;
}

function stringValue(field: Field<string>): string { return value(field) ?? NO_DATA; }
function positionBasics(input: CanonicalDetailContractInput): Pick<VesselBasics, "lat" | "lon" | "course" | "speed" | "navStatus" | "received"> {
  const position = input.position;
  if (position === null) return { lat: null, lon: null, course: null, speed: null, navStatus: NO_DATA, received: NO_DATA };
  const observed = position.observedAt instanceof Date ? position.observedAt.toISOString() : position.observedAt ?? NO_DATA;
  return { lat: position.lat, lon: position.lon, course: position.course, speed: position.speed, navStatus: position.navStatusText ?? NO_DATA, received: observed };
}

function portBase(port: Field<string>) { return { port: stringValue(port), portId: null, portUnlocode: NO_DATA, portCountry: NO_DATA }; }

/** Canonical read model -> V1 public DTO. This adapter is the only NO_DATA boundary. */
export function toVesselDetails(input: CanonicalDetailContractInput): VesselDetails {
  const basics: VesselBasics = {
    vesselName: stringValue(input.identity.name), mmsi: input.identifiers.mmsi, imo: input.identifiers.imo,
    vType: value(input.identity.vesselTypeCode), ...positionBasics(input),
  };
  return {
    basics, vesselType: stringValue(input.identity.vesselType), flag: stringValue(input.identity.flagName),
    grossTonnage: value(input.particulars.grossTonnage), deadWeight: value(input.particulars.deadweight), yearOfBuild: value(input.particulars.builtYear),
    voyage: {
      current: { ...portBase(input.voyage.currentPort), portArrivalUtc: NO_DATA, portArrivalLocal: NO_DATA },
      last: { ...portBase(input.voyage.lastPort), portDepartureUtc: NO_DATA, portDepartureLocal: NO_DATA },
      next: { ...portBase(input.voyage.nextPort), portEtaUtc: NO_DATA, portEtaLocal: NO_DATA },
    },
  };
}
