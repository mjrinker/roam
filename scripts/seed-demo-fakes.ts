/**
 * Fills the public demo with stand-ins for things that can't be shipped for real (see src/lib/demo/fake-catalog.ts):
 *  - the J.R.R. Tolkien books, as real titles/years/series on EPUBs that carry public-domain text (William Morris) and a generated cover;
 *  - albums by famous artists, as real titles and track lists on 40-second clips of CC0 Chopin recordings (Musopen).
 * Run from the repo root (reads .env.local; never writes it):
 *
 *   npx tsx --env-file=.env.local scripts/seed-demo-fakes.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/seed-demo-fakes.ts --server <id> --tolkien <eBooksFolderId> --fake-music <musicFolderId>
 *
 * Writes new folders and files to the server's Box only; existing files are left alone, so it can be re-run.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_ALBUMS, TOLKIEN, TOLKIEN_BOOKS, planFakeMusic, tolkienPath, type PlannedClip } from "@/lib/demo/fake-catalog";
import { MUSIC_ITEM } from "@/lib/demo/extras-catalog";
import { ensurePath, fileExists, uploadIfNew } from "@/lib/demo/box-seed";
import { isOpenArchiveLicence } from "@/lib/demo/open-sources";
import { buildPlaceholderEpub } from "@/lib/demo/placeholder-epub";
import { renderCoverPng } from "@/lib/demo/placeholder-cover";
import { ensureFfmpeg } from "@/lib/remux/tier1";

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const dryRun = args.includes("--dry-run");
const serverId = flag("--server");
const tolkienRoot = flag("--tolkien");
const musicRoot = flag("--fake-music");
const UA = { "user-agent": "RoamDemoSeeder/1.0 (portfolio project; https://github.com/mjrinker)" };
const CACHE = join(tmpdir(), "roam-demo-fakes-cache");
const MORRIS_ID = 169;
const SOURCE_COUNT = 44;

async function fetchOk(url: string): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const res = await fetch(url, { headers: UA });
      if (res.ok) return res;
      last = new Error(`${res.status} for ${url}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** The paragraphs of William Morris's The Well at the World's End (public domain), without Gutenberg's header and footer. */
async function morrisParagraphs(): Promise<string[]> {
  const text = await (await fetchOk(`https://www.gutenberg.org/cache/epub/${MORRIS_ID}/pg${MORRIS_ID}.txt`)).text();
  if (!/Well at the World's End/i.test(text.slice(0, 400))) throw new Error("Gutenberg #169 is not the book this script expects; refusing to use it.");
  const body = text.split(/\*\*\* ?START OF[^\n]*\n/)[1]?.split(/\*\*\* ?END OF/)[0] ?? "";
  return body
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 120 && p.length <= 1400 && /[a-z]/.test(p) && p !== p.toUpperCase());
}

