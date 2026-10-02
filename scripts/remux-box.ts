/**
 * Remuxes every movie and TV episode whose audio browsers can't play (AC-3,
 * E-AC-3, DTS, ...) to AAC, working straight against Box through Roam's own
 * stored Box connection — no Box Drive or local folders involved. For each
 * file: check its audio codec from the MP4 header, download it, remux (video
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
import { probeFiles, upsertVariant } from "@/lib/scan/media-files";
import { probeMp4AudioTrack } from "@/lib/scan/mp4-duration";
import { createBoxProviderForServer, getFreshDownloadUrl } from "@/lib/storage/box";
import { ensureFreshAccessToken, withBoxClient } from "@/lib/storage/box-token-storage";
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
/** Header reads are small and independent; do this many at once while deciding what needs work. */
const CLASSIFY_CONCURRENCY = 6;

type Group = {
  serverId: string;
  boxFileId: string;
  folderId: string;
  filename: string;
  /** What the log calls this file: the filename, prefixed with the show's name for episodes. */
  label: string;
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
    label: string;
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
    rows.push(...movies.map((m) => ({ ...m, label: m.filename })));
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
        showName: titles.name,
      })
      .from(mediaFiles)
      .innerJoin(episodes, eq(mediaFiles.ownerId, episodes.id))
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .innerJoin(titles, eq(seasons.titleId, titles.id))
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(
        and(eq(mediaFiles.ownerKind, "episode"), isNull(mediaFiles.variantOfMediaFileId), scope(titles.libraryId, titles.id))
      );
    rows.push(
      ...eps.map(({ episodeFolderId, seasonFolderId, showName, ...r }) => ({
        ...r,
        folderId: episodeFolderId ?? seasonFolderId,
        label: `${showName} — ${r.filename}`,
      }))
    );
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
        label: r.label,
        sizeBytes: r.sizeBytes,
        primaryIds: [r.id],
        dbCodec: r.audioCodec,
        codecProbed: r.codecProbed,
      });
  }
  return [...groups.values()].sort((a, b) => a.filename.localeCompare(b.filename));
}

async function loadVariants(primaryIds: string[]) {
  const out = new Map<string, { boxFileId: string; filename: string; sizeBytes: number | null }>();
  for (let i = 0; i < primaryIds.length; i += 500) {
    const chunk = primaryIds.slice(i, i + 500);
    const vs = await db
      .select({
        of: mediaFiles.variantOfMediaFileId,
        boxFileId: mediaFiles.boxFileId,
        filename: mediaFiles.filename,
        sizeBytes: mediaFiles.sizeBytes,
      })
      .from(mediaFiles)
      .where(and(isNotNull(mediaFiles.variantOfMediaFileId), inArray(mediaFiles.variantOfMediaFileId, chunk)));
    for (const v of vs) if (v.of) out.set(v.of, v);
  }
  return out;
}

/** Reads a file's first audio track straight from its MP4 header over Box range requests — nothing is downloaded. */
async function probeBoxAudio(serverId: string, boxFileId: string, sizeBytes: number | null) {
  if (!sizeBytes) throw new Error("file size unknown to Roam");
  const provider = createBoxProviderForServer(serverId);
  return probeMp4AudioTrack((start, end) => provider.fetchByteRange(boxFileId, start, end), sizeBytes);
}

/** The channel layout of a LOCAL file, from ffmpeg's input summary (exits nonzero without an output; that's expected). */
function probeLocalAudio(ffmpeg: string, file: string): Promise<AudioStreamInfo | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", () => resolve(parseFirstAudioStream(err)));
  });
}

/** A full-access token for the server's connected Box account (this script runs as its owner), refreshed on demand. */
function tokenProvider(serverId: string): TokenProvider {
  return (force) =>
    withBoxClient(serverId, async (client) => {
      if (!force) await ensureFreshAccessToken(client, serverId);
      const token = force ? await client.auth.refreshToken() : await client.auth.retrieveToken();
      if (!token.accessToken) throw new Error("Box returned no access token");
      return token.accessToken;
    });
}

