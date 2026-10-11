#!/usr/bin/env node
/**
 * Issue a new BPS API key.
 *
 * Generates a cryptographically random key, stores only its SHA-256 hash in
 * the `api_keys` table, and prints the raw key to stdout exactly once. There
 * is no way to retrieve it again afterwards -- if it's lost, revoke the row
 * and issue a new key.
 *
 * Usage:
 *   node scripts/issue-api-key.mjs <principal> <agent|worker|admin>
 *
 * Reads BPS_DATABASE_URL from the environment, loading .env.local manually
 * (no dotenv dependency) if it exists and the var isn't already set.
 */

import { randomBytes, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const VALID_ROLES = new Set(["agent", "worker", "admin"]);

function loadEnvLocal() {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, "..", ".env.local");
  if (!existsSync(envPath)) return;

  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function usageAndExit(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error("Usage: node scripts/issue-api-key.mjs <principal> <agent|worker|admin>");
  process.exit(1);
}

function hashApiKey(raw) {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

async function main() {
  loadEnvLocal();

  const [principal, role] = process.argv.slice(2);

  if (!principal || principal.trim().length === 0) {
    usageAndExit("missing <principal> argument.");
  }
  if (!role) {
    usageAndExit("missing <role> argument.");
  }
  if (!VALID_ROLES.has(role)) {
    usageAndExit(`invalid role "${role}". Must be one of: agent, worker, admin.`);
  }

  const databaseUrl = process.env.BPS_DATABASE_URL;
  if (!databaseUrl) {
    usageAndExit(
      "BPS_DATABASE_URL is not set (checked process env and .env.local). " +
        "API keys can only be issued against durable (Postgres) storage.",
    );
  }

  // 32 random bytes, base64url-encoded: short, URL-safe, ~43 chars, 256 bits
  // of entropy. Prefixed so leaked keys are greppable/identifiable in logs
  // or secret scanners.
  const rawKey = `bps_${randomBytes(32).toString("base64url")}`;
  const keyHash = hashApiKey(rawKey);

  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
  });

  try {
    await sql`
      insert into api_keys (key_hash, principal, role)
      values (${keyHash}, ${principal}, ${role})`;
  } catch (err) {
    console.error(`Error: failed to write api_keys row: ${err instanceof Error ? err.message : String(err)}`);
    await sql.end({ timeout: 1 }).catch(() => {});
    process.exit(1);
  }

  await sql.end({ timeout: 1 });

  console.log("API key issued. This is the ONLY time the raw key will be shown -- store it now.");
  console.log("");
  console.log(`  principal: ${principal}`);
  console.log(`  role:      ${role}`);
  console.log(`  key:       ${rawKey}`);
  console.log("");
  console.log("Use it as: Authorization: Bearer <key>");
  console.log(`To revoke later: update api_keys set revoked_at = now() where key_hash = '${keyHash}';`);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
