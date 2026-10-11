import { NextResponse } from "next/server";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { listConnectionSummaries } from "@/lib/storage/connections";

/** Admin: the server's storage connections (Box, Dropbox ... accounts and buckets) and which libraries use them. */
export async function GET(request: Request) {
  const serverId = new URL(request.url).searchParams.get("serverId");
  if (!serverId) return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
  if (!(await getCurrentServerAdmin(serverId))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ connections: await listConnectionSummaries(serverId) }, { headers: { "Cache-Control": "no-store" } });
}