async function remuxGroup(ffmpeg: string, g: Group, replaceFileId: string | null, headerCodec: string | null) {
  const dir = join(workRoot, randomUUID());
  await mkdir(dir, { recursive: true });
  try {
    const input = join(dir, "input.mp4");
    const output = join(dir, "output.mp4");
    const { url } = await getFreshDownloadUrl(g.serverId, g.boxFileId);
    console.log("   downloading ...");
    await downloadToFile(url, input);
    // The real layout, read from the local file (a sample entry's own count isn't reliable for AC-3).
    const local = await probeLocalAudio(ffmpeg, input);
    if (!local) throw new Error("no audio stream found in the downloaded file");
    const channels = Math.min(local.channels, 8);
    console.log(`   ${local.codec} ${local.channels}ch -> aac ${channels}ch`);
    try {
      await runFfmpeg(ffmpeg, input, output, { timeoutMs: FFMPEG_TIMEOUT_MS, channels });
    } catch (err) {
      if (channels <= 2) throw err;
      console.warn(`   ${channels}-channel encode failed (${(err as Error).message.split("\n")[0]}); retrying as stereo`);
      await runFfmpeg(ffmpeg, input, output, { timeoutMs: FFMPEG_TIMEOUT_MS });
    }
    await rm(input, { force: true });
    console.log("   encoded; uploading ...");

    const name = variantFileName(g.filename);
    const getToken = tokenProvider(g.serverId);
    // Whole-upload retries (a fresh upload session each time) so one bad connection doesn't throw away the download + encode.
    const upload = async (replace: string | null) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await uploadFile({
            getToken,
            folderId: g.folderId,
            name,
            filePath: output,
            replaceFileId: replace ?? undefined,
            onProgress: ({ part, parts, uploadedBytes, size }) =>
              console.log(`   part ${part}/${parts} (${Math.round((uploadedBytes / size) * 100)}%)`),
          });
        } catch (err) {
          if (attempt >= 3) throw err;
          console.warn(`   upload attempt ${attempt} failed (${(err as Error).message}); retrying in 30s`);
          await new Promise((r) => setTimeout(r, 30_000));
        }
      }
    };
    let uploaded = await upload(replaceFileId);
    if ("conflictId" in uploaded) {
      // The copy already sits in Box (just not linked/recorded): replace it with this full-size one.
      uploaded = await upload(uploaded.conflictId);
    }
    if ("conflictId" in uploaded) throw new Error("Box reported a name conflict again after replacing the existing copy");

    await upsertVariant(g.primaryIds, { id: uploaded.id, name: uploaded.name, sizeBytes: uploaded.size });
    // A new version keeps the Box file id (so upsertVariant leaves the row alone); refresh its size.
    await db
      .update(mediaFiles)
      .set({ sizeBytes: uploaded.size })
      .where(and(eq(mediaFiles.boxFileId, uploaded.id), isNotNull(mediaFiles.variantOfMediaFileId)));

    // Playback only swaps in the copy when the original's codec is recorded and the copy has been probed,
    // so do both now instead of waiting for the next scan.
    if (headerCodec) {
      await db
        .update(mediaFiles)
        .set({ audioCodec: headerCodec, codecProbed: true })
        .where(and(inArray(mediaFiles.id, g.primaryIds), eq(mediaFiles.codecProbed, false)));
    }
    const variantRows = await db
      .select()
      .from(mediaFiles)
      .where(and(eq(mediaFiles.boxFileId, uploaded.id), isNotNull(mediaFiles.variantOfMediaFileId)));
    const probeErrors: string[] = [];
    await probeFiles(createBoxProviderForServer(g.serverId), variantRows, Date.now() + 120_000, probeErrors);
    if (probeErrors.length) console.warn(`   copy uploaded and linked, but probing it failed (${probeErrors[0]}); a Roam scan will retry`);
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

  type Work = { g: Group; codec: string | null; replaceFileId: string | null };
  const failWith = (g: Group, err: unknown) => {
    c.failed++;
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    console.error(
      `[failed] ${g.label}: ${(err as Error).message}${cause ? ` (${cause.code ?? ""} ${cause.message ?? ""})` : ""}`
    );
  };

  // Phase 1: decide, several files at a time, what actually needs work. Mostly header reads over Box range requests.
  async function classify(g: Group): Promise<Work | null> {
    try {
      // Roam's own scan already read this file's codec; only an unprobed file needs a header read.
      let codec = g.codecProbed ? g.dbCodec : null;
      let srcChannels: number | null = null;
      if (!g.codecProbed) {
        const track = await probeBoxAudio(g.serverId, g.boxFileId, g.sizeBytes);
        if (track.audioCodec === null) {
          c.noAudio++;
          return null;
        }
        codec = track.audioCodec;
        srcChannels = track.channels;
      }
      if (isBrowserSafeAudioCodec(codec)) {
        c.ok++;
        return null;
      }
      const existing = g.primaryIds.map((id) => variants.get(id)).find(Boolean) ?? null;
      let replaceFileId: string | null = null;
      if (existing) {
        // Redo only a copy provably smaller than the source; when either side's channel count can't be read, leave it.
        const copy = await probeBoxAudio(g.serverId, existing.boxFileId, existing.sizeBytes).catch(() => null);
        if (srcChannels === null) srcChannels = (await probeBoxAudio(g.serverId, g.boxFileId, g.sizeBytes).catch(() => null))?.channels ?? null;
        const full = !copy || copy.channels === null || srcChannels === null || copy.channels >= Math.min(srcChannels, 8);
        if (full) {
          c.hasCopy++;
          return null;
        }
        replaceFileId = existing.boxFileId;
      }
      return { g, codec, replaceFileId };
    } catch (err) {
      failWith(g, err);
      return null;
    }
  }

  const queue: (Work | null)[] = new Array(groups.length).fill(null);
  let next = 0;
  let checkedSoFar = 0;
  await Promise.all(
    Array.from({ length: CLASSIFY_CONCURRENCY }, async () => {
      for (;;) {
        const i = next++;
        if (i >= groups.length) return;
        queue[i] = await classify(groups[i]);
        c.checked++;
        if (++checkedSoFar % 100 === 0 || checkedSoFar === groups.length) {
          console.log(`[check] ${checkedSoFar}/${groups.length} checked`);
        }
      }
    })
  );
  const work = queue.filter((w): w is Work => w !== null);
  console.log(`[check] done: ${work.length} file(s) need work`);

  // Phase 2: one at a time (download, remux, upload).
  let handled = 0;
  for (const { g, codec, replaceFileId } of work) {
    if (handled >= limit) break;
    const verb = replaceFileId ? "redo at full size" : "remux";
    const label = `${g.label} (${codec})`;
    if (dryRun) {
      console.log(`[would ${verb}] ${label}`);
      c[replaceFileId ? "redone" : "remuxed"]++;
      handled++;
      continue;
    }
    try {
      console.log(`[${verb}] ${label} ...`);
      const started = Date.now();
      await remuxGroup(ffmpeg, g, replaceFileId, g.codecProbed ? null : codec);
      console.log(`[done] ${g.label} -> ${variantFileName(g.filename)} (${Math.round((Date.now() - started) / 1000)}s)`);
      c[replaceFileId ? "redone" : "remuxed"]++;
      handled++;
    } catch (err) {
      failWith(g, err);
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
