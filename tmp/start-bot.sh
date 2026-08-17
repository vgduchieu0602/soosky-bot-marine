#!/usr/bin/env bash
set -euo pipefail
cd /c/Code/Project/Soosky-backend/Marine/Crawl-Marine-Bot
export MONGODB_URI='mongodb://127.0.0.1:27017/soosky_marine_reality_gate'
export API_KEY='reality-api-key'
export INTERNAL_ACQUIRE_TOKEN='reality-internal-token'
export PAID_FALLBACK_ENABLED='false'
export BOT_AIS_ENABLED='false'
export HTTP_HOST='127.0.0.1'
export PORT='3200'
export MYSHIPTRACKING_API_KEY=''
export CACHE_TTL_MS='60000'
export POSITION_STALE_AFTER_MS='86400000'
export POSITION_CLEANUP_EVERY_MS='3600000'
export CRAWL_EVERY_MS='21600000'
export WATCHLIST=''
unset REDIS_URL || true
exec npx ts-node --transpile-only src/interfaces/http/server.ts
