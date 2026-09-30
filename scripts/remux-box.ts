/**
 * Remuxes every movie and TV episode whose audio browsers can't play (AC-3,
 * E-AC-3, DTS, ...) to AAC, working straight against Box through Roam's own
 * stored Box connection — no Box Drive or local folders involved. For each
 * file: check its real audio with ffmpeg, download it, remux (video
 * untouched, audio to AAC keeping the full channel layout), upload the
 * result next to the original as "<name>.aac.<ext>", and link it in Roam's
 * database. An existing copy that's smaller than the source (e.g. downmixed
 * to stereo) is replaced with a new version of the same Box file.
 *
 * Run from the repo root (reads .env.local; never writes it):
 *
 *   npx tsx --env-file=.env.local scripts/remux-box.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/remux-box.ts
 *
 * Options:
 *   --dry-run            report what would be remuxed, change nothing
 *   --only movies|shows
 *   --library <id>       only this library
 *   --title <id>         only this movie/show
 *   --limit <n>          stop after remuxing n files
 *   --tmp <dir>          scratch space for downloads (needs ~2x the largest file)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, mediaFiles, seasons, titles } from "@/lib/db/schema";
import { isBrowserSafeAudioCodec } from "@/lib/scan/codec-support";
import { variantFileName } from "@/lib/scan/conventions";
import { upsertVariant } from "@/lib/scan/media-files";
import { getFreshDownloadUrl } from "@/lib/storage/box";
import { withBoxClient } from "@/lib/storage/box-token-storage";
import { downloadToFile, runFfmpeg, uploadFile, type TokenProvider } from "@/lib/remux/remux-core.mjs";
import { parseFirstAudioStream, type AudioStreamInfo } from "@/lib/remux/ffmpeg-probe";
import { ensureFfmpeg } from "@/lib/remux/tier1";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const only = flag("--only");
const libraryFilter = flag("--library");
const titleFilter = flag("--title");
const limit = Number(flag("--limit") ?? Infinity);
const workRoot = flag("--tmp") ?? join(tmpdir(), "roam-remux-local");

const FFMPEG_TIMEOUT_MS = 6 * 60 * 60_000;
// Anything else (AC-3, E-AC-3, DTS, TrueHD, FLAC, ...) gets remuxed.
const BROWSER_SAFE_FFMPEG_CODECS = new Set(["aac", "mp3"]);

type Group = {
  serverId: string;
  boxFileId: string;
  folderId: string;
  filename: string;
  sizeBytes: number | null;
  primaryIds: string[];
  dbCodec: string | null;
  codecProbed: boolean;
};

async function loadGroups(): Promise<Group[]> {
  const rows: {
    id: string;
    boxFileId: string;
    filename: string;
    sizeBytes: number | null;
    audioCodec: string | null;
    codecProbed: boolean;
    serverId: string;
    folderId: string;
  }[] = [];

  const scope = (libraryId: typeof titles.libraryId, titleId: typeof titles.id) =>
    and(
      libraryFilter ? eq(libraryId, libraryFilter) : undefined,
      titleFilter ? eq(titleId, titleFilter) : undefined
    );

  if (only !== "shows") {
    const movies = await db
      .select({
        id: mediaFiles.id,
        boxFileId: mediaFiles.boxFileId,
        filename: mediaFiles.filename,
        sizeBytes: mediaFiles.sizeBytes,
        audioCodec: mediaFiles.audioCodec,
        codecProbed: mediaFiles.codecProbed,
        serverId: libraries.serverId,
        folderId: titles.boxFolderId,
      })
      .from(mediaFiles)
      .innerJoin(titles, eq(mediaFiles.ownerId, titles.id))
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(
        and(eq(mediaFiles.ownerKind, "title"), isNull(mediaFiles.variantOfMediaFileId), eq(titles.kind, "movie"), scope(titles.libraryId, titles.id))
      );
    rows.push(...movies);
  }
  if (only !== "movies") {
    const eps = await db
      .select({
        id: mediaFiles.id,
        boxFileId: mediaFiles.boxFileId,
        filename: mediaFiles.filename,
        sizeBytes: mediaFiles.sizeBytes,
        audioCodec: mediaFiles.audioCodec,
        codecProbed: mediaFiles.codecProbed,
        serverId: libraries.serverId,
        episodeFolderId: episodes.boxFolderId,
        seasonFolderId: seasons.boxFolderId,
      })
      .from(mediaFiles)
      .innerJoin(episodes, eq(mediaFiles.ownerId, episodes.id))
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .innerJoin(titles, eq(seasons.titleId, titles.id))
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(
        and(eq(mediaFiles.ownerKind, "episode"), isNull(mediaFiles.variantOfMediaFileId), scope(titles.libraryId, titles.id))
      );
    rows.push(...eps.map(({ episodeFolderId, seasonFolderId, ...r }) => ({ ...r, folderId: episodeFolderId ?? seasonFolderId })));
  }

  // A combined multi-episode file has one row per episode but is one Box file.
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const key = `${r.serverId}:${r.boxFileId}`;
    const g = groups.get(key);
    if (g) g.primaryIds.push(r.id);
    else
      groups.set(key, {
        serverId: r.serverId,
        boxFileId: r.boxFileId,
        folderId: r.folderId,
        filename: r.filename,
        sizeBytes: r.sizeBytes,
        primaryIds: [r.id],
        dbCodec: r.audioCodec,
        codecProbed: r.codecProbed,
      });
  }
  return [...groups.values()].sort((a, b) => a.filename.localeCompare(b.filename));
}

async function loadVariants(primaryIds: string[]) {
  const out = new Map<string, { boxFileId: string; filename: string }>();
  for (let i = 0; i < primaryIds.length; i += 500) {
    const chunk = primaryIds.slice(i, i + 500);
    const vs = await db
      .select({ of: mediaFiles.variantOfMediaFileId, boxFileId: mediaFiles.boxFileId, filename: mediaFiles.filename })
      .from(mediaFiles)
      .where(and(isNotNull(mediaFiles.variantOfMediaFileId), inArray(mediaFiles.variantOfMediaFileId, chunk)));
    for (const v of vs) if (v.of) out.set(v.of, v);
  }
  return out;
}

/** ffmpeg exits nonzero here (no output file) — that's expected; the stream summary is on stderr. */
function probeUrl(ffmpeg: string, url: string): Promise<AudioStreamInfo | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-i", url], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", () => {
      if (/Server returned|Invalid data found|No such file|Connection (?:refused|reset)|error/i.test(err) && !/Stream #/.test(err)) {
        reject(new Error(err.trim().split("\n").slice(-2).join(" ")));
      } else resolve(parseFirstAudioStream(err));
    });
  });
}

