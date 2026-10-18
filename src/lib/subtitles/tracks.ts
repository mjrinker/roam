/**
 * Subtitles kept with a movie or episode, for everyone who can play it (the subtitle_tracks table): files beside the video in storage
 * ("Movie (2020).es.srt", found when the folder is scanned and read when played) and ones an admin saved from OpenSubtitles or a file.
 * Their times are on the whole title's clock, like a subtitle file for the whole film.
 */
import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { mediaFiles, subtitleTracks } from "@/lib/db/schema";
import { isBrowserFriendlyVariant, isExtraFile, isVideoFile } from "@/lib/scan/conventions";
import { subtitleFileParts } from "@/lib/scan/subtitle-names";
import type { StorageEntry } from "@/lib/storage/provider";
import { languageCode3, languageLabel } from "@/lib/viewers/audio-languages";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const MAX_SAVED_CUES = 20_000;

const noExt = (name: string) => name.replace(/\.[^.]+$/, "");

/** The names a video's subtitle files may carry: its own, without a part marker, and without a resolution version ("Movie - 1080p - pt2"). */
export function videoBaseNames(videoName: string): string[] {
  const own = noExt(videoName).toLowerCase();
  const part = own.replace(/ - (?:pt|cd|disc|disk|part)\s*\d+$/i, "");
  const version = part.replace(/ - (?:\d{3,4}p|4k|uhd|hd|sd)(?: [^-]*)?$/i, "");
  return [...new Set([own, part, version])];
}

export interface SidecarSubtitle {
  entry: StorageEntry;
  language: string | null;
  label: string;
}

/** Each video in a folder with the subtitle files that belong to it (any language; "forced" and hearing-impaired ones are named so). */
export function sidecarsFor(children: StorageEntry[]): { videoFile: StorageEntry; subtitles: SidecarSubtitle[] }[] {
  const files = children.filter((c) => c.kind === "file");
  const subs = files.map((f) => ({ f, parts: subtitleFileParts(f.name) })).filter((s): s is { f: StorageEntry; parts: NonNullable<ReturnType<typeof subtitleFileParts>> } => s.parts !== null);
  return files
    .filter((f) => isVideoFile(f.name) && !isExtraFile(f.name) && !isBrowserFriendlyVariant(f.name))
    .map((video) => {
      const bases = videoBaseNames(video.name);
      const mine = subs.filter((s) => bases.includes(s.parts.base.toLowerCase()));
      return {
        videoFile: video,
        subtitles: mine.map((s) => {
          const language = languageCode3(s.parts.language);
          const tags = s.f.name.toLowerCase();
          const extra = [s.parts.forced ? "forced" : null, /\.(sdh|hi|cc)(\.|$)/.test(tags) ? "SDH" : null].filter(Boolean).join(", ");
          return { entry: s.f, language, label: `${language ? languageLabel(language) : "Subtitles"}${extra ? ` (${extra})` : ""}` };
        }),
      };
    })
    .filter((v) => v.subtitles.length > 0);
}

/** Records the subtitle files found beside this folder's videos against the movie or episode each video belongs to, and forgets ones that are gone. */
export async function syncSidecarTracks(ex: Db, children: StorageEntry[]): Promise<void> {
  const found = sidecarsFor(children);
  const videos = children.filter((c) => c.kind === "file" && isVideoFile(c.name)).map((c) => c.id);
  if (videos.length === 0) return;
  const rows = await ex.select({ boxFileId: mediaFiles.boxFileId, ownerKind: mediaFiles.ownerKind, ownerId: mediaFiles.ownerId }).from(mediaFiles).where(and(inArray(mediaFiles.boxFileId, videos), isNotNull(mediaFiles.ownerId)));
  const owners = new Map<string, { kind: "title" | "episode"; id: string }>();
  for (const r of rows) if (r.ownerId && (r.ownerKind === "title" || r.ownerKind === "episode")) owners.set(r.boxFileId, { kind: r.ownerKind, id: r.ownerId });
  const keep = new Map<string, { kind: "title" | "episode"; id: string; files: Set<string> }>();
  for (const { videoFile: video, subtitles } of found) {
    const owner = owners.get(video.id);
    if (!owner) continue;
    const key = `${owner.kind}:${owner.id}`;
    const entry = keep.get(key) ?? { ...owner, files: new Set<string>() };
    keep.set(key, entry);
    for (const s of subtitles) {
      entry.files.add(s.entry.id);
      await ex
        .insert(subtitleTracks)
        .values({ ownerKind: owner.kind, ownerId: owner.id, language: s.language, label: s.label, source: "file", storageFileId: s.entry.id, sizeBytes: s.entry.sizeBytes ?? null })
        .onConflictDoUpdate({ target: [subtitleTracks.ownerKind, subtitleTracks.ownerId, subtitleTracks.storageFileId], set: { language: s.language, label: s.label, sizeBytes: s.entry.sizeBytes ?? null } });
    }
  }
  // Videos of this folder that no longer have a subtitle file (or have fewer) lose the rows for the ones that went.
  for (const owner of new Map([...owners.values()].map((o) => [`${o.kind}:${o.id}`, o])).values()) {
    const kept = keep.get(`${owner.kind}:${owner.id}`)?.files ?? new Set<string>();
    const where = and(eq(subtitleTracks.ownerKind, owner.kind), eq(subtitleTracks.ownerId, owner.id), eq(subtitleTracks.source, "file"));
    await ex.delete(subtitleTracks).where(kept.size > 0 ? and(where, notInArray(subtitleTracks.storageFileId, [...kept])) : where);
  }
}

export interface TrackSummary {
  id: string;
  language: string | null;
  label: string;
  source: "file" | "saved";
}

export async function tracksFor(ex: Db, kind: "title" | "episode", id: string): Promise<TrackSummary[]> {
  const rows = await ex.select({ id: subtitleTracks.id, language: subtitleTracks.language, label: subtitleTracks.label, source: subtitleTracks.source }).from(subtitleTracks).where(and(eq(subtitleTracks.ownerKind, kind), eq(subtitleTracks.ownerId, id))).orderBy(subtitleTracks.label);
  return rows.map((r) => ({ ...r, source: r.source === "file" ? "file" : "saved" }));
}
