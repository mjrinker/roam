/**
 * Faces in photos: who is in a picture, and suggesting the people already named. A server's admin names faces (a name is a PERSON of the
 * server); the machine only ever suggests, from how alike two fingerprints are, until the admin confirms. Nothing here looks at pixels: the
 * boxes and fingerprints come from scripts/scan-faces.ts.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, photoFaces, photoPeople, titles } from "@/lib/db/schema";
import { fromBytes, similarity } from "@/lib/faces/geometry";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** How alike a face must be to a named one to be suggested (cosine similarity; the model's authors use 0.363 for "the same person"). */
export const SUGGEST_MIN = 0.42;
/** Faces kept per person to compare against: the best ones, so a person with thousands of tags doesn't slow every suggestion. */
const EXEMPLARS_PER_PERSON = 60;
const PAGE = 1500;
const WRITE_CHUNK = 250;

export interface Exemplar {
  personId: string;
  embedding: Float32Array;
}

/** For each untagged face, the named person it most resembles (if it resembles one at least `min`), by its closest tagged face. Pure. */
export function bestMatches(faces: { id: string; embedding: Float32Array }[], exemplars: Exemplar[], min = SUGGEST_MIN): Map<string, { personId: string; score: number }> {
  const out = new Map<string, { personId: string; score: number }>();
  for (const face of faces) {
    let best: { personId: string; score: number } | null = null;
    for (const ex of exemplars) {
      const score = similarity(face.embedding, ex.embedding);
      if (score >= min && (!best || score > best.score)) best = { personId: ex.personId, score };
    }
    if (best) out.set(face.id, best);
  }
  return out;
}

const inServer = (serverId: string) => sql`EXISTS (SELECT 1 FROM ${titles} t JOIN ${libraries} l ON l.id = t.library_id WHERE t.id = ${photoFaces.titleId} AND l.server_id = ${serverId})`;

/** Looks at every face nobody has named or dismissed on this server and (re)writes its suggestion. Returns how many now have one. */
export async function refreshSuggestions(db: Db, serverId: string): Promise<number> {
  const tagged = await db
    .select({ personId: photoFaces.personId, embedding: photoFaces.embedding, score: photoFaces.score })
    .from(photoFaces)
    .where(and(isNotNull(photoFaces.personId), eq(photoFaces.ignored, false), inServer(serverId)));
  const byPerson = new Map<string, { embedding: Float32Array; score: number }[]>();
  for (const t of tagged) {
    const list = byPerson.get(t.personId!) ?? [];
    list.push({ embedding: fromBytes(t.embedding), score: t.score });
    byPerson.set(t.personId!, list);
  }
  const exemplars: Exemplar[] = [];
  for (const [personId, list] of byPerson) {
    for (const e of list.sort((a, b) => b.score - a.score).slice(0, EXEMPLARS_PER_PERSON)) exemplars.push({ personId, embedding: e.embedding });
  }

  let withSuggestion = 0;
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await db
      .select({ id: photoFaces.id, embedding: photoFaces.embedding, suggested: photoFaces.suggestedPersonId, suggestedScore: photoFaces.suggestedScore })
      .from(photoFaces)
      .where(and(isNull(photoFaces.personId), eq(photoFaces.ignored, false), gt(photoFaces.id, after), inServer(serverId)))
      .orderBy(asc(photoFaces.id))
      .limit(PAGE);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;
    const matches = bestMatches(rows.map((r) => ({ id: r.id, embedding: fromBytes(r.embedding) })), exemplars);
    withSuggestion += matches.size;
    const changed = rows.filter((r) => {
      const m = matches.get(r.id);
      return (m?.personId ?? null) !== r.suggested || (m && Math.abs(m.score - (r.suggestedScore ?? 0)) > 0.001);
    });
    for (let i = 0; i < changed.length; i += WRITE_CHUNK) {
      const chunk = changed.slice(i, i + WRITE_CHUNK);
      const ids = chunk.map((c) => c.id);
      const person = sql.join(chunk.map((c) => sql`WHEN ${c.id}::uuid THEN ${matches.get(c.id)?.personId ?? null}::uuid`), sql` `);
      const score = sql.join(chunk.map((c) => sql`WHEN ${c.id}::uuid THEN ${matches.get(c.id)?.score ?? null}::real`), sql` `);
      await db
        .update(photoFaces)
        .set({ suggestedPersonId: sql`CASE ${photoFaces.id} ${person} END`, suggestedScore: sql`CASE ${photoFaces.id} ${score} END` })
        .where(inArray(photoFaces.id, ids));
    }
    if (rows.length < PAGE) break;
  }
  return withSuggestion;
}