async function probeBoxFile(ffmpeg: string, serverId: string, boxFileId: string) {
  const { url } = await getFreshDownloadUrl(serverId, boxFileId);
  return probeUrl(ffmpeg, url);
}

/** A full-access token for the server's connected Box account (this script runs as its owner), refreshed on demand. */
function tokenProvider(serverId: string): TokenProvider {
  return (force) =>
    withBoxClient(serverId, async (client) => {
      const token = force ? await client.auth.refreshToken() : await client.auth.retrieveToken();
      if (!token.accessToken) throw new Error("Box returned no access token");
      return token.accessToken;
    });
}

async function remuxGroup(ffmpeg: string, g: Group, channels: number, replaceFileId: string | null) {
  const dir = join(workRoot, randomUUID());
  await mkdir(dir, { recursive: true });
  try {
    const input = join(dir, "input.mp4");
    const output = join(dir, "output.mp4");
    const { url } = await getFreshDownloadUrl(g.serverId, g.boxFileId);
    await downloadToFile(url, input);
    try {
      await runFfmpeg(ffmpeg, input, output, { timeoutMs: FFMPEG_TIMEOUT_MS, channels });
    } catch (err) {
      if (channels <= 2) throw err;
      console.warn(`   ${channels}-channel encode failed (${(err as Error).message.split("\n")[0]}); retrying as stereo`);
      await runFfmpeg(ffmpeg, input, output, { timeoutMs: FFMPEG_TIMEOUT_MS });
    }
    await rm(input, { force: true });

    const name = variantFileName(g.filename);
    const getToken = tokenProvider(g.serverId);
    let uploaded = await uploadFile({ getToken, folderId: g.folderId, name, filePath: output, replaceFileId: replaceFileId ?? undefined });
    if ("conflictId" in uploaded) {
      // The copy already sits in Box (just not linked/recorded): replace it with this full-size one.
      uploaded = await uploadFile({ getToken, folderId: g.folderId, name, filePath: output, replaceFileId: uploaded.conflictId });
    }
    if ("conflictId" in uploaded) throw new Error("Box reported a name conflict again after replacing the existing copy");

    await upsertVariant(g.primaryIds, { id: uploaded.id, name: uploaded.name, sizeBytes: uploaded.size });
    // A new version keeps the Box file id (so upsertVariant leaves the row alone); refresh its size.
    await db
      .update(mediaFiles)
      .set({ sizeBytes: uploaded.size })
      .where(and(eq(mediaFiles.boxFileId, uploaded.id), isNotNull(mediaFiles.variantOfMediaFileId)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (only && only !== "movies" && only !== "shows") throw new Error('--only must be "movies" or "shows"');
  const ffmpeg = await ensureFfmpeg();
  const groups = await loadGroups();
  const variants = await loadVariants(groups.flatMap((g) => g.primaryIds));
  console.log(`${dryRun ? "Dry run: " : ""}${groups.length} video file(s) in Roam to check`);

  const c = { checked: 0, remuxed: 0, redone: 0, ok: 0, hasCopy: 0, noAudio: 0, failed: 0 };
  for (const g of groups) {
    if (c.remuxed + c.redone >= limit) break;
    c.checked++;
    try {
      // Roam's own scan already read this file's codec; only files it cleared as browser-safe skip the network check.
      if (g.codecProbed && isBrowserSafeAudioCodec(g.dbCodec)) {
        c.ok++;
        continue;
      }
      const src = await probeBoxFile(ffmpeg, g.serverId, g.boxFileId);
      if (!src) {
        c.noAudio++;
        continue;
      }
      if (BROWSER_SAFE_FFMPEG_CODECS.has(src.codec)) {
        c.ok++;
        continue;
      }
      const channels = Math.min(src.channels, 8);
      const existing = g.primaryIds.map((id) => variants.get(id)).find(Boolean) ?? null;
      let replaceFileId: string | null = null;
      if (existing) {
        const copy = await probeBoxFile(ffmpeg, g.serverId, existing.boxFileId).catch(() => null);
        if (copy && copy.codec === "aac" && copy.channels >= channels) {
          c.hasCopy++;
          continue;
        }
        replaceFileId = existing.boxFileId;
      }
      const verb = replaceFileId ? "redo at full size" : "remux";
      const label = `${g.filename} (${src.codec} ${src.channels}ch)`;
      if (dryRun) {
        console.log(`[would ${verb}] ${label}`);
        c[replaceFileId ? "redone" : "remuxed"]++;
        continue;
      }
      console.log(`[${verb}] ${label} -> aac ${channels}ch ...`);
      const started = Date.now();
      await remuxGroup(ffmpeg, g, channels, replaceFileId);
      console.log(`[done] ${variantFileName(g.filename)} (${Math.round((Date.now() - started) / 1000)}s)`);
      c[replaceFileId ? "redone" : "remuxed"]++;
    } catch (err) {
      c.failed++;
      console.error(`[failed] ${g.filename}: ${(err as Error).message}`);
    }
  }
  console.log(
    `\nChecked ${c.checked}: ${c.remuxed} ${dryRun ? "need a copy" : "remuxed"}, ${c.redone} ${dryRun ? "need" : "redone at"} full size, ` +
      `${c.ok} browser-safe, ${c.hasCopy} already have a full-size copy, ${c.noAudio} without audio, ${c.failed} failed.`
  );
  if (c.failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
