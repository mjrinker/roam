/**
 * What an admin has added to a server's photos by hand, as a file to keep and bring back: the people named, who is tagged in which picture (as
 * a box on the picture, so it survives the faces being searched for again), dismissed faces, and dates and places set by hand. Pictures are
 * named by library, folder and file name, never by this server's ids. The faces themselves (their fingerprints) are not kept: they are found
 * again by scripts/scan-faces.ts, and a tag is then put back on the face that sits where it was.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, mediaFiles, photoFaces, photoPeople, titles } from "@/lib/db/schema";
import { photoKey, photoRefFrom, type PhotoRef } from "@/lib/backup/format";
import { cleanName, refreshSuggestions } from "@/lib/faces/service";
import { PHOTO_LIBRARY_KINDS } from "@/lib/libraries/profile";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const PHOTO_EDITS_FORMAT = "roam-photo-edits";
const MAX_ITEMS = 200_000;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PhotoEdits {
  people: string[];
  tags: { photo: PhotoRef; box: Box; person: string }[];
  dismissed: { photo: PhotoRef; box: Box }[];
  dates: { photo: PhotoRef; takenAt: string }[];
  /** A place set by hand; `latitude: null` is a place taken away by hand. */
  places: { photo: PhotoRef; latitude: number | null; longitude: number | null; name: string | null }[];
}

export const emptyEdits = (): PhotoEdits => ({ people: [], tags: [], dismissed: [], dates: [], places: [] });

/** How much of the smaller box two boxes share, 0 to 1 (a box and the same face found again at a slightly different size still match). */
export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

const photoRows = (ex: Db, serverId: string) =>
  ex
    .select({ id: titles.id, library: libraries.name, folder: titles.folderPath, filename: mediaFiles.filename })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.partIndex, 0)))
    .where(and(eq(libraries.serverId, serverId), inArray(libraries.kind, [...PHOTO_LIBRARY_KINDS]), inArray(titles.kind, ["photo", "movie"])));

const refOf = (r: { library: string; folder: string | null; filename: string }): PhotoRef => ({ library: r.library, folder: r.folder ?? "", filename: r.filename });

export async function exportPhotoEdits(ex: Db, serverId: string): Promise<PhotoEdits> {
  const out = emptyEdits();
  const rows = await photoRows(ex, serverId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = rows.map((r) => r.id);
  out.people = (await ex.select({ name: photoPeople.name }).from(photoPeople).where(eq(photoPeople.serverId, serverId)).orderBy(sql`lower(${photoPeople.name})`)).map((p) => p.name);
  if (ids.length === 0) return out;

  const edited = await ex
    .select({ id: titles.id, takenAt: titles.takenAt, takenAtSource: titles.takenAtSource, placeSource: titles.placeSource, latitude: titles.latitude, longitude: titles.longitude, placeName: titles.placeName })
    .from(titles)
    .where(and(inArray(titles.id, ids), sql`(${titles.takenAtSource} = 'manual' OR ${titles.placeSource} = 'manual')`));
  for (const t of edited) {
    const row = byId.get(t.id)!;
    if (t.takenAtSource === "manual" && t.takenAt) out.dates.push({ photo: refOf(row), takenAt: t.takenAt.toISOString() });
    if (t.placeSource === "manual") out.places.push({ photo: refOf(row), latitude: t.latitude, longitude: t.longitude, name: t.placeName });
  }
  const faces = await ex
    .select({ titleId: photoFaces.titleId, x: photoFaces.x, y: photoFaces.y, w: photoFaces.w, h: photoFaces.h, person: photoPeople.name, ignored: photoFaces.ignored })
    .from(photoFaces)
    .leftJoin(photoPeople, eq(photoPeople.id, photoFaces.personId))
    .where(and(inArray(photoFaces.titleId, ids), sql`(${photoFaces.personId} IS NOT NULL OR ${photoFaces.ignored} = true)`));
  for (const f of faces) {
    const row = byId.get(f.titleId)!;
    const box = { x: f.x, y: f.y, w: f.w, h: f.h };
    if (f.ignored) out.dismissed.push({ photo: refOf(row), box });
    else if (f.person) out.tags.push({ photo: refOf(row), box, person: f.person });
  }
  return out;
}

export function buildPhotoEditsExport(edits: PhotoEdits, info: { serverName: string; now: Date }): string {
  return JSON.stringify({ format: PHOTO_EDITS_FORMAT, version: 1, exportedAt: info.now.toISOString(), server: info.serverName, ...edits }, null, 1);
}

export type ParsePhotoEdits = { ok: true; edits: PhotoEdits } | { ok: false; error: string };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function boxFrom(raw: unknown): Box | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const [x, y, w, h] = [num(r.x), num(r.y), num(r.w), num(r.h)];
  return x === null || y === null || w === null || h === null || w <= 0 || h <= 0 ? null : { x, y, w, h };
}

