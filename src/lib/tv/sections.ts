/** The extra blocks on a TV movie page: parental guide, chapters, extras, cast and who owns it (the same facts as the web page, laid out as lines and buttons). */
import { and, asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { CATEGORY_LABELS, SEVERITY_LABELS, severityAtLeast } from "@/lib/content-filter/categories";
import { guideFromCues } from "@/lib/content-filter/playback";
import { cuesFromRows } from "@/lib/content-filter/rows";
import { chaptersFromRows } from "@/lib/chapters/rows";
import { loadTitleCast } from "@/lib/cast/queries";
import { mediaFiles } from "@/lib/db/schema";
import { loadDddForMovie } from "@/lib/ddd/page";
import { mergeGuideLines } from "@/lib/ddd/transform";
import { EXTRA_LABELS } from "@/lib/extras/categories";
import { loadTitleExtras } from "@/lib/extras/load";
import { formatClock } from "@/tv/client/clock";
import { formatRuntime } from "@/lib/format";
import { ownershipView } from "@/lib/ownership/view";
import { defaultVersionRows } from "@/lib/player/versions";
import type { TvWho } from "@/lib/tv/context";
import type { TvSection } from "@/tv/render";
import type { LibraryKind } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const lengthWords = (seconds: number) => (seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${seconds} sec`);
/** A long list is cut here: a TV page is for moving through with arrow keys. */
const MAX_CHAPTERS = 40;
const MAX_CAST = 10;

/** Who owns it, and the buttons that person has (claim, withdraw, share again). Null when the server doesn't track ownership. */
export async function ownershipSections(ex: Db, ctx: { serverId: string; base: string; who: TvWho; viewerId: string; libraryKind: LibraryKind; titleId: string; seasonId?: string | null; back: string }): Promise<TvSection[]> {
  const view = await ownershipView(ex, { serverId: ctx.serverId, titleId: ctx.titleId, libraryKind: ctx.libraryKind, accountId: ctx.who.accountId, viewerId: ctx.viewerId, isAdmin: false });
  if (!view) return [];
  const units = ctx.seasonId === undefined ? view.units : view.units.filter((u) => u.seasonId === (ctx.seasonId ?? null));
  return units.map((u) => {
    const mineLine = u.owners.length === 0 ? "Nobody has claimed this yet, so everyone can watch it." : u.owners.map((o) => `${o.mine ? "You" : o.name}${o.shared ? "" : " (withdrawn)"}`).join(", ");
    const field = (action: string) => ({ action, titleId: ctx.titleId, seasonId: u.seasonId ?? "", back: ctx.back });
    const posts: NonNullable<TvSection["posts"]> = [];
    let note: string | null = u.playable ? null : "Every owner has withdrawn this, so it can't be played right now.";
    if (!ctx.who.limited) {
      if (u.iOwn) {
        posts.push({ action: `${ctx.base}/ownership`, label: u.myShared ? "Withdraw my copy" : "Share my copy again", fields: field(u.myShared ? "withdraw" : "share") });
        posts.push({ action: `${ctx.base}/ownership`, label: "I don't own this", fields: field("giveup") });
      } else if (u.myClaim && u.myClaim.status !== "rejected") {
        note = u.myClaim.status === "evidence_requested" ? `The admin asked for evidence${u.myClaim.note ? `: ${u.myClaim.note}` : ""}. Send a picture from the web version of Roam.` : "Your claim is waiting for the admin to review it.";
      } else {
        if (u.myClaim?.status === "rejected") note = `Your last claim wasn't accepted${u.myClaim.note ? `: ${u.myClaim.note}` : "."}`;
        posts.push({ action: `${ctx.base}/ownership`, label: "I own a copy", fields: field("claim") });
      }
    }
    return { heading: u.label ? `Who owns ${u.label.toLowerCase()}` : "Who owns it", lines: [{ text: mineLine }], note, posts };
  });
}

/** Parental guide, chapters, extras and cast for a movie. */
export async function movieSections(ex: Db, ctx: { serverId: string; base: string; who: TvWho; titleId: string; title: { imdbId: string | null; tmdbId: number | null } }): Promise<TvSection[]> {
  const out: TvSection[] = [];
  const segments = defaultVersionRows(await ex.select().from(mediaFiles).where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, ctx.titleId))).orderBy(asc(mediaFiles.partIndex)));

  const ddd = await loadDddForMovie(ex, ctx.serverId, ctx.title, ctx.who.filterPrefs);
  const lines = mergeGuideLines(guideFromCues(cuesFromRows(segments)), ddd.lines);
  if (lines.length > 0 || ddd.reports.length > 0) {
    const fromCommunity = ddd.reports.length > 0 || lines.some((l) => l.source === "community");
    out.push({
      heading: "Parental guide",
      lines: [
        ...lines.map((l) => {
          const threshold = ctx.who.filterPrefs[l.category];
          const skipped = threshold !== undefined && severityAtLeast(l.severity, threshold);
          return { text: `${CATEGORY_LABELS[l.category]}${l.source === "community" ? "" : ` · ${SEVERITY_LABELS[l.severity]}`}`, sub: `${l.source === "community" ? "Reported by the community · " : ""}${l.scenes} scene${l.scenes === 1 ? "" : "s"} · ${lengthWords(l.seconds)}${skipped ? " · skipped for you" : ""}` };
        }),
        ...ddd.reports.map((r) => ({ text: r.topicName, sub: `${r.yes} yes, ${r.no} no` })),
      ],
      // Does the Dog Die's terms: its credit, and that these reports are not verified, wherever its data shows.
      note: fromCommunity ? "Powered by DoesTheDogDie.com. These reports come from the community, aren't verified, and may be incomplete: no warning doesn't mean the content isn't there." : null,
    });
  }

  const chapters = segments.length > 0 && segments.every((s) => s.durationSeconds != null) ? chaptersFromRows(segments) : [];
  if (chapters.length > 1) {
    out.push({
      heading: "Chapters",
      lines: chapters.slice(0, MAX_CHAPTERS).map((c) => ({ text: c.title, sub: formatClock(c.startSeconds), href: `${ctx.base}/watch/title/${ctx.titleId}?t=${Math.floor(c.startSeconds)}` })),
      note: chapters.length > MAX_CHAPTERS ? `The first ${MAX_CHAPTERS} of ${chapters.length} chapters.` : null,
    });
  }

  for (const group of await loadTitleExtras(ex, ctx.titleId)) {
    out.push({ heading: EXTRA_LABELS[group.category], lines: group.items.map((e) => ({ text: e.name, sub: formatRuntime(e.durationSeconds), href: `${ctx.base}/watch/extra/${e.id}` })) });
  }

  const cast = (await loadTitleCast(ex, ctx.titleId)).slice(0, MAX_CAST);
  if (cast.length > 0) out.push({ heading: "Cast", lines: cast.map((c) => ({ text: c.name, sub: c.character })) });
  return out;
}
