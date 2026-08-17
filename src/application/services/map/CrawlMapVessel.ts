// ============================================================================
// APPLICATION · CrawlMapVessel — stable crawl-only map read projection
// ----------------------------------------------------------------------------
// This is deliberately not the mobile compatibility DTO.  It exposes only
// canonical crawl values, keeps unknowns as null, and is safe to read directly
// from the Bot's map use cases or by a production read adapter.
// ============================================================================

import { MapVesselItem } from "./MapVesselProjector";

export interface CrawlMapVessel {
  readonly vesselName: string | null;
  readonly mmsi: string | null;
  readonly imo: string | null;
  readonly vType: number | null;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly course: number | null;
  readonly speed: number | null;
  readonly navStatus: string | null;
  readonly observedAt: Date | null;
}

/**
 * Convert the existing canonical map projection without inventing values such
 * as zero or "---".  Presentation sentinels belong only to Marine's response
 * boundary.
 */
export function toCrawlMapVessel(item: MapVesselItem): CrawlMapVessel {
  return Object.freeze({
    vesselName: item.vesselName,
    mmsi: item.mmsi,
    imo: item.imo,
    vType: item.vesselTypeCode,
    lat: item.lat,
    lon: item.lon,
    course: item.course,
    speed: item.speed,
    navStatus: item.navStatusText,
    observedAt: item.observedAt,
  });
}