export interface PhotoFace {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  person: { id: string; name: string } | null;
  suggestion: { id: string; name: string; score: number } | null;
}

/** The faces found in one picture, left to right, with who they are (or who they might be). Dismissed ones are left out. */
export async function facesOfPhoto(db: Db, titleId: string): Promise<PhotoFace[]> {
  const suggested = sql`(SELECT p.name FROM ${photoPeople} p WHERE p.id = ${photoFaces.suggestedPersonId})`;
  const named = sql`(SELECT p.name FROM ${photoPeople} p WHERE p.id = ${photoFaces.personId})`;
  const rows = await db
    .select({
      id: photoFaces.id,
      x: photoFaces.x,
      y: photoFaces.y,
      w: photoFaces.w,
      h: photoFaces.h,
      personId: photoFaces.personId,
      personName: sql<string | null>`${named}`,
      suggestedId: photoFaces.suggestedPersonId,
      suggestedName: sql<string | null>`${suggested}`,
      suggestedScore: photoFaces.suggestedScore,
    })
    .from(photoFaces)
    .where(and(eq(photoFaces.titleId, titleId), eq(photoFaces.ignored, false)))
    .orderBy(asc(photoFaces.x), asc(photoFaces.id));
  return rows.map((r) => ({
    id: r.id,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    person: r.personId && r.personName ? { id: r.personId, name: r.personName } : null,
    suggestion: !r.personId && r.suggestedId && r.suggestedName ? { id: r.suggestedId, name: r.suggestedName, score: r.suggestedScore ?? 0 } : null,
  }));
}

export interface Person {
  id: string;
  name: string;
  photos: number;
  /** A face to show for them. */
  coverFaceId: string | null;
}

/** The people tagged in one photo library, most photos first (a server's people are shared, but a library only counts its own pictures). */
export async function peopleInLibrary(db: Db, libraryId: string): Promise<Person[]> {
  const rows = await db
    .select({
      id: photoPeople.id,
      name: photoPeople.name,
      photos: sql<number>`count(DISTINCT ${photoFaces.titleId})::int`,
      cover: sql<string | null>`(array_agg(${photoFaces.id} ORDER BY ${photoFaces.score} DESC))[1]`,
    })
    .from(photoPeople)
    .innerJoin(photoFaces, and(eq(photoFaces.personId, photoPeople.id), eq(photoFaces.ignored, false)))
    .innerJoin(titles, and(eq(titles.id, photoFaces.titleId), eq(titles.libraryId, libraryId)))
    .groupBy(photoPeople.id, photoPeople.name)
    .orderBy(sql`count(DISTINCT ${photoFaces.titleId}) DESC`, asc(photoPeople.name));
  return rows.map((r) => ({ id: r.id, name: r.name, photos: r.photos, coverFaceId: r.cover }));
}

/** Every person of the server, by name (for the picker an admin names faces from). */
export async function peopleOfServer(db: Db, serverId: string): Promise<{ id: string; name: string }[]> {
  return db.select({ id: photoPeople.id, name: photoPeople.name }).from(photoPeople).where(eq(photoPeople.serverId, serverId)).orderBy(sql`lower(${photoPeople.name})`);
}

export type FaceChange = { person: string } | { newPerson: string } | { confirm: true } | { person: null } | { ignore: true };

export const cleanName = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * Applies an admin's decision about one face of this server: name it (an existing person or a new one), confirm the suggestion, take the name
 * off, or dismiss it as not a face. Returns the server's id when the face is one of its own, else null. Naming a face re-reads the suggestions,
 * since each tag teaches the next.
 */
