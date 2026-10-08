import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { mediaFiles } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { createBoxProviderForServer } from "@/lib/storage/box";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import { checkRateLimit } from "@/lib/rate-limit";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * Sends the signed-in viewer to a short-lived address for a book's file in Box. It goes through the same gate as
 * everything else (library access and the profile's age limit), and EVERY failure is the same 404, so it never
 * confirms that a book exists. Nothing is cached: the address expires, and the next click asks again.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/ebooks/[id]/file">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();

  const auth = await authorizeOwner("title", id, { titleKinds: ["ebook"] });
  if (!auth.ok) return notFound();
  if (!(await checkRateLimit(auth.member.profile.id, "ebook_file", 120, 60))) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const [file] = await db
    .select({ boxFileId: mediaFiles.boxFileId })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, id), eq(mediaFiles.partIndex, 0)))
    .limit(1);
  if (!file) return notFound();

  try {
    const { url } = await createBoxProviderForServer(auth.serverId).getStreamingUrl(file.boxFileId);
    return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (err) {
    if (err instanceof BoxReauthRequiredError) return NextResponse.json({ error: "This server's Box connection needs to be reconnected by an admin." }, { status: 424 });
    throw err;
  }
}
