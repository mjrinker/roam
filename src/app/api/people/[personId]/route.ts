import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { photoPeople } from "@/lib/db/schema";
import { deletePerson, renamePerson } from "@/lib/faces/service";
import { checkRateLimit } from "@/lib/rate-limit";

const headers = { "Cache-Control": "no-store" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });

async function adminOf(personId: string) {
  if (!z.string().uuid().safeParse(personId).success) return null;
  const [person] = await db.select({ serverId: photoPeople.serverId }).from(photoPeople).where(eq(photoPeople.id, personId)).limit(1);
  if (!person) return null;
  const admin = await getCurrentServerAdmin(person.serverId);
  if (!admin || !(await checkRateLimit(admin.profile.id, "person_change", 60, 60))) return null;
  return { serverId: person.serverId };
}

/** Renames a person (to a name another person has, the two become one). Server admin only; everyone else gets a plain not-found. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/people/[personId]">) {
  const { personId } = await ctx.params;
  const who = await adminOf(personId);
  if (!who) return notFound();
  const body = z.object({ name: z.string().min(1).max(200) }).safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Send a name." }, { status: 400, headers });
  return (await renamePerson(db, who.serverId, personId, body.data.name)) ? NextResponse.json({ ok: true }, { headers }) : NextResponse.json({ error: "That name can't be used." }, { status: 400, headers });
}

/** Removes a person; their faces stay, unnamed. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/people/[personId]">) {
  const { personId } = await ctx.params;
  const who = await adminOf(personId);
  if (!who) return notFound();
  return (await deletePerson(db, who.serverId, personId)) ? NextResponse.json({ ok: true }, { headers }) : notFound();
}