export async function changeFace(db: Db, serverId: string, faceId: string, change: FaceChange): Promise<{ ok: true; personId: string | null } | { ok: false }> {
  const [face] = await db
    .select({ id: photoFaces.id, suggested: photoFaces.suggestedPersonId })
    .from(photoFaces)
    .where(and(eq(photoFaces.id, faceId), inServer(serverId)))
    .limit(1);
  if (!face) return { ok: false };

  let personId: string | null = null;
  if ("ignore" in change) {
    await db.update(photoFaces).set({ ignored: true, personId: null, suggestedPersonId: null, suggestedScore: null }).where(eq(photoFaces.id, faceId));
    return { ok: true, personId: null };
  }
  if ("confirm" in change) {
    if (!face.suggested) return { ok: false };
    personId = face.suggested;
  } else if ("newPerson" in change) {
    const name = cleanName(change.newPerson);
    if (!name) return { ok: false };
    // The same name (any capitals) is the same person.
    const [existing] = await db.select({ id: photoPeople.id }).from(photoPeople).where(and(eq(photoPeople.serverId, serverId), sql`lower(${photoPeople.name}) = lower(${name})`)).limit(1);
    personId = existing?.id ?? (await db.insert(photoPeople).values({ serverId, name }).returning({ id: photoPeople.id }))[0].id;
  } else if (change.person !== null) {
    const [person] = await db.select({ id: photoPeople.id }).from(photoPeople).where(and(eq(photoPeople.id, change.person), eq(photoPeople.serverId, serverId))).limit(1);
    if (!person) return { ok: false };
    personId = person.id;
  }
  await db.update(photoFaces).set({ personId, suggestedPersonId: null, suggestedScore: null, ignored: false }).where(eq(photoFaces.id, faceId));
  await refreshSuggestions(db, serverId);
  return { ok: true, personId };
}

/** Removes a person (their faces stay, unnamed, and may be suggested to someone else). */
export async function deletePerson(db: Db, serverId: string, personId: string): Promise<boolean> {
  const gone = await db.delete(photoPeople).where(and(eq(photoPeople.id, personId), eq(photoPeople.serverId, serverId))).returning({ id: photoPeople.id });
  if (gone.length === 0) return false;
  await refreshSuggestions(db, serverId);
  return true;
}

/** Renames a person; to a name another person already has, the two become one (this person's faces move to the other). */
export async function renamePerson(db: Db, serverId: string, personId: string, name: string): Promise<boolean> {
  const clean = cleanName(name);
  if (!clean) return false;
  const [mine] = await db.select({ id: photoPeople.id }).from(photoPeople).where(and(eq(photoPeople.id, personId), eq(photoPeople.serverId, serverId))).limit(1);
  if (!mine) return false;
  const [other] = await db.select({ id: photoPeople.id }).from(photoPeople).where(and(eq(photoPeople.serverId, serverId), sql`lower(${photoPeople.name}) = lower(${clean})`, sql`${photoPeople.id} <> ${personId}`)).limit(1);
  if (other) {
    await db.update(photoFaces).set({ personId: other.id }).where(eq(photoFaces.personId, personId));
    await db.delete(photoPeople).where(eq(photoPeople.id, personId));
  } else {
    await db.update(photoPeople).set({ name: clean }).where(eq(photoPeople.id, personId));
  }
  await refreshSuggestions(db, serverId);
  return true;
}

/** The picture a face is on, or null for a face that doesn't exist. */
export async function faceTitleId(db: Db, faceId: string): Promise<string | null> {
  const [row] = await db.select({ titleId: photoFaces.titleId }).from(photoFaces).where(eq(photoFaces.id, faceId)).limit(1);
  return row?.titleId ?? null;
}

/** A face's small picture, or null. */
export async function faceThumb(db: Db, faceId: string): Promise<Buffer | null> {
  const [row] = await db.select({ thumb: photoFaces.thumb }).from(photoFaces).where(eq(photoFaces.id, faceId)).limit(1);
  return row?.thumb ?? null;
}
