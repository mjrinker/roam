/**
 * Makes resolution versions of every movie and TV episode, working straight against Box through Roam's own stored Box connection (the
 * same way scripts/remux-box.ts does). For each video file:
 *   1. works out its real resolution (from what Roam probed) and names the lower rungs of the ladder to make:
 *      2160p, 1440p, 1080p, 720p, 480p, 360p, 240p, 144p - only those BELOW the original, never an upscale;
 *   2. downloads it once, encodes each missing rung (H.264 + stereo AAC, scaled to the same shape, bitrate-capped so the file stays under
 *      Box's size limit) and uploads it next to the original as "<name> - 720p.<ext>" (Plex's version naming);
 *   3. renames the original to say what it is ("<name> - 1080p.<ext>", and its ".aac" copy with it) - last, so a run that stops half way
 *      is simply finished by running it again.
 * Nothing is written to Roam's tables except the renamed files' names; run a Roam rescan afterwards and the new versions appear in the
 * player's Quality menu. Safe to re-run: files that already exist in Box are skipped.
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
 *   --limit <n>          stop after n source files
 *   --skip-rename        make the lower versions but leave the original's name alone
 *   --preset <name>      x264 preset (default medium; slower = smaller files, much slower encodes)
 *   --crf <n>            x264 quality (default 23; lower = better and bigger)
 *   --tmp <dir>          scratch space (needs room for the largest source plus one encode)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, mediaFiles, seasons, titles } from "@/lib/db/schema";
import { splitVersionLabel, stripVariantSuffix, variantFileName, withVersionLabel } from "@/lib/scan/conventions";
import { createBoxProviderForServer, getFreshDownloadUrl, renameBoxEntry } from "@/lib/storage/box";
import { withBoxClient, ensureFreshAccessToken } from "@/lib/storage/box-token-storage";
import { downloadToFile, uploadFile, type TokenProvider } from "@/lib/remux/remux-core.mjs";
import { parseVideoInfo } from "@/lib/remux/ffmpeg-probe";
import { ensureFfmpeg } from "@/lib/remux/tier1";
import { buildVersionArgs, MAX_OUTPUT_BYTES, originalLabel, rungLabel, rungsBelow, videoKbps } from "@/lib/remux/version-plan";

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

type Variant = { boxFileId: string; filename: string };
type Group = {
  serverId: string;
  boxFileId: string;
  folderId: string;
  filename: string;
  label: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  primaryIds: string[];
  variants: Variant[];
};

async function loadGroups(): Promise<Group[]> {
  type Row = {
    id: string;
    boxFileId: string;
    filename: string;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    serverId: string;
    folderId: string;
    label: string;
  };
  const rows: Row[] = [];
  const scope = (libraryId: typeof titles.libraryId, titleId: typeof titles.id) =>
    and(libraryFilter ? eq(libraryId, libraryFilter) : undefined, titleFilter ? eq(titleId, titleFilter) : undefined);

  if (only !== "shows") {
    const movies = await db
      .select({
        id: mediaFiles.id,
        boxFileId: mediaFiles.boxFileId,
        filename: mediaFiles.filename,
        width: mediaFiles.width,
        height: mediaFiles.height,
        durationSeconds: mediaFiles.durationSeconds,
        serverId: libraries.serverId,
        folderId: sql<string>`coalesce(${titles.parentFolderId}, ${titles.boxFolderId})`,
      })
      .from(mediaFiles)
      .innerJoin(titles, eq(mediaFiles.ownerId, titles.id))
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(and(eq(mediaFiles.ownerKind, "title"), isNull(mediaFiles.variantOfMediaFileId), eq(titles.kind, "movie"), eq(libraries.kind, "movies"), scope(titles.libraryId, titles.id)));
    rows.push(...movies.map((m) => ({ ...m, label: m.filename })));
  }
  if (only !== "movies") {
    const eps = await db
      .select({
        id: mediaFiles.id,
        boxFileId: mediaFiles.boxFileId,
        filename: mediaFiles.filename,
        width: mediaFiles.width,
        height: mediaFiles.height,
        durationSeconds: mediaFiles.durationSeconds,
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
      .where(and(eq(mediaFiles.ownerKind, "episode"), isNull(mediaFiles.variantOfMediaFileId), eq(libraries.kind, "shows"), scope(titles.libraryId, titles.id)));
    rows.push(...eps.map(({ episodeFolderId, seasonFolderId, showName, ...r }) => ({ ...r, folderId: episodeFolderId ?? seasonFolderId, label: `${showName} — ${r.filename}` })));
  }

  // A combined multi-episode file has one row per episode but is one Box file.
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const key = `${r.serverId}:${r.boxFileId}`;
    const g = groups.get(key);
    if (g) {
      g.primaryIds.push(r.id);
      g.width ??= r.width;
      g.height ??= r.height;
      g.durationSeconds ??= r.durationSeconds;
    } else {
      groups.set(key, { serverId: r.serverId, boxFileId: r.boxFileId, folderId: r.folderId, filename: r.filename, label: r.label, width: r.width, height: r.height, durationSeconds: r.durationSeconds, primaryIds: [r.id], variants: [] });
    }
  }
  const out = [...groups.values()].sort((a, b) => a.filename.localeCompare(b.filename));
  // Their browser-friendly (".aac") copies, which are renamed along with them.
  for (let i = 0; i < out.length; i += 200) {
    const chunk = out.slice(i, i + 200);
    const byPrimary = new Map(chunk.flatMap((g) => g.primaryIds.map((id) => [id, g] as const)));
    const vs = await db
      .select({ of: mediaFiles.variantOfMediaFileId, boxFileId: mediaFiles.boxFileId, filename: mediaFiles.filename })
      .from(mediaFiles)
      .where(and(isNotNull(mediaFiles.variantOfMediaFileId), inArray(mediaFiles.variantOfMediaFileId, [...byPrimary.keys()])));
    for (const v of vs) {
      const g = v.of ? byPrimary.get(v.of) : undefined;
      if (g && !g.variants.some((x) => x.boxFileId === v.boxFileId)) g.variants.push({ boxFileId: v.boxFileId, filename: v.filename });
    }
  }
  return out;
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

/** The picture size and length of a LOCAL file, from ffmpeg's input summary (exits nonzero without an output; that's expected). */
function probeLocal(ffmpeg: string, file: string) {
  return new Promise<ReturnType<typeof parseVideoInfo>>((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", () => resolve(parseVideoInfo(err)));
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

type Plan = { g: Group; srcLabel: string; baseName: string; missing: number[]; renameTo: string | null; note: string | null };

/** What a file needs, from its name, its probed size and what is already in its Box folder. Null when there is nothing to do. */
async function plan(g: Group): Promise<Plan | { skip: string } | null> {
  const parsed = splitVersionLabel(g.filename);
  if (!g.width || !g.height) return { skip: "its size isn't known to Roam yet (run a scan so it gets probed)" };
  const srcLabel = parsed.label || originalLabel(g.width, g.height);
  const names = await namesIn(g.serverId, g.folderId);
  const missing = rungsBelow(g.width, g.height, wanted).filter((r) => !names.has(withVersionLabel(parsed.rest, rungLabel(r)).toLowerCase()));
  let renameTo: string | null = null;
  let note: string | null = null;
  if (!parsed.label && !skipRename) {
    renameTo = withVersionLabel(g.filename, srcLabel);
    if (names.has(renameTo.toLowerCase())) {
      note = `can't rename to "${renameTo}": a file with that name is already there`;
      renameTo = null;
    }
  }
  if (missing.length === 0 && !renameTo) return note ? { skip: note } : null;
  return { g, srcLabel, baseName: parsed.rest, missing, renameTo, note };
}

async function makeRungs(ffmpeg: string, p: Plan) {
  const { g } = p;
  const dir = join(workRoot, randomUUID());
  await mkdir(dir, { recursive: true });
  try {
    const input = join(dir, "input.mp4");
    const { url } = await getFreshDownloadUrl(g.serverId, g.boxFileId);
    console.log("   downloading ...");
    await downloadToFile(url, input);
    const info = await probeLocal(ffmpeg, input);
    if (!info) throw new Error("no video stream found in the downloaded file");
    const duration = info.durationSeconds ?? g.durationSeconds;
    const getToken = tokenProvider(g.serverId);
    const names = await namesIn(g.serverId, g.folderId);
    for (const rung of p.missing) {
      const name = withVersionLabel(p.baseName, rungLabel(rung));
      const output = join(dir, `out-${rung}.mp4`);
      let kbps = videoKbps(rung, duration);
      console.log(`   [${rungLabel(rung)}] encoding (${kbps} kbit/s ceiling) ...`);
      const started = Date.now();
      for (let squeeze = 0; ; squeeze++) {
        await encode(ffmpeg, buildVersionArgs(input, output, { width: info.width, height: info.height, rung, kbps, preset, crf }), duration);
        const size = (await stat(output)).size;
        if (size <= MAX_OUTPUT_BYTES) break;
        if (squeeze >= SQUEEZE_ATTEMPTS) throw new Error(`the ${rungLabel(rung)} encode is ${Math.round(size / 1024 ** 2)} MB, over Box's limit, even squeezed`);
        kbps = Math.max(100, Math.floor((kbps * MAX_OUTPUT_BYTES * 0.9) / size));
        console.log(`   [${rungLabel(rung)}] too big (${Math.round(size / 1024 ** 2)} MB); encoding again at ${kbps} kbit/s ...`);
      }
      console.log(`   [${rungLabel(rung)}] encoded in ${Math.round((Date.now() - started) / 1000)}s; uploading as "${name}" ...`);
      const uploaded = await uploadWithRetries(getToken, g.folderId, name, output);
      if ("conflictId" in uploaded) console.warn(`   [${rungLabel(rung)}] "${name}" is already in Box; left alone`);
      names.add(name.toLowerCase());
      await rm(output, { force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Renames the original (and its ".aac" copies) to say what resolution they are, in Box and in Roam's records. */
async function renameOriginal(p: Plan) {
  const { g } = p;
  if (!p.renameTo) return;
  const names = await namesIn(g.serverId, g.folderId);
  await renameBoxEntry(g.serverId, "file", g.boxFileId, p.renameTo);
  names.delete(g.filename.toLowerCase());
  names.add(p.renameTo.toLowerCase());
  await db.update(mediaFiles).set({ filename: p.renameTo, versionLabel: p.srcLabel.toLowerCase() }).where(and(eq(mediaFiles.boxFileId, g.boxFileId), isNull(mediaFiles.variantOfMediaFileId)));
  for (const v of g.variants) {
    const to = variantFileName(withVersionLabel(stripVariantSuffix(v.filename), p.srcLabel));
    if (to === v.filename) continue;
    if (names.has(to.toLowerCase())) {
      console.warn(`   its browser-friendly copy can't be renamed to "${to}": that name is taken`);
      continue;
    }
    await renameBoxEntry(g.serverId, "file", v.boxFileId, to);
    names.delete(v.filename.toLowerCase());
    names.add(to.toLowerCase());
    await db.update(mediaFiles).set({ filename: to }).where(and(eq(mediaFiles.boxFileId, v.boxFileId), isNotNull(mediaFiles.variantOfMediaFileId)));
  }
}

async function main() {
  if (only && only !== "movies" && only !== "shows") throw new Error('--only must be "movies" or "shows"');
  if (!Number.isFinite(crf) || crf < 10 || crf > 40) throw new Error("--crf must be a number from 10 to 40");
  if (wanted && wanted.length === 0) throw new Error('--rungs needs numbers like "720,480"');
  const ffmpeg = await ensureFfmpeg();
  const groups = await loadGroups();
  console.log(`${dryRun ? "Dry run: " : ""}${groups.length} video file(s) in Roam to check`);

  const c = { done: 0, rungs: 0, renamed: 0, nothing: 0, skipped: 0, failed: 0 };
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
    const what = [p.missing.length ? `make ${p.missing.map(rungLabel).join(", ")}` : null, p.renameTo ? `rename to "${p.renameTo}"` : null].filter(Boolean).join(" and ");
    if (p.note) console.warn(`[note] ${g.label}: ${p.note}`);
    if (dryRun) {
      console.log(`[would] ${g.label} (${p.srcLabel}): ${what}`);
      c.rungs += p.missing.length;
      c.renamed += p.renameTo ? 1 : 0;
      handled++;
      continue;
    }
    try {
      console.log(`[work] ${g.label} (${p.srcLabel}): ${what}`);
      const started = Date.now();
      if (p.missing.length) await makeRungs(ffmpeg, p);
      await renameOriginal(p);
      c.rungs += p.missing.length;
      c.renamed += p.renameTo ? 1 : 0;
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
    `\n${dryRun ? "Would make" : "Made"} ${c.rungs} lower version(s) and ${dryRun ? "rename" : "renamed"} ${c.renamed} original(s); ` +
      `${c.nothing} file(s) already complete, ${c.skipped} skipped, ${c.failed} failed.` +
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
