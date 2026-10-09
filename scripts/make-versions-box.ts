/**
 * Makes resolution versions of every movie and TV episode, working straight against Box through Roam's own stored Box connection (the
 * same way scripts/remux-box.ts does). For each movie or episode:
 *   1. works out the original's real resolution (from what Roam probed) and names the lower rungs of the ladder to make:
 *      2160p, 1440p, 1080p, 720p, 480p, 360p, 240p, 144p - only those BELOW the original, never an upscale;
 *   2. downloads the original (all of its parts) once and encodes each missing rung as H.264, scaled to the same shape and bitrate-capped
 *      so the file stays under Box's size limit. A film that is in several parts becomes ONE file per version (the original's own parts
 *      are left as they are). Each rung keeps the original's audio ("<name> - 720p.mp4"); when that audio is one browsers can't play
 *      (AC-3, DTS ...) a stereo/multichannel AAC copy goes beside it ("<name> - 720p.aac.mp4"), like the original's own;
 *   3. renames the original to say what it is ("<name> - 1080p.<ext>", each part, and its ".aac" copy with it) - last, so a run that
 *      stops half way is simply finished by running it again.
 * Nothing is written to Roam's tables except the renamed files' names; run a Roam rescan afterwards and the new versions appear in the
 * player's Quality menu. Safe to re-run: files that already exist in Box are skipped. (The original's own ".aac" copy is made by
 * scripts/remux-box.ts; run that too if some originals lack one.)
 *
 * Run from the repo root (reads .env.local; never writes it):
 *
 *   npx tsx --env-file=.env.local scripts/make-versions-box.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/make-versions-box.ts
 *
 * Options:
 *   --dry-run            report what would be made and renamed, change nothing
 *   --only movies|shows
 *   --library <id>       only this library
 *   --title <id>         only this movie/show
 *   --rungs 720,480      only these rungs (default: the whole ladder below the original)
 *   --limit <n>          stop after n films/episodes
 *   --skip-rename        make the lower versions but leave the original's name alone
 *   --preset <name>      x264 preset (default medium; slower = smaller files, much slower encodes)
 *   --crf <n>            x264 quality (default 23; lower = better and bigger)
 *   --tmp <dir>          scratch space (needs room for all of one film's parts plus two encodes)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, mediaFiles, seasons, titles } from "@/lib/db/schema";
import { isBrowserSafeAudioCodec } from "@/lib/scan/codec-support";
import { splitVersionLabel, stripVariantSuffix, variantFileName, withoutSplitMarker, withVersionLabel } from "@/lib/scan/conventions";
import { createBoxProviderForServer, getFreshDownloadUrl, renameBoxEntry } from "@/lib/storage/box";
import { ensureFreshAccessToken, withBoxClient } from "@/lib/storage/box-token-storage";
import { downloadToFile, runFfmpeg, uploadFile, type TokenProvider } from "@/lib/remux/remux-core.mjs";
import { parseAudioKbps, parseFirstAudioStream, parseVideoInfo } from "@/lib/remux/ffmpeg-probe";
import { ensureFfmpeg } from "@/lib/remux/tier1";
import { audioNeedsAacCopy, buildVersionArgs, MAX_OUTPUT_BYTES, originalLabel, rungLabel, rungsBelow, videoKbps } from "@/lib/remux/version-plan";
import { effectiveHeight } from "@/lib/player/versions";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipRename = args.includes("--skip-rename");
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const only = flag("--only");
const libraryFilter = flag("--library");
const titleFilter = flag("--title");
const limit = Number(flag("--limit") ?? Infinity);
const preset = flag("--preset") ?? "medium";
const crf = Number(flag("--crf") ?? 23);
const wanted = flag("--rungs")?.split(",").map((n) => Number(n.trim())).filter((n) => Number.isInteger(n));
const workRoot = flag("--tmp") ?? join(tmpdir(), "roam-versions-local");

const FFMPEG_TIMEOUT_MS = 12 * 60 * 60_000;
const UPLOAD_ATTEMPTS = 6;
/** A file this much over the limit after encoding is squeezed again (at most this many times). */
const SQUEEZE_ATTEMPTS = 2;
/** Audio bitrate to assume for the size budget when the original's can't be read (a generous 5.1 DTS-ish figure). */
const GUESS_AUDIO_KBPS = 768;

