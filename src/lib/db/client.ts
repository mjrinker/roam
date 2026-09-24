import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// A single pooled connection reused across invocations in the same runtime.
// On Vercel's serverless functions each cold start creates a fresh pool, so
// keep max low — Supabase's pooler (port 6543) is designed for exactly this.
declare global {
  var __roamPg: postgres.Sql | undefined;
}

function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return postgres(connectionString, { max: 1, prepare: false });
}

const client = globalThis.__roamPg ?? createClient();
if (process.env.NODE_ENV !== "production") {
  globalThis.__roamPg = client;
}

export const db = drizzle(client, { schema });
