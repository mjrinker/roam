/** The extra blocks on a TV movie page: parental guide, chapters, extras, cast and who owns it (the same facts as the web page, laid out as lines and buttons). */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { CATEGORY_LABELS, SEVERITY_LABELS } from "@/lib/content-filter/categories";
import { loadMovieExtras } from "@/lib/title-extras";
import { EXTRA_LABELS } from "@/lib/extras/categories";
import { formatClock } from "@/tv/client/clock";
import { formatRuntime } from "@/lib/format";
import { nearestHalf, starsText } from "@/lib/ratings/stars";
import { ownershipView } from "@/lib/ownership/view";
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
  const m = await loadMovieExtras(ex, { serverId: ctx.serverId, titleId: ctx.titleId, title: ctx.title, filterPrefs: ctx.who.filterPrefs, maxCast: MAX_CAST });

  if (m.guide.lines.length > 0 || m.guide.reports.length > 0) {
    out.push({
      heading: "Parental guide",
      lines: [
        ...m.guide.lines.map((l) => ({ text: `${CATEGORY_LABELS[l.category]}${l.severity ? ` · ${SEVERITY_LABELS[l.severity]}` : ""}`, sub: `${l.source === "community" ? "Reported by the community · " : ""}${l.scenes} scene${l.scenes === 1 ? "" : "s"} · ${lengthWords(l.seconds)}${l.skippedForYou ? " · skipped for you" : ""}` })),
        ...m.guide.reports.map((r) => ({ text: r.topic, sub: `${r.yes} yes, ${r.no} no` })),
      ],
      // Does the Dog Die's terms: its credit, and that these reports are not verified, wherever its data shows.
      note: m.guide.fromCommunity ? "Powered by DoesTheDogDie.com. These reports come from the community, aren't verified, and may be incomplete: no warning doesn't mean the content isn't there." : null,
    });
  }
  if (m.chapters.length > 0) {
    out.push({
      heading: "Chapters",
      lines: m.chapters.slice(0, MAX_CHAPTERS).map((c) => ({ text: c.title, sub: formatClock(c.startSeconds), href: `${ctx.base}/watch/title/${ctx.titleId}?t=${Math.floor(c.startSeconds)}` })),
      note: m.chapters.length > MAX_CHAPTERS ? `The first ${MAX_CHAPTERS} of ${m.chapters.length} chapters.` : null,
    });
  }
  for (const group of m.extras) {
    out.push({ heading: EXTRA_LABELS[group.category as keyof typeof EXTRA_LABELS], lines: group.items.map((e) => ({ text: e.name, sub: formatRuntime(e.durationSeconds), href: `${ctx.base}/watch/extra/${e.id}` })) });
  }
  if (m.cast.length > 0) out.push({ heading: "Cast", lines: m.cast.map((c) => ({ text: c.name, sub: c.character })) });
  return out;
}

/** "Your rating" on a TV page: the whole stars to give (a half-star rating made on the web shows as it is), and a button to clear it. */
export function ratingSection(args: { base: string; kind: "title" | "episode" | "album"; id: string; back: string; mine: number | null; average?: { halfStars: number; count: number } | null }): TvSection {
  const fields = (stars: number) => ({ kind: args.kind, id: args.id, stars: String(stars), back: args.back });
  return {
    heading: args.mine
      ? `Your rating: ${starsText(args.mine)} ${args.mine === 2 ? "star" : "stars"}`
      : args.average
        ? `Your rating (everyone on this server gave it ${starsText(nearestHalf(args.average.halfStars))} on average, from ${args.average.count} ${args.average.count === 1 ? "rating" : "ratings"})`
        : "Your rating",
    lines: [],
    posts: [...[1, 2, 3, 4, 5].map((n) => ({ action: `${args.base}/rate`, label: `${"★".repeat(n)}`, fields: fields(n) })), ...(args.mine ? [{ action: `${args.base}/rate`, label: "Clear", fields: fields(0) }] : [])],
  };
}