type Variant = { boxFileId: string; filename: string };
type Part = {
  boxFileId: string;
  filename: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  audioCodec: string | null;
  codecProbed: boolean;
  variants: Variant[];
};
/** One movie or episode's original, as the ordered parts it plays from (one part for most). */
type Group = {
  serverId: string;
  folderId: string;
  label: string;
  parts: Part[];
};

async function loadGroups(): Promise<{ groups: Group[]; skipped: string[] }> {
  type Row = {
    ownerId: string;
    versionLabel: string;
    partIndex: number;
    id: string;
    boxFileId: string;
    filename: string;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    audioCodec: string | null;
    codecProbed: boolean;
    trimDurationSeconds: number | null;
    serverId: string;
    folderId: string;
    label: string;
  };
  const rows: Row[] = [];
  const scope = (libraryId: typeof titles.libraryId, titleId: typeof titles.id) =>
    and(libraryFilter ? eq(libraryId, libraryFilter) : undefined, titleFilter ? eq(titleId, titleFilter) : undefined);
  const columns = {
    ownerId: mediaFiles.ownerId,
    versionLabel: mediaFiles.versionLabel,
    partIndex: mediaFiles.partIndex,
    id: mediaFiles.id,
    boxFileId: mediaFiles.boxFileId,
    filename: mediaFiles.filename,
    width: mediaFiles.width,
    height: mediaFiles.height,
    durationSeconds: mediaFiles.durationSeconds,
    audioCodec: mediaFiles.audioCodec,
    codecProbed: mediaFiles.codecProbed,
    trimDurationSeconds: mediaFiles.trimDurationSeconds,
    serverId: libraries.serverId,
  };

  if (only !== "shows") {
    const movies = await db
      .select({ ...columns, folderId: sql<string>`coalesce(${titles.parentFolderId}, ${titles.boxFolderId})` })
      .from(mediaFiles)
      .innerJoin(titles, eq(mediaFiles.ownerId, titles.id))
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(and(eq(mediaFiles.ownerKind, "title"), isNull(mediaFiles.variantOfMediaFileId), eq(titles.kind, "movie"), eq(libraries.kind, "movies"), scope(titles.libraryId, titles.id)))
      .orderBy(asc(mediaFiles.partIndex));
    rows.push(...movies.map((m) => ({ ...m, ownerId: m.ownerId as string, label: m.filename })));
  }
  if (only !== "movies") {
    const eps = await db
      .select({ ...columns, episodeFolderId: episodes.boxFolderId, seasonFolderId: seasons.boxFolderId, showName: titles.name })
      .from(mediaFiles)
      .innerJoin(episodes, eq(mediaFiles.ownerId, episodes.id))
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .innerJoin(titles, eq(seasons.titleId, titles.id))
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(and(eq(mediaFiles.ownerKind, "episode"), isNull(mediaFiles.variantOfMediaFileId), eq(libraries.kind, "shows"), scope(titles.libraryId, titles.id)))
      .orderBy(asc(mediaFiles.partIndex));
    rows.push(...eps.map(({ episodeFolderId, seasonFolderId, showName, ...r }) => ({ ...r, ownerId: r.ownerId as string, folderId: episodeFolderId ?? seasonFolderId, label: `${showName} — ${r.filename}` })));
  }

  // Per movie or episode, the original is its highest-resolution version (a rerun finds the already-renamed original, not a smaller version).
  const byOwner = new Map<string, Row[]>();
  for (const r of rows) byOwner.set(r.ownerId, [...(byOwner.get(r.ownerId) ?? []), r]);
  const skipped: string[] = [];
  const groups = new Map<string, Group>();
  const primaryIdsByBoxFile = new Map<string, string[]>();
  for (const ownerRows of byOwner.values()) {
    const versions = new Map<string, Row[]>();
    for (const r of ownerRows) versions.set(r.versionLabel, [...(versions.get(r.versionLabel) ?? []), r]);
    const height = (rs: Row[]) => {
      const withSize = rs.find((r) => r.width && r.height);
      return withSize ? (effectiveHeight(withSize.width, withSize.height) ?? -1) : -1;
    };
    const best = [...versions.entries()].sort(([la, a], [lb, b]) => height(b) - height(a) || (la === "" ? -1 : lb === "" ? 1 : la.localeCompare(lb)))[0][1];
    const parts = [...best].sort((a, b) => a.partIndex - b.partIndex);
    // A piece of a combined multi-episode file that is also split into parts can't be joined into one file for one episode.
    if (parts.some((r) => r.trimDurationSeconds !== null)) {
      skipped.push(`${parts[0].label}: part of a multi-episode file (not handled)`);
      continue;
    }
    const key = `${parts[0].serverId}:${parts.map((r) => r.boxFileId).join(",")}`;
    if (groups.has(key)) continue; // a combined multi-episode file is one original for all its episodes
    for (const r of parts) primaryIdsByBoxFile.set(r.boxFileId, [...(primaryIdsByBoxFile.get(r.boxFileId) ?? []), r.id]);
    groups.set(key, {
      serverId: parts[0].serverId,
      folderId: parts[0].folderId,
      label: parts.length > 1 ? `${parts[0].label} (+${parts.length - 1} more part${parts.length > 2 ? "s" : ""})` : parts[0].label,
      parts: parts.map((r) => ({ boxFileId: r.boxFileId, filename: r.filename, width: r.width, height: r.height, durationSeconds: r.durationSeconds, audioCodec: r.audioCodec, codecProbed: r.codecProbed, variants: [] })),
    });
  }
  const out = [...groups.values()].sort((a, b) => a.parts[0].filename.localeCompare(b.parts[0].filename));
  // Their browser-friendly (".aac") copies, which are renamed along with them.
  const primaryIds = [...primaryIdsByBoxFile.values()].flat();
  const partByPrimaryId = new Map<string, Part>();
  for (const g of out) for (const part of g.parts) for (const id of primaryIdsByBoxFile.get(part.boxFileId) ?? []) partByPrimaryId.set(id, part);
  for (let i = 0; i < primaryIds.length; i += 500) {
    const vs = await db
      .select({ of: mediaFiles.variantOfMediaFileId, boxFileId: mediaFiles.boxFileId, filename: mediaFiles.filename })
      .from(mediaFiles)
      .where(and(isNotNull(mediaFiles.variantOfMediaFileId), inArray(mediaFiles.variantOfMediaFileId, primaryIds.slice(i, i + 500))));
    for (const v of vs) {
      const part = v.of ? partByPrimaryId.get(v.of) : undefined;
      if (part && !part.variants.some((x) => x.boxFileId === v.boxFileId)) part.variants.push({ boxFileId: v.boxFileId, filename: v.filename });
    }
  }
  return { groups: out, skipped };
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

/** ffmpeg's input summary of a LOCAL file (it exits nonzero without an output; that's expected). */
function summarize(ffmpeg: string, file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", () => resolve(err));
  });
}

