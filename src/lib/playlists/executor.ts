import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "@/lib/db/schema";

/**
 * Anything that can run queries: the global `db`, a transaction, or the pglite
 * test database. Playlist helpers take one of these so code inside
 * `db.transaction(async (tx) => ...)` can pass `tx` — the global `db` must never
 * be touched inside a transaction (the pool has a single connection, so it
 * would wait forever).
 */
export type Executor = PgDatabase<PgQueryResultHKT, typeof schema>;
