import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { servers } from "@/lib/db/schema";
import { buildPhotoEditsExport, exportPhotoEdits } from "@/lib/backup/photo-edits";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the admin has added to this server's photos by hand (`?serverId=`): the people named and who is tagged where, dismissed faces, and
 * dates and places set by hand, as a file to keep. Admin only; everyone else gets a plain not-found.
 */
export async function GET(request: Request) {
  const serverId = new URL(request.url).searchParams.get("serverId") ?? "";
  if (!UUID.test(serverId) || !(await getCurrentServerAdmin(serverId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [server] = await db.select({ name: servers.name }).from(servers).where(eq(servers.id, serverId)).limit(1);
  const body = buildPhotoEditsExport(await exportPhotoEdits(db, serverId), { serverName: server?.name ?? "", now: new Date() });
  const name = `roam-photos-${(server?.name ?? "server").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server"}-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(body, { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
}