export function parsePhotoEdits(text: string): ParsePhotoEdits {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: "That isn't a Roam photo file (it isn't JSON)." };
  }
  if (!doc || doc.format !== PHOTO_EDITS_FORMAT) return { ok: false, error: "That isn't a Roam photo file." };
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.slice(0, MAX_ITEMS) as Record<string, unknown>[]) : []);
  const out = emptyEdits();
  out.people = list(doc.people).map((p) => (typeof p === "string" ? cleanName(p) : "")).filter(Boolean) as string[];
  for (const t of list(doc.tags)) {
    const photo = photoRefFrom(t?.photo);
    const box = boxFrom(t?.box);
    const person = typeof t?.person === "string" ? cleanName(t.person) : "";
    if (photo && box && person) out.tags.push({ photo, box, person });
  }
  for (const d of list(doc.dismissed)) {
    const photo = photoRefFrom(d?.photo);
    const box = boxFrom(d?.box);
    if (photo && box) out.dismissed.push({ photo, box });
  }
  for (const d of list(doc.dates)) {
    const photo = photoRefFrom(d?.photo);
    const at = typeof d?.takenAt === "string" ? new Date(d.takenAt) : null;
    if (photo && at && !Number.isNaN(at.getTime())) out.dates.push({ photo, takenAt: at.toISOString() });
  }
  for (const p of list(doc.places)) {
    const photo = photoRefFrom(p?.photo);
    if (!photo) continue;
    const latitude = num(p?.latitude);
    const longitude = num(p?.longitude);
    const placed = latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
    if (latitude !== null && !placed) continue;
    out.places.push({ photo, latitude: placed ? latitude : null, longitude: placed ? longitude : null, name: typeof p?.name === "string" && placed ? p.name.slice(0, 200) : null });
  }
  return { ok: true, edits: out };
}

export interface PhotoEditsResult {
  people: number;
  dates: number;
  places: number;
  tags: number;
  dismissed: number;
  /** Pictures in the file that aren't in this server's photo libraries (a few by name). */
  notFound: { total: number; sample: string[] };
  /** Tags and dismissals whose picture is here but whose face isn't found yet: run scripts/scan-faces.ts, then bring the file in again. */
  waitingForFaces: number;
}

const MATCH = 0.4;

/** Puts the file's edits on this server's pictures. Adds and overwrites what the file says; never removes anything it doesn't mention. Dates and places are saved in Roam (the files themselves are not rewritten). */
export async function applyPhotoEdits(ex: Db, serverId: string, edits: PhotoEdits): Promise<PhotoEditsResult> {
  const rows = await photoRows(ex, serverId);
  const byKey = new Map(rows.map((r) => [photoKey(refOf(r)), r.id]));
  const missing = new Set<string>();
  const find = (p: PhotoRef) => {
    const id = byKey.get(photoKey(p));
    if (!id) missing.add(`${p.folder ? `${p.folder}/` : ""}${p.filename}`);
    return id ?? null;
  };
  const result: PhotoEditsResult = { people: 0, dates: 0, places: 0, tags: 0, dismissed: 0, notFound: { total: 0, sample: [] }, waitingForFaces: 0 };

  const people = new Map((await ex.select({ id: photoPeople.id, name: photoPeople.name }).from(photoPeople).where(eq(photoPeople.serverId, serverId))).map((p) => [p.name.toLowerCase(), p.id]));
  const personId = async (name: string) => {
    const key = name.toLowerCase();
    let id = people.get(key);
    if (!id) {
      id = (await ex.insert(photoPeople).values({ serverId, name }).returning({ id: photoPeople.id }))[0].id;
      people.set(key, id);
      result.people++;
    }
    return id;
  };
  for (const name of edits.people) await personId(name);

  for (const d of edits.dates) {
    const id = find(d.photo);
    if (!id) continue;
    await ex.update(titles).set({ takenAt: new Date(d.takenAt), takenAtSource: "manual", updatedAt: new Date() }).where(eq(titles.id, id));
    result.dates++;
  }
  for (const p of edits.places) {
    const id = find(p.photo);
    if (!id) continue;
    await ex.update(titles).set({ latitude: p.latitude, longitude: p.longitude, placeName: p.name, placeSource: "manual", updatedAt: new Date() }).where(eq(titles.id, id));
    result.places++;
  }

  const wanted = [...edits.tags.map((t) => t.photo), ...edits.dismissed.map((d) => d.photo)];
  const titleIds = [...new Set(wanted.map((p) => byKey.get(photoKey(p))).filter((id): id is string => !!id))];
  const faces = titleIds.length ? await ex.select({ id: photoFaces.id, titleId: photoFaces.titleId, x: photoFaces.x, y: photoFaces.y, w: photoFaces.w, h: photoFaces.h }).from(photoFaces).where(inArray(photoFaces.titleId, titleIds)) : [];
  const facesOf = new Map<string, typeof faces>();
  for (const f of faces) facesOf.set(f.titleId, [...(facesOf.get(f.titleId) ?? []), f]);
  const used = new Set<string>();
  const faceFor = (titleId: string, box: Box) => {
    let best: { id: string; score: number } | null = null;
    for (const f of facesOf.get(titleId) ?? []) {
      if (used.has(f.id)) continue;
      const score = overlap(box, f);
      if (score >= MATCH && (!best || score > best.score)) best = { id: f.id, score };
    }
    return best?.id ?? null;
  };
  for (const t of edits.tags) {
    const id = find(t.photo);
    if (!id) continue;
    const face = faceFor(id, t.box);
    if (!face) {
      result.waitingForFaces++;
      continue;
    }
    used.add(face);
    await ex.update(photoFaces).set({ personId: await personId(t.person), suggestedPersonId: null, suggestedScore: null, ignored: false }).where(eq(photoFaces.id, face));
    result.tags++;
  }
  for (const d of edits.dismissed) {
    const id = find(d.photo);
    if (!id) continue;
    const face = faceFor(id, d.box);
    if (!face) {
      result.waitingForFaces++;
      continue;
    }
    used.add(face);
    await ex.update(photoFaces).set({ ignored: true, personId: null, suggestedPersonId: null, suggestedScore: null }).where(eq(photoFaces.id, face));
    result.dismissed++;
  }
  if (result.tags > 0 || result.dismissed > 0) await refreshSuggestions(ex, serverId);
  result.notFound = { total: missing.size, sample: [...missing].slice(0, 20) };
  return result;
}
