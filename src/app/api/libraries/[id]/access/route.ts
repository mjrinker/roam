import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { getLibraryAccess, setLibraryAccess } from "@/lib/libraries/access-service";

const bodySchema = z.object({
  access: z.enum(["everyone", "restricted"]),
  accountIds: z.array(z.string().uuid()).max(500),
});

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * Server admins only. Everyone else (non-members, non-admins, limited profiles, unknown or
 * malformed ids) gets the same 404, so this never confirms that a library exists.
 */
async function adminForLibrary(id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const serverId = await resolveServerIdForLibrary(id);
  if (!serverId) return null;
  return getCurrentServerAdmin(serverId);
}

export async function GET(_request: Request, ctx: RouteContext<"/api/libraries/[id]/access">) {
  const { id } = await ctx.params;
  if (!(await adminForLibrary(id))) return notFound();
  const view = await getLibraryAccess(db, id);
  return view ? NextResponse.json(view) : notFound();
}

/** Replaces the access mode and the list of accounts given access. */
export async function PUT(request: Request, ctx: RouteContext<"/api/libraries/[id]/access">) {
  const { id } = await ctx.params;
  const admin = await adminForLibrary(id);
  if (!admin) return notFound();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const result = await setLibraryAccess(db, { libraryId: id, actorAccountId: admin.profile.id, ...parsed.data });
  if (!result.ok) {
    return result.reason === "not_found"
      ? notFound()
      : NextResponse.json({ error: "Some of those people aren't members of this server." }, { status: 400 });
  }
  return NextResponse.json(await getLibraryAccess(db, id));
}
