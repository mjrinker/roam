/**
 * Converts a movie's extras that browsers can't play (old QuickTime trailers in Sorenson/QDesign, Cinepak ...) to H.264/AAC MP4, working
 * straight against Box through Roam's own stored Box connection (like scripts/make-versions-box.ts). For each such extra:
 *   1. downloads it and encodes "<name>.mp4" (H.264 at the original size, AAC stereo, fast-start) beside it;
 *   2. adds the new file to Roam as the extra (probed, so it shows at once - no rescan);
 *   3. renames the original to "<name>.old.<ext>" (two dots, so it is no longer taken for an extra) and drops its record.
 * Safe to re-run: an extra whose ".mp4" already exists in the folder is skipped.
 *
 *   npx tsx --env-file=.env.local scripts/convert-extras-box.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/convert-extras-box.ts
 *
 * Options: --dry-run, --limit <n>, --title <id>, --crf <n> (default 20), --tmp <dir>
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titleExtras, titles } from "@/lib/db/schema";
import { extraCategoryOfFolder } from "@/lib/extras/categories";
import { probeFiles } from "@/lib/scan/media-files";
import { isBrowserPlayableMedia } from "@/lib/scan/codec-support";
import { syncTitleExtras } from "@/lib/scan/title-extras";
import { createBoxProviderForServer, getFreshDownloadUrl, renameBoxEntry } from "@/lib/storage/box";
import { ensureFreshAccessToken, withBoxClient } from "@/lib/storage/box-token-storage";
import { downloadToFile, uploadFile, type TokenProvider } from "@/lib/remux/remux-core.mjs";
import { ensureFfmpeg } from "@/lib/remux/tier1";
import type { StorageEntry } from "@/lib/storage/provider";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const limit = Number(flag("--limit") ?? Infinity);
const titleFilter = flag("--title");
const crf = Number(flag("--crf") ?? 20);
const workRoot = flag("--tmp") ?? join(tmpdir(), "roam-extras-local");

function tokenProvider(serverId: string): TokenProvider {
  return (force) =>
    withBoxClient(serverId, async (client) => {
      if (!force) await ensureFreshAccessToken(client, serverId);
      const token = force ? await client.auth.refreshToken() : await client.auth.retrieveToken();
      if (!token.accessToken) throw new Error("Box returned no access token");
      return token.accessToken;
    });
}

function encode(ffmpeg: string, input: string, output: string): Promise<void> {
  const argv = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-crf", String(crf),
    "-c:a", "aac", "-b:a", "160k", "-ac", "2",
    "-movflags", "+faststart",
    output,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, argv, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err = (err + d).slice(-1500)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err}`))));
  });
}

type Target = {
  extraId: string;
  titleId: string;
  movie: string;
  serverId: string;
  category: Parameters<typeof syncTitleExtras>[1][number]["category"];
  name: string;
  boxFileId: string;
  filename: string;
  folderId: string;
};

async function findTargets(): Promise<{ targets: Target[]; skipped: string[] }> {
  const rows = await db
    .select({
      extraId: titleExtras.id, titleId: titles.id, movie: titles.name, movieFolderId: titles.boxFolderId, serverId: libraries.serverId,
      category: titleExtras.category, name: titleExtras.name, boxFileId: titleExtras.boxFileId,
      filename: mediaFiles.filename, probeStatus: mediaFiles.probeStatus, videoCodec: mediaFiles.videoCodec, audioCodec: mediaFiles.audioCodec,
    })
    .from(titleExtras)
    .innerJoin(titles, eq(titleExtras.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "extra"), eq(mediaFiles.ownerId, titleExtras.id)))
    .where(titleFilter ? eq(titles.id, titleFilter) : undefined);
  const bad = rows.filter((r) => r.probeStatus === "ok" && !isBrowserPlayableMedia(r.videoCodec, r.audioCodec));
  const targets: Target[] = [];
  const skipped: string[] = [];
  // Where each file lives: the movie's folder, or one of its type-named subfolders.
  const parents = new Map<string, Map<string, string>>();
  for (const r of bad) {
    const key = `${r.serverId}:${r.movieFolderId}`;
    let map = parents.get(key);
    if (!map) {
      map = new Map();
      const provider = createBoxProviderForServer(r.serverId);
      const children = await provider.listFolder(r.movieFolderId);
      for (const c of children) {
        if (c.kind === "file") map.set(c.id, r.movieFolderId);
        else if (extraCategoryOfFolder(c.name)) for (const f of await provider.listFolder(c.id)) if (f.kind === "file") map.set(f.id, c.id);
      }
      parents.set(key, map);
    }
    const folderId = map.get(r.boxFileId);
    if (!folderId) {
      skipped.push(`${r.movie}: ${r.filename} isn't in the folder any more`);
      continue;
    }
    targets.push({ extraId: r.extraId, titleId: r.titleId, movie: r.movie, serverId: r.serverId, category: r.category, name: r.name, boxFileId: r.boxFileId, filename: r.filename, folderId });
  }
  return { targets: targets.sort((a, b) => a.movie.localeCompare(b.movie) || a.filename.localeCompare(b.filename)), skipped };
}

async function convert(ffmpeg: string, t: Target) {
  const base = t.filename.replace(/\.[^.]+$/, "");
  const ext = t.filename.slice(base.length);
  const outName = `${base}.mp4`;
  const provider = createBoxProviderForServer(t.serverId);
  const present = new Set((await provider.listFolder(t.folderId)).filter((e) => e.kind === "file").map((e) => e.name.toLowerCase()));
  if (present.has(outName.toLowerCase())) throw new Error(`"${outName}" is already in the folder`);

  const dir = join(workRoot, randomUUID());
  await mkdir(dir, { recursive: true });
  try {
    const input = join(dir, `in${ext}`);
    const output = join(dir, "out.mp4");
    const { url } = await getFreshDownloadUrl(t.serverId, t.boxFileId);
    console.log("   downloading ...");
    await downloadToFile(url, input);
    console.log("   encoding ...");
    await encode(ffmpeg, input, output);
    const size = (await stat(output)).size;
    console.log(`   uploading "${outName}" (${Math.round(size / 1024 ** 2)} MB) ...`);
    const uploaded = await uploadFile({ getToken: tokenProvider(t.serverId), folderId: t.folderId, name: outName, filePath: output });
    if ("conflictId" in uploaded) throw new Error(`"${outName}" is already in Box`);

    // Roam: the new file becomes the extra (probed now, so it shows at once), then the original steps aside.
    const entry = { id: uploaded.id, name: uploaded.name, kind: "file", sizeBytes: uploaded.size } as StorageEntry;
    await syncTitleExtras(t.titleId, [{ entry, category: t.category, name: t.name }], false);
    const [row] = await db
      .select({ file: mediaFiles })
      .from(mediaFiles)
      .innerJoin(titleExtras, and(eq(mediaFiles.ownerKind, "extra"), eq(mediaFiles.ownerId, titleExtras.id)))
      .where(and(eq(titleExtras.titleId, t.titleId), eq(mediaFiles.boxFileId, uploaded.id)));
    const errors: string[] = [];
    if (row) await probeFiles(provider, [row.file], Date.now() + 120_000, errors);
    if (errors.length) console.warn(`   probe: ${errors.join("; ")} (a scan will retry)`);
    await renameBoxEntry(t.serverId, "file", t.boxFileId, `${base}.old${ext}`);
    await db.delete(mediaFiles).where(and(eq(mediaFiles.ownerKind, "extra"), inArray(mediaFiles.ownerId, [t.extraId])));
    await db.delete(titleExtras).where(eq(titleExtras.id, t.extraId));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const { targets, skipped } = await findTargets();
  for (const s of skipped) console.warn(`[skipped] ${s}`);
  console.log(`${dryRun ? "Dry run: " : ""}${targets.length} extra(s) in a format browsers can't play`);
  const ffmpeg = dryRun ? "" : await ensureFfmpeg();
  let done = 0;
  let failed = 0;
  for (const t of targets.slice(0, Number.isFinite(limit) ? limit : undefined)) {
    const label = `${t.movie}: ${t.filename}`;
    if (dryRun) {
      console.log(`[would] ${label} -> ${t.filename.replace(/\.[^.]+$/, "")}.mp4`);
      continue;
    }
    try {
      console.log(`[work] ${label}`);
      await convert(ffmpeg, t);
      done++;
      console.log(`[done] ${label}`);
    } catch (err) {
      failed++;
      console.error(`[failed] ${label}: ${(err as Error).message}`);
    }
  }
  if (!dryRun) console.log(`\nConverted ${done}, failed ${failed}.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
