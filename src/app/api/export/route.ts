import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { servers } from "@/lib/db/schema";
import { backupScope } from "@/lib/backup/http";
import { buildExport } from "@/lib/backup/format";
import { exportProfile } from "@/lib/backup/service";

/** The signed-in profile's watch history, ratings, labels and watch list on this server (`?serverId=`), as a file to keep or move. */
export async function GET(request: Request) {
  const got = await backupScope(request);
  if ("response" in got) return got.response;
  const [server] = await db.select({ name: servers.name }).from(servers).where(eq(servers.id, got.scope.serverId)).limit(1);
  const body = buildExport(await exportProfile(db, got.scope), { profileName: got.profileName, serverName: server?.name ?? "", now: new Date() });
  const name = `roam-${got.profileName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile"}-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(body, { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
}