/** Runs one encode, printing progress about once a minute. */
function encode(ffmpeg: string, argv: string[], durationSeconds: number | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, argv, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    let lastPrint = Date.now();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timed out"));
    }, FFMPEG_TIMEOUT_MS);
    child.stderr.on("data", (d: Buffer) => {
      tail = (tail + d.toString()).slice(-4000);
      if (Date.now() - lastPrint < 60_000) return;
      const t = [...tail.matchAll(/time=(\d+):(\d{2}):(\d{2})/g)].pop();
      if (!t) return;
      lastPrint = Date.now();
      const done = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
      console.log(`      ${durationSeconds ? `${Math.min(99, Math.round((done / durationSeconds) * 100))}%` : `${Math.round(done / 60)} min in`}`);
    });
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${tail.slice(-600)}`));
    });
  });
}

async function uploadWithRetries(getToken: TokenProvider, folderId: string, name: string, filePath: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await uploadFile({
        getToken,
        folderId,
        name,
        filePath,
        onProgress: ({ part, parts, uploadedBytes, size }) => console.log(`      upload part ${part}/${parts} (${Math.round((uploadedBytes / size) * 100)}%)`),
      });
    } catch (err) {
      if (attempt >= UPLOAD_ATTEMPTS) throw err;
      const waitSeconds = Math.min(30 * attempt, 120);
      console.warn(`      upload attempt ${attempt} failed (${(err as Error).message.split("\n")[0]}); retrying in ${waitSeconds}s`);
      await new Promise((r) => setTimeout(r, waitSeconds * 1000));
    }
  }
}

const folderNames = new Map<string, Set<string>>();
/** The lower-cased file names in a Box folder (kept up to date as this script adds and renames files). */
async function namesIn(serverId: string, folderId: string): Promise<Set<string>> {
  const key = `${serverId}:${folderId}`;
  let names = folderNames.get(key);
  if (!names) {
    const entries = await createBoxProviderForServer(serverId).listFolder(folderId);
    names = new Set(entries.filter((e) => e.kind === "file").map((e) => e.name.toLowerCase()));
    folderNames.set(key, names);
  }
  return names;
}

type Plan = {
  g: Group;
  srcLabel: string;
  /** The film's name with no label and no part marker: what each version's single file is named from. */
  baseName: string;
  missing: number[];
  renames: { part: Part; to: string }[];
  note: string | null;
};

const mainName = (p: Pick<Plan, "baseName">, rung: number) => withVersionLabel(p.baseName, rungLabel(rung));

/** What a film needs, from its name, its probed size and what is already in its Box folder. Null when there is nothing to do. */
async function plan(g: Group): Promise<Plan | { skip: string } | null> {
  const first = g.parts[0];
  const sized = g.parts.find((x) => x.width && x.height);
  if (!sized || !sized.width || !sized.height) return { skip: "its size isn't known to Roam yet (run a scan so it gets probed)" };
  const parsed = splitVersionLabel(first.filename);
  const srcLabel = parsed.label || originalLabel(sized.width, sized.height);
  const baseName = withoutSplitMarker(parsed.rest);
  const names = await namesIn(g.serverId, g.folderId);
  // The original's audio, when Roam has read it, says whether each rung also wants an AAC copy; otherwise that is decided at encode time.
  const wantsAac = first.codecProbed && !isBrowserSafeAudioCodec(first.audioCodec);
  const missing = rungsBelow(sized.width, sized.height, wanted).filter((r) => {
    const main = withVersionLabel(baseName, rungLabel(r)).toLowerCase();
    return !names.has(main) || (wantsAac && !names.has(variantFileName(main).toLowerCase()));
  });
  const renames: Plan["renames"] = [];
  const notes: string[] = [];
  if (!parsed.label && !skipRename) {
    for (const part of g.parts) {
      const to = withVersionLabel(part.filename, srcLabel);
      if (names.has(to.toLowerCase())) notes.push(`can't rename "${part.filename}" to "${to}": that name is already there`);
      else renames.push({ part, to });
    }
  }
  const note = notes.length ? notes.join("; ") : null;
  if (missing.length === 0 && renames.length === 0) return note ? { skip: note } : null;
  return { g, srcLabel, baseName, missing, renames, note };
}

