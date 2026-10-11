import { NextResponse, connection } from "next/server";
import { pingDb } from "@/lib/bps/db";
import { authMode } from "@/lib/bps/auth";
import { settlementAllowed } from "@/lib/bps/store";



/**
 * Liveness/readiness probe.
 *
 * Reports the store mode, whether settlement is allowed (durable storage
 * only), and the result of an actual DB ping -- this is how we verify the
 * Supabase wiring from outside the process. A durable instance whose ping
 * fails is reported unhealthy (503); an ephemeral instance is healthy (200)
 * but with settlementAllowed: false, which is expected, not an error.
 */
export async function GET() {
  // Opt out of prerendering.
  //
  // Without this the route is statically evaluated at BUILD time and serves the
  // frozen result forever -- the probe reported the build machine's config
  // ("ephemeral", no database) regardless of how the running instance was
  // configured. `cacheComponents` rejects the `dynamic`/`revalidate` segment
  // exports, so awaiting `connection()` is the supported way to mark a handler
  // request-bound in Next 16.
  await connection();

  const db = await pingDb();
  const allowed = settlementAllowed();

  const body = {
    ok: db.mode === "ephemeral" ? true : db.ok,
    mode: db.mode,
    // Surfaced deliberately: "open" means unauthenticated writes are accepted,
    // which an operator needs to be able to discover without reading the env.
    authMode: authMode(),
    settlementAllowed: allowed,
    db,
  };

  const status = db.mode === "durable" && !db.ok ? 503 : 200;
  return NextResponse.json(body, { status });
}
