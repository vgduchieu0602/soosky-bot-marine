/**
 * Fail-fast DB safety for BOT-DATA-PROOF and any isolated crawl run.
 * Never relies on operator discipline alone when BOT_DATA_PROOF_MODE=true.
 */

export const DEFAULT_PRODUCTION_MONGO_DB_NAMES = Object.freeze([
  "soosky_marine",
  "soosky-marine",
  "soosky_marine_api",
  "soosky-marine-api",
  "marine",
  "production",
]);

/**
 * Extract the database name from a MongoDB URI path segment.
 * Returns null when the URI has no explicit database name.
 */
export function extractMongoDatabaseName(uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed) return null;

  // Strip query string first.
  const withoutQuery = trimmed.split("?")[0];

  // mongodb://user:pass@host:port/dbname
  // mongodb+srv://user:pass@host/dbname
  const schemeSplit = withoutQuery.split("://");
  if (schemeSplit.length < 2) return null;
  const afterScheme = schemeSplit.slice(1).join("://");

  // Remove credentials if present (user:pass@host...)
  const at = afterScheme.lastIndexOf("@");
  const hostAndPath = at >= 0 ? afterScheme.slice(at + 1) : afterScheme;

  const slash = hostAndPath.indexOf("/");
  if (slash < 0) return null;
  const name = hostAndPath.slice(slash + 1).trim();
  if (!name) return null;
  // Guard against accidental path garbage.
  if (name.includes("/") || name.includes(" ")) return null;
  return name;
}

export function isProofModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BOT_DATA_PROOF_MODE ?? "").trim().toLowerCase() === "true";
}

export function assertSafeBotDatabase(options: {
  mongoUri: string;
  proofMode?: boolean;
  productionDbNames?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): { dbName: string } {
  const env = options.env ?? process.env;
  const proofMode = options.proofMode ?? isProofModeEnabled(env);
  const dbName = extractMongoDatabaseName(options.mongoUri);

  if (!dbName) {
    throw new Error(
      "MONGODB_URI must include an explicit database name (e.g. mongodb://127.0.0.1:27017/soosky_marine_bot_dev)."
    );
  }

  const extra = (env.PRODUCTION_MONGO_DB_NAME ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const banned = new Set(
    [...(options.productionDbNames ?? DEFAULT_PRODUCTION_MONGO_DB_NAMES), ...extra].map((s) =>
      s.toLowerCase()
    )
  );

  if (proofMode && banned.has(dbName.toLowerCase())) {
    throw new Error(
      `BOT_DATA_PROOF_MODE refused database "${dbName}" — matches a known production DB name. ` +
        `Use an isolated DB such as soosky_marine_bot_dev.`
    );
  }

  if (proofMode && (dbName === "admin" || dbName === "local" || dbName === "config")) {
    throw new Error(`BOT_DATA_PROOF_MODE refused system database "${dbName}".`);
  }

  return { dbName };
}
