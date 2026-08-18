/**
 * REGIONAL-DATA-PROOF-1 — proof-only region fixture.
 *
 * These are DIAGNOSTIC bounding boxes, not domain concepts. There is no Region
 * entity, aggregate or enum in `src/domain` and there must not be one: a region
 * here is nothing but "a rectangle we point the existing scanner at".
 *
 * Contract reused as-is: `BoundingBox` from the application geo port. No new
 * geographic type is introduced.
 *
 * Sub-regions follow the phase brief exactly:
 *   US      East Coast · West Coast · Gulf
 *   UK      English Channel · Thames · Irish Sea
 *   NORWAY  Oslofjord · Bergen/coastal · northern/coastal waters
 */
import { BoundingBox } from "../../src/application/contracts/geo/Geo";

export type ProofRegion = "US" | "UK" | "NORWAY";

export const PROOF_REGIONS: readonly ProofRegion[] = Object.freeze(["US", "UK", "NORWAY"]);

export interface ProofSubRegion {
  readonly region: ProofRegion;
  /** Stable identifier used in reports, manifests and checkpoints. */
  readonly name: string;
  /** Human label from the phase brief. */
  readonly label: string;
  readonly box: BoundingBox;
}

export const PROOF_SUB_REGIONS: readonly ProofSubRegion[] = Object.freeze([
  {
    region: "US",
    name: "US-EAST-COAST",
    label: "East Coast (New York / New Jersey approaches)",
    box: { minLat: 40.4, minLon: -74.3, maxLat: 40.9, maxLon: -73.7 },
  },
  {
    region: "US",
    name: "US-WEST-COAST",
    label: "West Coast (Los Angeles / Long Beach)",
    box: { minLat: 33.5, minLon: -118.4, maxLat: 33.9, maxLon: -118.0 },
  },
  {
    region: "US",
    name: "US-GULF",
    label: "Gulf (Houston / Galveston ship channel)",
    box: { minLat: 29.2, minLon: -95.2, maxLat: 29.8, maxLon: -94.5 },
  },
  {
    region: "UK",
    name: "UK-ENGLISH-CHANNEL",
    label: "English Channel (Dover Strait)",
    box: { minLat: 50.8, minLon: 0.8, maxLat: 51.3, maxLon: 1.6 },
  },
  {
    region: "UK",
    name: "UK-THAMES",
    label: "Thames (estuary)",
    box: { minLat: 51.3, minLon: 0.4, maxLat: 51.7, maxLon: 1.2 },
  },
  {
    region: "UK",
    name: "UK-IRISH-SEA",
    label: "Irish Sea (Liverpool Bay)",
    box: { minLat: 53.2, minLon: -3.3, maxLat: 53.6, maxLon: -2.8 },
  },
  {
    region: "NORWAY",
    name: "NO-OSLOFJORD",
    label: "Oslofjord",
    box: { minLat: 59.6, minLon: 10.3, maxLat: 59.95, maxLon: 10.9 },
  },
  {
    region: "NORWAY",
    name: "NO-BERGEN-COAST",
    label: "Bergen / coastal",
    box: { minLat: 60.2, minLon: 4.9, maxLat: 60.5, maxLon: 5.5 },
  },
  {
    region: "NORWAY",
    name: "NO-NORTHERN-COAST",
    label: "Northern / coastal waters (Tromsø)",
    box: { minLat: 69.5, minLon: 18.7, maxLat: 69.8, maxLon: 19.3 },
  },
]);

export function subRegionsOf(region: ProofRegion): readonly ProofSubRegion[] {
  return PROOF_SUB_REGIONS.filter((sub) => sub.region === region);
}
