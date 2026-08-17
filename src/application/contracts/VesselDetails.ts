import { VesselBasics } from "./VesselBasics";

export { NO_DATA, VESSEL_CONTRACT_VERSION } from "./VesselBasics";
export type { VesselBasics } from "./VesselBasics";

export interface VesselDetails {
  basics: VesselBasics;
  vesselType: string;
  flag: string;
  grossTonnage: number | null;
  deadWeight: number | null;
  yearOfBuild: number | null;
  voyage: {
    current: { port: string; portId: number | null; portUnlocode: string; portCountry: string; portArrivalUtc: string; portArrivalLocal: string };
    last: { port: string; portId: number | null; portUnlocode: string; portCountry: string; portDepartureUtc: string; portDepartureLocal: string };
    next: { port: string; portId: number | null; portUnlocode: string; portCountry: string; portEtaUtc: string; portEtaLocal: string };
  };
}
