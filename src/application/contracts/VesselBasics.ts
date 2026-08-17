/** Public boundary DTO. It is intentionally not a domain entity or persistence model. */
export const VESSEL_CONTRACT_VERSION = "1" as const;
export const NO_DATA = "---" as const;

export interface VesselBasics {
  vesselName: string;
  mmsi: string | null;
  imo: string | null;
  vType: number | null;
  lat: number | null;
  lon: number | null;
  course: number | null;
  speed: number | null;
  navStatus: string;
  /** ISO timestamp of the selected atomic position snapshot, or NO_DATA when none is usable. */
  received: string;
}
