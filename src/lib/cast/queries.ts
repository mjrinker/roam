import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { libraries, titleCast, titleCrew, titles } from "@/lib/db/schema";
import { crewJobLabel } from "./crew-jobs";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface CastMember {
  personId: number;
  name: string;
  character: string | null;
  photoUrl: string | null;
}

/** A movie's or show's billed cast, top-billed first. (The caller has already checked the viewer may see the title.) */
export async function loadTitleCast(ex: Db, titleId: string): Promise<CastMember[]> {
  return ex
    .select({ personId: titleCast.personId, name: titleCast.name, character: titleCast.character, photoUrl: titleCast.photoUrl })
    .from(titleCast)
    .where(eq(titleCast.titleId, titleId))
    .orderBy(asc(titleCast.position));
}

export interface CrewMember {
  personId: number;
  name: string;
  photoUrl: string | null;
  /** Everything they did on it, most important first ("Director", "Writer"). */
  jobs: string[];
}

/** The key crew of a movie or show, one card per person with all their jobs, the most important job first. */
export async function loadTitleCrew(ex: Db, titleId: string): Promise<CrewMember[]> {
  const rows = await ex
    .select({ personId: titleCrew.personId, name: titleCrew.name, job: titleCrew.job, photoUrl: titleCrew.photoUrl })
    .from(titleCrew)
    .where(eq(titleCrew.titleId, titleId))
    .orderBy(asc(titleCrew.position));
  const people = new Map<number, CrewMember>();
  for (const r of rows) {
    const label = crewJobLabel(r.job);
    const p = people.get(r.personId);
    if (!p) people.set(r.personId, { personId: r.personId, name: r.name, photoUrl: r.photoUrl, jobs: [label] });
    else {
      if (!p.jobs.includes(label)) p.jobs.push(label);
      p.photoUrl ??= r.photoUrl;
    }
  }
  return [...people.values()];
}

export interface PersonPage {
  personId: number;
  name: string;
  photoUrl: string | null;
  /** The movies and shows on this server this person is in or worked on, that this viewer may see; newest first. */
  items: { id: string; kind: "movie" | "show"; name: string; year: number | null; posterUrl: string | null; roles: string[] }[];
}

/** A person and their movies and shows on this server, or null when none of them is one this actor and viewer can see. */
export async function loadPersonPage(ex: Db, actor: LibraryActor, viewer: AccessProfile, personId: number): Promise<PersonPage | null> {
  const base = (visible: SQL | undefined) => and(inArray(titles.kind, ["movie", "show"]), libraryVisible(ex, actor), contentFilter(viewer, titles.ratingAges), visible);
  const title = { id: titles.id, kind: titles.kind, name: titles.name, year: titles.year, posterUrl: titles.posterUrl };
  const acting = await ex
    .select({ ...title, personName: titleCast.name, photoUrl: titleCast.photoUrl, character: titleCast.character })
    .from(titleCast)
    .innerJoin(titles, eq(titleCast.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(base(eq(titleCast.personId, personId)));
  const crew = await ex
    .select({ ...title, personName: titleCrew.name, photoUrl: titleCrew.photoUrl, job: titleCrew.job })
    .from(titleCrew)
    .innerJoin(titles, eq(titleCrew.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(base(eq(titleCrew.personId, personId)))
    .orderBy(asc(titleCrew.position));
  if (acting.length === 0 && crew.length === 0) return null;

  const items = new Map<string, PersonPage["items"][number]>();
  const add = (t: (typeof acting)[number] | (typeof crew)[number], role: string) => {
    const item = items.get(t.id) ?? { id: t.id, kind: t.kind as "movie" | "show", name: t.name, year: t.year, posterUrl: t.posterUrl, roles: [] };
    if (!item.roles.includes(role)) item.roles.push(role);
    items.set(t.id, item);
  };
  for (const a of acting) add(a, a.character ? `as ${a.character}` : "Actor");
  for (const c of crew) add(c, crewJobLabel(c.job));
  const first = acting[0] ?? crew[0];
  return {
    personId,
    name: first.personName,
    photoUrl: [...acting, ...crew].find((r) => r.photoUrl)?.photoUrl ?? null,
    items: [...items.values()].sort((a, b) => (b.year ?? -1) - (a.year ?? -1) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  };
}
