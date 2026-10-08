import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { mediaFiles } from "@/lib/db/schema";
import { createBoxProviderForServer } from "@/lib/storage/box";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import { checkRateLimit } from "@/lib/rate-limit";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * The same short-lived Box address as /file, but as JSON, for the in-browser reader: it fetches the book itself, straight from
 * Box (which allows that from any origin), so the bytes never pass through the app. Same gate, same single 404, never cached.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/ebooks/[id]/url">) {
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
    const { url, expiresAt } = await createBoxProviderForServer(auth.serverId).getStreamingUrl(file.boxFileId);
    return NextResponse.json({ url, expiresAt: expiresAt.toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof BoxReauthRequiredError) return NextResponse.json({ error: "This server's Box connection needs to be reconnected by an admin." }, { status: 424 });
    throw err;
  }
}
