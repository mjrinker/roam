import { NextResponse } from "next/server";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import type { BackupScope } from "./service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in profile as a member of the server in `?serverId=`; anyone else gets the same "not found". */
export async function backupScope(request: Request): Promise<{ scope: BackupScope; profileName: string; accountId: string } | { response: NextResponse }> {
  const serverId = new URL(request.url).searchParams.get("serverId") ?? "";
  const notFound = { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (!UUID.test(serverId)) return notFound;
  const member = await getCurrentServerMember(serverId);
  if (!member) return notFound;
  return { scope: { actor: libraryActor(member, serverId), viewer: member.viewer, viewerId: member.viewer.id, serverId }, profileName: member.viewer.name, accountId: member.profile.id };
}
