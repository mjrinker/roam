import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { titles, watchState } from "@/lib/db/schema";
import { requireProfile } from "@/lib/auth/guards";
import { TitleCard, type TitleCardData } from "@/components/library/title-card";

export default async function LibraryPage() {
  const profile = await requireProfile();

  const allTitles = await db
    .select()
    .from(titles)
    .where(eq(titles.kind, "movie"))
    .orderBy(desc(titles.addedAt));

  const inProgress = await db
    .select()
    .from(watchState)
    .where(
      and(
        eq(watchState.profileId, profile.id),
        eq(watchState.ownerKind, "title"),
        eq(watchState.finished, false)
      )
    );

  const progressByTitleId = new Map(
    inProgress
      .filter((w) => w.durationSeconds && w.positionSeconds > 0)
      .map((w) => [w.ownerId, w.positionSeconds / w.durationSeconds!])
  );

  const continueWatching = allTitles.filter((t) => progressByTitleId.has(t.id));

  function toCard(t: (typeof allTitles)[number]): TitleCardData {
    return {
      id: t.id,
      name: t.name,
      year: t.year,
      posterUrl: t.posterUrl,
      runtimeSeconds: t.runtimeSeconds,
      progressFraction: progressByTitleId.get(t.id) ?? null,
    };
  }

  return (
    <div className="flex flex-col gap-10 px-6 py-8">
      {continueWatching.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Continue Watching</h2>
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {continueWatching.map((t) => (
              <TitleCard key={t.id} title={toCard(t)} />
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Movies</h2>
        {allTitles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No movies yet.{" "}
            {profile.role === "admin"
              ? "Head to Admin to run your first scan."
              : "Ask an admin to add some."}
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {allTitles.map((t) => (
              <TitleCard key={t.id} title={toCard(t)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
