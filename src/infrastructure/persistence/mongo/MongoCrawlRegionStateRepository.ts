// ============================================================================
//  INFRASTRUCTURE · MongoCrawlRegionStateRepository
// ----------------------------------------------------------------------------
//  Upsert theo `regionId`. Không giữ lịch sử: scheduler chỉ cần biết TRẠNG THÁI
//  HIỆN TẠI của mỗi vùng.
// ============================================================================

import { ICrawlRegionStateRepository } from "../../../application/contracts/repositories/ICrawlRegionStateRepository";
import {
  RegionScanOutcome,
  RegionScheduleState,
} from "../../../application/services/crawl-runtime/RegionSchedulePolicy";
import { RegionTrafficTier } from "../../../config/maritimeRegions";
import { CrawlRegionStateModel } from "./crawlRegionStateModel";

function toEntity(doc: Record<string, any>): RegionScheduleState {
  return {
    regionId: String(doc.regionId),
    tier: doc.tier as RegionTrafficTier,
    intervalMs: Number(doc.intervalMs),
    lastScanAt: doc.lastScanAt ?? null,
    nextScanAt: doc.nextScanAt,
    lastVesselCount: doc.lastVesselCount ?? null,
    averageVesselCount: doc.averageVesselCount ?? null,
    newVesselCount: doc.newVesselCount ?? null,
    consecutiveEmptyScans: Number(doc.consecutiveEmptyScans ?? 0),
    lastOutcome: (doc.lastOutcome ?? null) as RegionScanOutcome | null,
    lastErrorAt: doc.lastErrorAt ?? null,
  };
}

export class MongoCrawlRegionStateRepository implements ICrawlRegionStateRepository {
  async findAll(): Promise<readonly RegionScheduleState[]> {
    const docs = await CrawlRegionStateModel.find({}).lean();
    return Object.freeze(docs.map((doc) => toEntity(doc as never)));
  }

  async findByRegionId(regionId: string): Promise<RegionScheduleState | null> {
    const doc = await CrawlRegionStateModel.findOne({ regionId }).lean();
    return doc === null ? null : toEntity(doc as never);
  }

  async save(state: RegionScheduleState): Promise<void> {
    await CrawlRegionStateModel.findOneAndUpdate(
      { regionId: state.regionId },
      { ...state },
      { upsert: true }
    );
  }
}
