/**
 * Builds the public demo server's media in Box: 18 short clips (45 seconds) cut from two openly licensed films (see
 * src/lib/demo/catalog.ts), named as familiar movies and shows so Roam matches them to TMDB, in the folders Roam
 * scans. It works through the demo server's own stored Box connection, so connect Box to that server in Roam first.
 *
 * You supply the source films (download them yourself from the pages listed by --list; nothing is downloaded
 * here, so every file is one you chose and can check the licence of). Run from the repo root (reads .env.local;
 * never writes it):
 *
 *   npx tsx --env-file=.env.local scripts/seed-demo-media.ts --list
 *   npx tsx --env-file=.env.local scripts/seed-demo-media.ts --sources ~/demo-sources --dry-run
 *   npx tsx --env-file=.env.local scripts/seed-demo-media.ts --sources ~/demo-sources --server <serverId> --root <boxFolderId>
 *
 * Options:
 *   --list              print the source films, their licences and where to get them, then stop
 *   --sources <dir>     where the downloaded films are (searched recursively; matched by file name)
 *   --server <id>       the demo server in Roam (its Box connection is used)
 *   --root <id>         the Box folder to build "Movies" and "TV Shows" inside (create an empty one, e.g. "Roam Demo")
 *   --dry-run           show what would be made and uploaded; change nothing (needs only --sources)
 *   --only <text>       only files whose label contains this text
 *   --tmp <dir>         scratch space for the encoded clips
 *
 * Writes to the Box account connected to the server: new folders and files only, and a file that already
 * exists is left alone, so re-running is safe.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxApiError } from "box-node-sdk";
import { DEMO_SOURCES, planDemoMedia, type DemoSource } from "@/lib/demo/catalog";
import { createBoxProviderForServer } from "@/lib/storage/box";
import { withBoxClient } from "@/lib/storage/box-token-storage";
import { uploadFile } from "@/lib/remux/remux-core.mjs";
import { ensureFfmpeg, uploadTokenProvider } from "@/lib/remux/tier1";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name: string) => args.includes(name);
const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi)$/i;

function listSources() {
  console.log("Source films (all openly licensed; download one file of each, 720p or better; unzip them first):\n");
  for (const s of DEMO_SOURCES) {
    console.log(`  ${s.title}\n    ${s.credit}\n    ${s.license}  ${s.licenseUrl}\n    page: ${s.sourceUrl}\n    file name should match: /${s.filePattern}/i\n`);
  }
  console.log("Check each film's page for its current licence before publishing the demo.");
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (VIDEO_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/** The biggest file whose name matches the source's pattern (the best quality on offer). */
async function findSource(files: string[], source: DemoSource): Promise<string | null> {
  const re = new RegExp(source.filePattern, "i");
  const matches = files.filter((f) => re.test(f.split("/").pop() ?? ""));
  let best: { file: string; size: number } | null = null;
  for (const file of matches) {
    const { size } = await stat(file);
    if (!best || size > best.size) best = { file, size };
  }
  return best?.file ?? null;
}

function encodeClip(ffmpeg: string, input: string, output: string, start: number, seconds: number): Promise<void> {
  // 720p H.264 + AAC, index at the front: plays everywhere, and a 45-second clip is ~5-8 MB.
  const a = ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-t", String(seconds), "-i", input, "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", output];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, a, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err}`))));
  });
}

/** The id of the folder called `name` inside `parentId`, creating it if it isn't there. */
async function ensureFolder(serverId: string, parentId: string, name: string): Promise<string> {
  const provider = createBoxProviderForServer(serverId);
  const existing = (await provider.listFolder(parentId)).find((e) => e.kind === "folder" && e.name === name);
  if (existing) return existing.id;
  try {
    return await withBoxClient(serverId, async (client) => (await client.folders.createFolder({ name, parent: { id: parentId } })).id);
  } catch (err) {
    // Created by something else between the listing and now.
    if (err instanceof BoxApiError && err.responseInfo?.statusCode === 409) {
      const again = (await provider.listFolder(parentId)).find((e) => e.kind === "folder" && e.name === name);
      if (again) return again.id;
    }
    throw err;
  }
}

async function main() {
  if (has("--list")) return listSources();

  const sourcesDir = flag("--sources");
  if (!sourcesDir) throw new Error("Pass --sources <dir> (or --list to see which films to download).");
  const dryRun = has("--dry-run");
  const serverId = flag("--server");
  const root = flag("--root");
  if (!dryRun && (!serverId || !root)) throw new Error("Pass --server <id> and --root <boxFolderId> (or --dry-run).");
  const only = flag("--only");

  const found = await walk(sourcesDir);
  const sourceFile = new Map<string, string>();
  const missing: DemoSource[] = [];
  for (const s of DEMO_SOURCES) {
    const f = await findSource(found, s);
    if (f) sourceFile.set(s.id, f);
    else missing.push(s);
  }
  if (missing.length) {
    console.error(`Missing source film(s): ${missing.map((s) => s.title).join(", ")}. Run with --list to see where to get them.`);
    process.exit(1);
  }

  const plan = planDemoMedia().filter((f) => !only || f.label.toLowerCase().includes(only.toLowerCase()));
  console.log(`${plan.length} file(s) planned from ${sourceFile.size} source film(s):`);
  for (const f of plan) console.log(`  ${[...f.folders, f.fileName].join("/")}   <- ${f.sourceId} @ ${f.startSeconds}s`);
  if (dryRun) {
    console.log("\nDry run: nothing was encoded or uploaded.");
    return;
  }

  const ffmpeg = await ensureFfmpeg();
  const work = join(flag("--tmp") ?? tmpdir(), `roam-demo-${process.pid}`);
  await mkdir(work, { recursive: true });
  const folderIds = new Map<string, string>([["", root!]]);
  const created: string[] = [];
  try {
    for (const [i, file] of plan.entries()) {
      console.log(`\n[${i + 1}/${plan.length}] ${file.label}`);
      let parent = root!;
      let key = "";
      for (const part of file.folders) {
        key = `${key}/${part}`;
        if (!folderIds.has(key)) folderIds.set(key, await ensureFolder(serverId!, parent, part));
        parent = folderIds.get(key)!;
      }
      if ((await createBoxProviderForServer(serverId!).listFolder(parent)).some((e) => e.kind === "file" && e.name === file.fileName)) {
        console.log("  already in Box, skipped");
        continue;
      }
      const out = join(work, `${i}.mp4`);
      await encodeClip(ffmpeg, sourceFile.get(file.sourceId)!, out, file.startSeconds, file.durationSeconds);
      const result = await uploadFile({ getToken: uploadTokenProvider(serverId!, parent), folderId: parent, name: file.fileName, filePath: out });
      console.log("conflictId" in result ? "  already in Box, left alone" : `  uploaded (${Math.round((await stat(out)).size / 1024 / 1024)} MB)`);
      if (!("conflictId" in result)) created.push(file.fileName);
      await rm(out, { force: true });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  console.log(`\nDone. ${created.length} file(s) uploaded.`);
  for (const top of ["Movies", "TV Shows"]) {
    const id = folderIds.get(`/${top}`);
    if (id) console.log(`  ${top}: Box folder id ${id}  (add it as a ${top === "Movies" ? "Movies" : "TV Shows"} library in Roam, then scan)`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
);
