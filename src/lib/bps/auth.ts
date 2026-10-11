/**
 * API authentication for BPS.
 *
 * Every mutating endpoint must call `requireAuth(req, role)` before doing
 * anything else. The credential is a bearer API key; it is SHA-256 hashed
 * before it ever touches a comparison or a query, so the raw key exists
 * only transiently in this process and is never stored, logged, or echoed
 * anywhere (the one exception, by design, is the one-time print in
 * `scripts/issue-api-key.mjs`).
 *
 * Three modes, in order of preference, chosen entirely by which env vars
 * are set (see `authMode()`):
 *
 *   database        BPS_DATABASE_URL is set. Keys live in the `api_keys`
 *                    table (`key_hash` PK, `principal`, `role`,
 *                    `revoked_at`). This is the only mode that supports
 *                    multiple distinct credentials, per-key revocation, and
 *                    an audit trail of who did what. Use this in production.
 *
 *   bootstrap-key    No database, but BPS_BOOTSTRAP_API_KEY is set. There is
 *                    no api_keys table to read in this mode, so exactly one
 *                    key works, and it is always treated as role `admin`
 *                    (admin satisfies every required role). This exists so
 *                    an operator can lock down an ephemeral/demo deployment
 *                    with a single shared secret without standing up
 *                    Postgres first.
 *
 *   open             *** NAMED, DELIBERATE ESCAPE HATCH -- NOT AN ACCIDENT ***
 *                    Neither BPS_DATABASE_URL nor BPS_BOOTSTRAP_API_KEY is
 *                    set. Every request is let through, unauthenticated,
 *                    with principal `'anonymous:open-mode'`. This exists
 *                    only so the public demo keeps working out of the box
 *                    with zero configuration. It is NOT safe for anything
 *                    that holds real funds or real user data. `authMode()`
 *                    reports this so `/api/health` and operators can see,
 *                    loudly, that a deployment is running wide open.
 *
 * Nothing in this module logs the Authorization header, the raw key, or any
 * derived secret.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";

export type Role = "agent" | "worker" | "admin";

export type AuthMode = "database" | "bootstrap-key" | "open";

/** Which auth mode is live, decided purely from env vars (see module doc). */
export function authMode(): AuthMode {
  if (process.env.BPS_DATABASE_URL) return "database";
  if (process.env.BPS_BOOTSTRAP_API_KEY) return "bootstrap-key";
  return "open";
}

/** SHA-256 of a raw API key, as lowercase hex. Never hash the key for display. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Timing-safe comparison of two SHA-256 hex digests. Used instead of `===`
 * for the bootstrap-key path, where there is no database lookup to hide the
 * comparison inside. Hex digests of the same algorithm are always the same
 * length, but we guard the mismatched-length case anyway rather than assume.
 */
function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still perform a constant-time comparison (against itself) so the
    // early return above does not become a length oracle in practice.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Resolve a raw bearer key to a principal + role, or null if it is unknown,
 * malformed, or revoked. Never throws on a bad key -- only on real
 * infrastructure failure (e.g. the database is unreachable).
 */
export async function verifyApiKey(raw: string): Promise<{ principal: string; role: Role } | null> {
  if (!raw) return null;
  const hash = hashApiKey(raw);

  const db = getDb();
  if (db.mode === "durable") {
    const rows = await db.sql`
      select principal, role, revoked_at from api_keys where key_hash = ${hash}`;
    const row = rows[0] as { principal: string; role: string; revoked_at: string | null } | undefined;
    if (!row) return null;
    if (row.revoked_at) return null;
    return { principal: row.principal, role: row.role as Role };
  }

  // No database: fall back to the single bootstrap key, if configured.
  const bootstrap = process.env.BPS_BOOTSTRAP_API_KEY;
  if (!bootstrap) return null; // open mode never reaches verifyApiKey; see requireAuth.
  const bootstrapHash = hashApiKey(bootstrap);
  if (!timingSafeHexEqual(hash, bootstrapHash)) return null;
  return { principal: "bootstrap:admin", role: "admin" };
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const UNAUTHENTICATED = () => jsonResponse(401, { error: "unauthenticated" });
const FORBIDDEN = () => jsonResponse(403, { error: "forbidden" });

/**
 * The single entry point every mutating route should call first.
 *
 * Reads ONLY `Authorization: Bearer <key>`. On success, returns the
 * principal that authenticated. On failure, returns a ready-to-return
 * `Response` (401 for missing/malformed/unknown/revoked credentials, 403
 * for a valid credential whose role doesn't satisfy what's required) --
 * `admin` always satisfies any required role.
 */
export async function requireAuth(
  req: Request,
  role: Role,
): Promise<{ ok: true; principal: string } | { ok: false; response: Response }> {
  if (authMode() === "open") {
    return { ok: true, principal: "anonymous:open-mode" };
  }

  const header = req.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, response: UNAUTHENTICATED() };
  }
  const raw = match[1].trim();
  if (!raw) {
    return { ok: false, response: UNAUTHENTICATED() };
  }

  const identity = await verifyApiKey(raw);
  if (!identity) {
    return { ok: false, response: UNAUTHENTICATED() };
  }

  if (identity.role !== "admin" && identity.role !== role) {
    return { ok: false, response: FORBIDDEN() };
  }

  return { ok: true, principal: identity.principal };
}
