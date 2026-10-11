import postgres from "postgres";

/**
 * Database access for BPS.
 *
 * BPS runs in one of two modes, and the distinction is load-bearing rather
 * than a convenience:
 *
 *   DURABLE   -- `BPS_DATABASE_URL` is set. State lives in Postgres, where
 *                uniqueness constraints and conditional updates enforce
 *                nonce single-use, artifact-reuse detection and settlement
 *                idempotency across every serving instance.
 *
 *   EPHEMERAL -- no database. State lives in process memory. Fine for local
 *                development and for demonstrating the proof engine, but the
 *                concurrency guarantees do NOT hold: two serverless instances
 *                each get their own copy, so a nonce can be spent twice and a
 *                settlement retry after a cold start could pay twice.
 *
 * Because of that last point, settlement is REFUSED in ephemeral mode. The
 * engine will still evaluate evidence and reach APPROVED; the payout is simply
 * blocked, with an explanation, rather than risking a double transfer. Moving
 * money requires durable state.
 */

export type StoreMode = "durable" | "ephemeral";

export interface DbUnavailable {
  mode: "ephemeral";
  reason: string;
}

export interface DbAvailable {
  mode: "durable";
  sql: postgres.Sql;
}

export type DbHandle = DbAvailable | DbUnavailable;

type Globals = typeof globalThis & {
  __bpsSql?: postgres.Sql;
  __bpsSqlUrl?: string;
};

/**
 * Supabase (and most managed Postgres) expect serverless callers to use the
 * transaction pooler. We keep the client pool tiny for the same reason: each
 * serverless instance holds its own pool, so a large `max` multiplies badly.
 */
function createClient(url: string): postgres.Sql {
  return postgres(url, {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    // Prepared statements are incompatible with pgbouncer in transaction mode.
    prepare: false,
    onnotice: () => {},
  });
}

export function getDb(): DbHandle {
  const url = process.env.BPS_DATABASE_URL;
  if (!url) {
    return {
      mode: "ephemeral",
      reason: "BPS_DATABASE_URL is not set, so BPS is holding state in process memory.",
    };
  }

  const g = globalThis as Globals;
  // Reuse the pool across hot invocations; rebuild it if the URL changed.
  if (!g.__bpsSql || g.__bpsSqlUrl !== url) {
    g.__bpsSql = createClient(url);
    g.__bpsSqlUrl = url;
  }
  return { mode: "durable", sql: g.__bpsSql };
}

export function getStoreMode(): StoreMode {
  return getDb().mode;
}

/** Throws if called in ephemeral mode. Used by code paths that need real durability. */
export function requireDb(): postgres.Sql {
  const db = getDb();
  if (db.mode === "ephemeral") {
    throw new Error(`durable storage required: ${db.reason}`);
  }
  return db.sql;
}

/** Cheap liveness probe for the health endpoint. */
export async function pingDb(): Promise<{ ok: boolean; mode: StoreMode; error?: string }> {
  const db = getDb();
  if (db.mode === "ephemeral") return { ok: false, mode: "ephemeral", error: db.reason };
  try {
    await db.sql`select 1`;
    return { ok: true, mode: "durable" };
  } catch (err) {
    return { ok: false, mode: "durable", error: err instanceof Error ? err.message : String(err) };
  }
}
