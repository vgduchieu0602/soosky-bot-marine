// ============================================================================
//  INFRASTRUCTURE · Mongoose model cho `crawl_region_states`
// ----------------------------------------------------------------------------
//  MỘT collection duy nhất cho toàn bộ trạng thái lập lịch (§8). Không tách
//  thêm collection phụ nào cho scheduler.
// ============================================================================

import { Schema, model } from "mongoose";

const crawlRegionStateSchema = new Schema(
  {
    regionId: { type: String, required: true, unique: true },
    tier: { type: String, required: true },
    intervalMs: { type: Number, required: true },
    lastScanAt: { type: Date, default: null },
    nextScanAt: { type: Date, required: true },
    lastVesselCount: { type: Number, default: null },
    averageVesselCount: { type: Number, default: null },
    newVesselCount: { type: Number, default: null },
    consecutiveEmptyScans: { type: Number, default: 0 },
    lastOutcome: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

// Chỉ HAI index, đúng hai câu hỏi scheduler thực sự hỏi (§52):
//   "trạng thái của vùng X?"  và  "vùng nào đã đến hạn?"
crawlRegionStateSchema.index({ regionId: 1 }, { unique: true });
crawlRegionStateSchema.index({ nextScanAt: 1 });

export const CrawlRegionStateModel = model(
  "CrawlRegionState",
  crawlRegionStateSchema,
  "crawl_region_states"
);
