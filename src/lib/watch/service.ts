/** Mark as watched / listened to / read: checks the caller may see the thing (the same gate as playing it), then writes the rows. */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { seasons, titles } from "@/lib/db/schema";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { libraryHasDoneState } from "@/lib/libraries/profile";
import { episodeOwners, setDone, type Owner } from "./mark";

export type MarkKind = "title" | "episode" | "season" | "show";
export type MarkResult = { ok: true; count: number } | { ok: false; status: 403 | 404 };

/**
 * `title` is a movie, a video, an audiobook or audio file, or an eBook; `show` and `season` mean every episode in them. A picture, a clip in a
 * photo library and a song are not markable (they keep no place), and anything the caller can't see is "not found".
 */
export async function markDone(args: { kind: MarkKind; id: string; done: boolean }): Promise<MarkResult> {
  let auth;
  let owners: Owner[];
  if (args.kind === "episode") {
    auth = await authorizeOwner("episode", args.id);
    owners = [{ ownerKind: "episode", ownerId: args.id, durationSeconds: null }];
  } else if (args.kind === "title") {
    auth = await authorizeOwner("title", args.id, { titleKinds: ["movie", "audiobook", "ebook"] });
    owners = [{ ownerKind: "title", ownerId: args.id, durationSeconds: null }];
  } else {
    let showId = args.id;
    if (args.kind === "season") {
      const [season] = await db.select({ titleId: seasons.titleId }).from(seasons).where(eq(seasons.id, args.id)).limit(1);
      if (!season) return { ok: false, status: 404 };
      showId = season.titleId;
    }
    auth = await authorizeOwner("title", showId, { titleKinds: ["show"] });
    owners = [];
    if (auth.ok) owners = await episodeOwners(db, args.kind === "season" ? { seasonId: args.id } : { showId });
  }
  if (!auth.ok) return { ok: false, status: auth.status === 403 ? 403 : 404 };
  if (!libraryHasDoneState(auth.libraryKind)) return { ok: false, status: 404 };
  // A title or episode may carry a length worth remembering.
  if (args.done && args.kind === "title") {
    const [t] = await db.select({ runtimeSeconds: titles.runtimeSeconds }).from(titles).where(eq(titles.id, args.id)).limit(1);
    owners[0].durationSeconds = t?.runtimeSeconds ?? null;
  }
  const count = await setDone(db, { viewerId: auth.member.viewer.id, owners, done: args.done });
  return { ok: true, count };
}
