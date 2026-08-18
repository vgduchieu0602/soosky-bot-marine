import { Schema, model } from "mongoose";

/**
 * Bot-owned crawl resume state. Not a Marine/production collection.
 * Collection: bot_crawl_checkpoints
 */
const crawlCheckpointSchema = new Schema(
  {
    job: { type: String, required: true, unique: true },
    provider: { type: String, required: true },
    cursor: { type: Schema.Types.Mixed, required: true },
    stats: { type: Schema.Types.Mixed, default: {} },
    updatedAt: { type: Date, required: true },
  },
  { versionKey: false }
);

export const CrawlCheckpointModel = model(
  "BotCrawlCheckpoint",
  crawlCheckpointSchema,
  "bot_crawl_checkpoints"
);
