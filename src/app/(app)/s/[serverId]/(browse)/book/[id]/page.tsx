import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { Headphones, Loader2 } from "lucide-react";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titles, watchState } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { formatRemaining, formatRuntime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { TitleResyncButton } from "@/components/admin/title-resync-button";
import { BookChapters, BookPlayButton } from "@/components/audio/book-controls";

export default async function BookDetailPage({ params }: PageProps<"/s/[serverId]/book/[id]">) {
  const { serverId, id } = await params;
  const { profile, role } = await requireServerMember(serverId);

  // Join through libraries so a book id from a DIFFERENT server 404s here,
  // rather than trusting the bare id from the URL.
  const [book] = await db
    .select({ title: titles })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titles.id, id), eq(libraries.serverId, serverId)))
    .limit(1)
    .then((rows) => rows.map((r) => r.title));
  if (!book) notFound();
  if (book.kind === "show") redirect(`/s/${serverId}/show/${id}`);
  if (book.kind === "movie") redirect(`/s/${serverId}/title/${id}`);

  const files = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, id)))
    .orderBy(asc(mediaFiles.partIndex));

  const [state] = await db
    .select()
    .from(watchState)
    .where(
      and(
        eq(watchState.profileId, profile.id),
        eq(watchState.ownerKind, "title"),
        eq(watchState.ownerId, id)
      )
    )
    .limit(1);

  const ready = files.length > 0 && files.every((f) => f.durationSeconds != null);
  const totalSeconds = files.reduce((sum, f) => sum + (f.durationMs ?? (f.durationSeconds ?? 0) * 1000), 0) / 1000;
  const hasProgress = !!state && !state.finished && state.positionSeconds > 0;
  const remaining =
    hasProgress && state.durationSeconds ? formatRemaining(state.durationSeconds, state.positionSeconds) : null;
  const progressFraction = hasProgress && state.durationSeconds ? state.positionSeconds / state.durationSeconds : 0;

  const authors = book.authors?.length ? book.authors : book.folderAuthor ? [book.folderAuthor] : [];
  const narrators = book.narrators ?? [];
  const chapters = book.chapters ?? [];
  const seriesLine = book.seriesName
    ? book.seriesPosition
      ? `${book.seriesName} · Book ${book.seriesPosition}`
      : book.seriesName
    : null;

  return (
    <div className="pb-12">
      <section className="relative isolate -mt-16 overflow-hidden pt-16">
        {book.posterUrl && (
          <Image
            src={book.posterUrl}
            alt=""
            fill
            sizes="100vw"
            className="-z-10 scale-125 object-cover opacity-30 blur-3xl"
            aria-hidden="true"
          />
        )}
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-transparent via-background/40 to-background" />

        <div className="mx-auto flex max-w-5xl flex-col items-center gap-8 px-4 py-10 sm:px-8 md:flex-row md:items-end">
          <div className="relative aspect-square w-56 shrink-0 overflow-hidden rounded-2xl bg-muted shadow-[0_30px_70px_-20px_rgba(0,0,0,0.9)] ring-1 ring-white/10 md:w-72">
            {book.posterUrl ? (
              <Image src={book.posterUrl} alt={book.name} fill sizes="288px" className="object-cover" priority />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-secondary via-muted to-background p-6 text-center">
                <Headphones className="size-10 text-muted-foreground/60" />
                <span className="line-clamp-4 text-sm font-medium text-muted-foreground">{book.name}</span>
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col items-center gap-4 text-center md:items-start md:text-left">
            {seriesLine && (
              <span className="text-xs font-semibold tracking-[0.16em] text-primary uppercase">{seriesLine}</span>
            )}
            <h1 className="text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
              {book.name}
            </h1>
            <div className="space-y-0.5 text-sm text-muted-foreground">
              {authors.length > 0 && (
                <p>
                  By <span className="text-foreground">{authors.join(", ")}</span>
                </p>
              )}
              {narrators.length > 0 && (
                <p>
                  Narrated by <span className="text-foreground">{narrators.join(", ")}</span>
                </p>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {[
                book.year ? String(book.year) : null,
                formatRuntime(totalSeconds || book.runtimeSeconds),
                chapters.length > 1 ? `${chapters.length} chapters` : null,
                files.length > 1 ? `${files.length} files` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {book.genres && book.genres.length > 0 && (
              <div className="flex flex-wrap justify-center gap-1.5 md:justify-start">
                {book.genres.map((g) => (
                  <Badge key={g} variant="secondary">
                    {g}
                  </Badge>
                ))}
              </div>
            )}

            {ready ? (
              <div className="flex w-full flex-col items-center gap-2 md:items-start">
                <BookPlayButton titleId={book.id} hasProgress={hasProgress} />
                {hasProgress && (
                  <div className="flex w-full max-w-xs items-center gap-2.5 text-xs text-muted-foreground">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/15">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, progressFraction * 100)}%` }}
                      />
                    </div>
                    {remaining}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-xl bg-white/[0.06] px-4 py-3 text-sm ring-1 ring-white/10">
                {files.length > 0 && <Loader2 className="size-4 animate-spin text-primary" />}
                <span className="text-foreground/80">
                  {files.length === 0
                    ? "No playable audio found in this book's folder yet."
                    : "Getting this book ready to play…"}
                </span>
              </div>
            )}
            {role === "admin" && <TitleResyncButton titleId={book.id} titleName={book.name} />}
          </div>
        </div>
      </section>

      <div className="mx-auto flex max-w-5xl flex-col gap-10 px-4 sm:px-8">
        {book.overview && (
          <section className="max-w-3xl">
            <h2 className="mb-3 text-lg font-semibold">About this book</h2>
            <p className="text-sm leading-relaxed whitespace-pre-line text-foreground/80">{book.overview}</p>
          </section>
        )}

        {ready && chapters.length > 0 && (
          <section>
            <h2 className="mb-3 text-lg font-semibold">Chapters</h2>
            <BookChapters titleId={book.id} chapters={chapters} totalSeconds={totalSeconds} />
          </section>
        )}
      </div>
    </div>
  );
}