async function makeRungs(ffmpeg: string, p: Plan) {
  const { g } = p;
  const dir = join(workRoot, randomUUID());
  await mkdir(dir, { recursive: true });
  try {
    // All of the original's parts, then one input that plays them as one film.
    const inputs: string[] = [];
    for (const [i, part] of g.parts.entries()) {
      const file = join(dir, `part-${i + 1}.mp4`);
      const { url } = await getFreshDownloadUrl(g.serverId, part.boxFileId);
      console.log(`   downloading${g.parts.length > 1 ? ` part ${i + 1}/${g.parts.length}` : ""} ...`);
      await downloadToFile(url, file);
      inputs.push(file);
    }
    let duration = 0;
    let info: ReturnType<typeof parseVideoInfo> = null;
    let audio: ReturnType<typeof parseFirstAudioStream> = null;
    let sourceAudioKbps: number | null = null;
    for (const [i, file] of inputs.entries()) {
      const summary = await summarize(ffmpeg, file);
      const here = parseVideoInfo(summary);
      if (!here) throw new Error(`no video stream found in part ${i + 1}`);
      duration += here.durationSeconds ?? g.parts[i].durationSeconds ?? 0;
      if (i === 0) {
        info = here;
        audio = parseFirstAudioStream(summary);
        sourceAudioKbps = parseAudioKbps(summary);
      }
    }
    if (!info) throw new Error("no video stream found");
    const inputArgs = inputs.length === 1 ? ["-i", inputs[0]] : ["-f", "concat", "-safe", "0", "-i", join(dir, "parts.txt")];
    if (inputs.length > 1) await writeFile(join(dir, "parts.txt"), inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const wantsAac = audio !== null && audioNeedsAacCopy(audio.codec);
    const getToken = tokenProvider(g.serverId);
    const names = await namesIn(g.serverId, g.folderId);

    for (const rung of p.missing) {
      const name = mainName(p, rung);
      const aacName = variantFileName(name);
      const output = join(dir, `out-${rung}.mp4`);
      const label = rungLabel(rung);

      // The rung with the original's audio kept as it is; if the container won't take that audio, it gets AAC and needs no copy.
      let audioMode: "copy" | "aac" = "copy";
      let kbps = videoKbps(rung, duration, MAX_OUTPUT_BYTES, audioMode === "copy" ? (sourceAudioKbps ?? GUESS_AUDIO_KBPS) : undefined);
      console.log(`   [${label}] encoding (${kbps} kbit/s ceiling${g.parts.length > 1 ? `, ${g.parts.length} parts joined` : ""}) ...`);
      const started = Date.now();
      for (let squeeze = 0; ; squeeze++) {
        try {
          await encode(ffmpeg, buildVersionArgs(inputArgs, output, { width: info.width, height: info.height, rung, kbps, preset, crf, audioMode }), duration);
        } catch (err) {
          if (audioMode === "aac") throw err;
          console.warn(`   [${label}] couldn't keep the original audio (${(err as Error).message.split("\n")[0].slice(0, 120)}); using AAC`);
          audioMode = "aac";
          kbps = videoKbps(rung, duration);
          continue;
        }
        const size = (await stat(output)).size;
        if (size <= MAX_OUTPUT_BYTES) break;
        if (squeeze >= SQUEEZE_ATTEMPTS) throw new Error(`the ${label} encode is ${Math.round(size / 1024 ** 2)} MB, over Box's limit, even squeezed`);
        kbps = Math.max(100, Math.floor((kbps * MAX_OUTPUT_BYTES * 0.9) / size));
        console.log(`   [${label}] too big (${Math.round(size / 1024 ** 2)} MB); encoding again at ${kbps} kbit/s ...`);
      }
      console.log(`   [${label}] encoded in ${Math.round((Date.now() - started) / 1000)}s`);

      if (!names.has(name.toLowerCase())) {
        console.log(`   [${label}] uploading "${name}" ...`);
        const uploaded = await uploadWithRetries(getToken, g.folderId, name, output);
        if ("conflictId" in uploaded) console.warn(`   [${label}] "${name}" is already in Box; left alone`);
        names.add(name.toLowerCase());
      }

      // The AAC copy beside it: the same picture, the audio made browser-friendly (like the original's own ".aac" copy).
      if (wantsAac && audioMode === "copy" && !names.has(aacName.toLowerCase())) {
        const aacOut = join(dir, `out-${rung}.aac.mp4`);
        const channels = Math.min(audio?.channels ?? 2, 8);
        try {
          await runFfmpeg(ffmpeg, output, aacOut, { timeoutMs: FFMPEG_TIMEOUT_MS, channels });
        } catch (err) {
          if (channels <= 2) throw err;
          console.warn(`   [${label}] ${channels}-channel AAC failed; retrying as stereo`);
          await runFfmpeg(ffmpeg, output, aacOut, { timeoutMs: FFMPEG_TIMEOUT_MS });
        }
        if ((await stat(aacOut)).size > MAX_OUTPUT_BYTES) {
          console.warn(`   [${label}] its AAC copy would be over Box's limit; not uploaded`);
        } else {
          console.log(`   [${label}] uploading "${aacName}" ...`);
          const uploaded = await uploadWithRetries(getToken, g.folderId, aacName, aacOut);
          if ("conflictId" in uploaded) console.warn(`   [${label}] "${aacName}" is already in Box; left alone`);
          names.add(aacName.toLowerCase());
        }
        await rm(aacOut, { force: true });
      }
      await rm(output, { force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Renames the original (each part, and its ".aac" copies) to say what resolution it is, in Box and in Roam's records. */
async function renameOriginal(p: Plan) {
  const { g } = p;
  const names = await namesIn(g.serverId, g.folderId);
  for (const { part, to } of p.renames) {
    await renameBoxEntry(g.serverId, "file", part.boxFileId, to);
    names.delete(part.filename.toLowerCase());
    names.add(to.toLowerCase());
    await db.update(mediaFiles).set({ filename: to, versionLabel: p.srcLabel.toLowerCase() }).where(and(eq(mediaFiles.boxFileId, part.boxFileId), isNull(mediaFiles.variantOfMediaFileId)));
    for (const v of part.variants) {
      const copyTo = variantFileName(withVersionLabel(stripVariantSuffix(v.filename), p.srcLabel));
      if (copyTo === v.filename) continue;
      if (names.has(copyTo.toLowerCase())) {
        console.warn(`   its browser-friendly copy can't be renamed to "${copyTo}": that name is taken`);
        continue;
      }
      await renameBoxEntry(g.serverId, "file", v.boxFileId, copyTo);
      names.delete(v.filename.toLowerCase());
      names.add(copyTo.toLowerCase());
      await db.update(mediaFiles).set({ filename: copyTo }).where(and(eq(mediaFiles.boxFileId, v.boxFileId), isNotNull(mediaFiles.variantOfMediaFileId)));
    }
  }
}

async function main() {
  if (only && only !== "movies" && only !== "shows") throw new Error('--only must be "movies" or "shows"');
  if (!Number.isFinite(crf) || crf < 10 || crf > 40) throw new Error("--crf must be a number from 10 to 40");
  if (wanted && wanted.length === 0) throw new Error('--rungs needs numbers like "720,480"');
  const ffmpeg = await ensureFfmpeg();
  const { groups, skipped: unhandled } = await loadGroups();
  console.log(`${dryRun ? "Dry run: " : ""}${groups.length} movie(s) and episode(s) in Roam to check`);
  for (const u of unhandled) console.warn(`[skipped] ${u}`);

  const c = { done: 0, rungs: 0, renamed: 0, nothing: 0, skipped: unhandled.length, failed: 0 };
  let handled = 0;
  for (const g of groups) {
    if (handled >= limit) break;
    let p: Awaited<ReturnType<typeof plan>>;
    try {
      p = await plan(g);
    } catch (err) {
      c.failed++;
      console.error(`[failed] ${g.label}: ${(err as Error).message}`);
      continue;
    }
    if (p === null) {
      c.nothing++;
      continue;
    }
    if ("skip" in p) {
      c.skipped++;
      console.warn(`[skipped] ${g.label}: ${p.skip}`);
      continue;
    }
    const what = [p.missing.length ? `make ${p.missing.map(rungLabel).join(", ")}` : null, p.renames.length ? `rename ${p.renames.length > 1 ? `${p.renames.length} parts` : `to "${p.renames[0].to}"`}` : null].filter(Boolean).join(" and ");
    if (p.note) console.warn(`[note] ${g.label}: ${p.note}`);
    if (dryRun) {
      console.log(`[would] ${g.label} (${p.srcLabel}): ${what}`);
      c.rungs += p.missing.length;
      c.renamed += p.renames.length;
      handled++;
      continue;
    }
    try {
      console.log(`[work] ${g.label} (${p.srcLabel}): ${what}`);
      const started = Date.now();
      if (p.missing.length) await makeRungs(ffmpeg, p);
      await renameOriginal(p);
      c.rungs += p.missing.length;
      c.renamed += p.renames.length;
      c.done++;
      handled++;
      console.log(`[done] ${g.label} (${Math.round((Date.now() - started) / 1000)}s)`);
    } catch (err) {
      c.failed++;
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      console.error(`[failed] ${g.label}: ${(err as Error).message}${cause ? ` (${cause.code ?? ""} ${cause.message ?? ""})` : ""}`);
    }
  }
  console.log(
    `\n${dryRun ? "Would make" : "Made"} ${c.rungs} lower version(s) and ${dryRun ? "rename" : "renamed"} ${c.renamed} original file(s); ` +
      `${c.nothing} already complete, ${c.skipped} skipped, ${c.failed} failed.` +
      (dryRun || (c.rungs === 0 && c.renamed === 0) ? "" : "\nNow rescan the libraries in Roam so the new versions show up in the player's Quality menu.")
  );
  if (c.failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