async function seedTolkien(folders: Map<string, string>) {
  console.log(`\nTolkien (${TOLKIEN_BOOKS.length} placeholder books)`);
  const paragraphs = await morrisParagraphs();
  if (paragraphs.length < 400) throw new Error("Too little text found to build the placeholder books.");
  for (const [i, book] of TOLKIEN_BOOKS.entries()) {
    const { folders: path, fileName } = tolkienPath(book);
    console.log(`  ${[...path, fileName].join("/")}   (${book.year}${book.series ? `, ${book.series.name} #${book.series.position}` : ""})`);
    if (dryRun || !tolkienRoot) continue;
    const folder = await ensurePath(serverId!, tolkienRoot, path, folders);
    if (await fileExists(serverId!, folder, fileName)) { console.log("    already there"); continue; }
    const start = (i * 53) % (paragraphs.length - 40);
    const epub = buildPlaceholderEpub({
      title: book.title, author: TOLKIEN, year: book.year, series: book.series, cover: await renderCoverPng(book.title, TOLKIEN),
      paragraphs: paragraphs.slice(start, start + 36), textCredit: "William Morris, The Well at the World's End, 1896", slug: `tolkien-${i}`,
    });
    const file = join(work, "book.epub");
    await writeFile(file, epub);
    console.log(`    ${await uploadIfNew(serverId!, folder, fileName, file)}`);
  }
}

interface ArchiveFile { name: string; format?: string; length?: string; size?: string }
const seconds = (l: string | undefined) => {
  const parts = (l ?? "").split(":").map(Number);
  return parts.some(Number.isNaN) ? 0 : parts.reduce((t, v) => t * 60 + v, 0);
};

function runFfmpeg(ffmpeg: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpeg, argv, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => (err = (err + d).slice(-1500)));
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err}`))));
  });
}

async function seedMusic(folders: Map<string, string>, ffmpeg: string) {
  const meta = (await (await fetchOk(`https://archive.org/metadata/${MUSIC_ITEM}`)).json()) as { metadata: { licenseurl?: string }; files: ArchiveFile[] };
  if (!isOpenArchiveLicence(meta.metadata.licenseurl)) throw new Error(`${MUSIC_ITEM}: licence "${meta.metadata.licenseurl ?? "none"}" is not CC0 / public domain; refusing`);
  const sources = meta.files
    .filter((f) => f.name.toLowerCase().endsWith(".mp3"))
    .map((f) => ({ file: f.name, seconds: seconds(f.length) }))
    .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file))
    .slice(0, SOURCE_COUNT);
  const plan = planFakeMusic(FAKE_ALBUMS, sources);
  console.log(`\nAlbums (${FAKE_ALBUMS.length} albums, ${plan.length} songs) from ${new Set(plan.map((p) => p.sourceFile)).size} CC0 recordings (${MUSIC_ITEM})`);
  for (const a of FAKE_ALBUMS) console.log(`  ${a.artist} / ${a.album} (${a.year}): ${a.tracks.length} songs`);
  if (dryRun || !musicRoot) return;

  await mkdir(CACHE, { recursive: true });
  const cached = async (name: string) => {
    const path = join(CACHE, name.replace(/[^\w.-]+/g, "_"));
    try {
      if ((await stat(path)).size > 0) return path;
    } catch {
      /* not cached yet */
    }
    const res = await fetchOk(`https://archive.org/download/${MUSIC_ITEM}/${name.split("/").map(encodeURIComponent).join("/")}`);
    await writeFile(path, new Uint8Array(await res.arrayBuffer()));
    return path;
  };
  for (const clip of plan) {
    const label = `${clip.folders.join("/")}/${clip.fileName}`;
    const folder = await ensurePath(serverId!, musicRoot, clip.folders, folders);
    if (await fileExists(serverId!, folder, clip.fileName)) { console.log(`  ${label}: already there`); continue; }
    const out = join(work, "clip.mp3");
    await rm(out, { force: true });
    await cutClip(ffmpeg, await cached(clip.sourceFile), out, clip);
    console.log(`  ${label}: ${await uploadIfNew(serverId!, folder, clip.fileName, out)}`);
  }
}

function cutClip(ffmpeg: string, input: string, output: string, c: PlannedClip): Promise<void> {
  const tags = { title: c.title, artist: c.artist, album_artist: c.artist, album: c.album, track: c.track, date: c.year, comment: "Stand-in audio for the Roam demo: a clip of a CC0 Musopen recording." };
  const meta = Object.entries(tags).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]);
  return runFfmpeg(ffmpeg, ["-y", "-v", "error", "-ss", String(c.startSeconds), "-t", String(c.durationSeconds), "-i", input, "-map", "0:a:0", "-map_metadata", "-1", "-c", "copy", "-id3v2_version", "3", ...meta, output]);
}

const work = join(tmpdir(), `roam-demo-fakes-${process.pid}`);

interface Credit { library: string; name: string; author: string; licence: string; source: string }

async function main() {
  if (!dryRun && (!serverId || !(tolkienRoot || musicRoot))) throw new Error("Pass --server and at least one of --tolkien, --fake-music (or --dry-run).");
  await mkdir(work, { recursive: true });
  const folders = new Map<string, string>();
  try {
    if (dryRun || tolkienRoot) await seedTolkien(folders);
    if (dryRun || musicRoot) await seedMusic(folders, await ensureFfmpeg());
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  if (dryRun) return console.log("\nDry run: nothing was uploaded.");

  // The credits for the stand-in material, merged into the credits data (one entry per source, not per file).
  const path = "src/lib/demo/extras-credits.json";
  const credits: Credit[] = JSON.parse(await readFile(path, "utf8"));
  const add = (c: Credit) => { if (!credits.some((x) => x.library === c.library && x.name === c.name)) credits.push(c); };
  if (tolkienRoot) add({ library: "eBooks", name: "Stand-in text for the J.R.R. Tolkien titles (The Well at the World's End)", author: "William Morris", licence: "Public domain (USA); Project Gutenberg", source: `https://www.gutenberg.org/ebooks/${MORRIS_ID}` });
  if (musicRoot) add({ library: "Music", name: "Stand-in audio for the albums by famous artists (Chopin recordings)", author: "Aaron Dunn (Musopen)", licence: "CC0 1.0", source: `https://archive.org/details/${MUSIC_ITEM}` });
  credits.sort((a, b) => a.library.localeCompare(b.library) || a.name.localeCompare(b.name));
  await writeFile(path, JSON.stringify(credits, null, 1));
  console.log(`\nCredits updated in ${path}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
