/** Shared plumbing for the wishlist routes: who is asking, and that they belong to the server. */
import { NextResponse } from "next/server";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { libraryActor, type LibraryActor } from "@/lib/content/library-access";
import type { AccessProfile } from "@/lib/content/access";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export interface WishActor {
  accountId: string;
  isAdmin: boolean;
  actor: LibraryActor;
  viewer: AccessProfile;
  /** A child's profile: can look, but not change the shared list. */
  readOnly: boolean;
}

/** Whoever is signed in as a member of this server (anyone else gets the same "not found" as a server that doesn't exist). */
export async function wishActor(serverId: string): Promise<{ who: WishActor } | { response: NextResponse }> {
  if (!UUID.test(serverId)) return { response: notFound() };
  const member = await getCurrentServerMember(serverId);
  if (!member) return { response: notFound() };
  return {
    who: {
      accountId: member.profile.id,
      isAdmin: member.role === "admin" && member.viewer.role !== "limited",
      actor: libraryActor(member, serverId),
      viewer: member.viewer,
      readOnly: member.viewer.role === "limited",
    },
  };
}

export const readOnlyResponse = () => NextResponse.json({ error: "This profile can look at the wishlist but not change it." }, { status: 403 });
