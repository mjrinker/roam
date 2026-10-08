/**
 * Fills the public demo's Photos, Music and Audiobooks libraries in Box with openly licensed material (see
 * src/lib/demo/extras-catalog.ts): Wikimedia Commons CC0 photos (dated with their real capture dates), Musopen's
 * CC0 Chopin recordings, and LibriVox public-domain audiobook chapters. Each item is checked against the source's
 * own licence data and skipped if it isn't CC0 / public domain. Run from the repo root (reads .env.local; never writes it):
 *
 *   npx tsx --env-file=.env.local scripts/seed-demo-extras.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/seed-demo-extras.ts --server <id> --photos <folderId> --music <folderId> --audiobooks <folderId>
 *
 * Leave out a folder flag to skip that library. Writes new folders and files to the server's Box only; existing files are left alone.
 * Credits for what was added are written to demo-credits.json in the current directory.
 */
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIOBOOKS, MUSIC_ITEM, PHOTO_ALBUMS, audiobookFolders, chapterFileName, planMusic } from "@/lib/demo/extras-catalog";
import { ensurePath, fileExists, uploadIfNew } from "@/lib/demo/box-seed";
import { injectExifDate } from "@/lib/demo/exif-inject";
import { isOpenArchiveLicence, parseCommonsDate, photoTitle, pickPhotos, plainText, safeFileName, type PhotoCandidate } from "@/lib/demo/open-sources";
import { ensureFfmpeg } from "@/lib/remux/tier1";

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const dryRun = args.includes("--dry-run");
const serverId = flag("--server");
const roots = { photos: flag("--photos"), music: flag("--music"), audiobooks: flag("--audiobooks") };
const UA = { "user-agent": "RoamDemoSeeder/1.0 (portfolio project; https://github.com/mjrinker)" };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return (await res.json()) as T;
}
async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} downloading ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

interface Credit { library: string; name: string; author: string; licence: string; source: string }
const credits: Credit[] = [];

// ── Photos ──
interface CommonsPage { title: string; imageinfo?: { thumburl?: string; thumbwidth?: number; width: number; height: number; mime: string; descriptionurl: string; extmetadata?: Record<string, { value?: string }> }[] }

async function commonsCandidates(search: string): Promise<PhotoCandidate[]> {
  const pages = await Promise.all([0, 50, 100].map((offset) => commonsPage(search, offset)));
  return pages.flat();
}

async function commonsPage(search: string, offset: number): Promise<PhotoCandidate[]> {
  const q = new URLSearchParams({ gsroffset: String(offset),
    action: "query", format: "json", generator: "search", gsrnamespace: "6", gsrsearch: search, gsrlimit: "50",
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "2048", origin: "*",
  });
  const data = await getJson<{ query?: { pages?: Record<string, CommonsPage> } }>(`https://commons.wikimedia.org/w/api.php?${q}`);
  return Object.values(data.query?.pages ?? {}).flatMap((p) => {
    const info = p.imageinfo?.[0];
    if (!info?.thumburl) return [];
    const meta = info.extmetadata ?? {};
    return [{
      title: p.title, mime: info.mime, width: info.width, height: info.height,
      licence: meta.LicenseShortName?.value ?? null,
      takenAt: parseCommonsDate(meta.DateTimeOriginal?.value),
      pageUrl: info.descriptionurl, downloadUrl: info.thumburl,
      artist: plainText(meta.Artist?.value, 80) || "Unknown",
    }];
  });
}

async function seedPhotos(folders: Map<string, string>) {
  const used = new Set<string>();
  for (const album of PHOTO_ALBUMS) {
    const picked = pickPhotos((await commonsCandidates(album.search)).filter((c) => !used.has(photoTitle(c.title).toLowerCase())), album.take);
    console.log(`\nPhotos / ${album.album}: ${picked.length} of ${album.take} wanted`);
    for (const c of picked) {
      used.add(photoTitle(c.title).toLowerCase());
      const name = `${safeFileName(photoTitle(c.title))}.jpg`;
      console.log(`  ${name}  ${c.takenAt!.toISOString().slice(0, 10)}  ${c.licence}  by ${c.artist}`);
      credits.push({ library: "Photos", name, author: c.artist, licence: c.licence!, source: c.pageUrl });
      if (dryRun || !roots.photos) continue;
      const folder = await ensurePath(serverId!, roots.photos, [album.album], folders);
      if (await fileExists(serverId!, folder, name)) { console.log("    already there"); continue; }
      const file = join(work, "photo.jpg");
      await writeFile(file, injectExifDate(await download(c.downloadUrl), c.takenAt!));
      console.log(`    ${await uploadIfNew(serverId!, folder, name, file, { contentCreatedAt: c.takenAt!.toISOString() })}`);
    }
  }
}

// ── Archive items ──
interface ArchiveMeta { metadata: { licenseurl?: string; creator?: string | string[]; title?: string }; files: { name: string; format?: string; title?: string; length?: string }[] }
async function archiveItem(id: string): Promise<ArchiveMeta> {
  const meta = await getJson<ArchiveMeta>(`https://archive.org/metadata/${id}`);
  if (!isOpenArchiveLicence(meta.metadata.licenseurl)) throw new Error(`${id}: licence "${meta.metadata.licenseurl ?? "none"}" is not CC0 / public domain; refusing`);
  return meta;
}
const archiveUrl = (id: string, file: string) => `https://archive.org/download/${id}/${file.split("/").map(encodeURIComponent).join("/")}`;

function ffmpegTag(ffmpeg: string, input: string, output: string, tags: Record<string, string | number>): Promise<void> {
  const meta = Object.entries(tags).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]);
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpeg, ["-y", "-v", "error", "-i", input, "-map", "0:a:0", "-map_metadata", "-1", "-c", "copy", "-id3v2_version", "3", ...meta, output], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err}`))));
  });
}

async function seedMusic(folders: Map<string, string>, ffmpeg: string) {
  const meta = await archiveItem(MUSIC_ITEM);
  console.log(`\nMusic (${MUSIC_ITEM}, ${meta.metadata.licenseurl})`);
  const have = new Set(meta.files.map((f) => f.name));
  for (const t of planMusic()) {
    if (!have.has(t.sourceFile)) { console.log(`  MISSING in archive: ${t.sourceFile}`); continue; }
    console.log(`  ${t.folders.join("/")}/${t.fileName}`);
    credits.push({ library: "Music", name: t.fileName, author: "Aaron Dunn (Musopen)", licence: "CC0 1.0", source: `https://archive.org/details/${MUSIC_ITEM}` });
    if (dryRun || !roots.music) continue;
    const folder = await ensurePath(serverId!, roots.music, t.folders, folders);
    if (await fileExists(serverId!, folder, t.fileName)) { console.log("    already there"); continue; }
    const raw = join(work, "in.mp3"), out = join(work, "out.mp3");
    await writeFile(raw, await download(archiveUrl(MUSIC_ITEM, t.sourceFile)));
    await ffmpegTag(ffmpeg, raw, out, t.tags);
    console.log(`    ${await uploadIfNew(serverId!, folder, t.fileName, out)}`);
  }
}

async function seedAudiobooks(folders: Map<string, string>) {
  for (const book of AUDIOBOOKS) {
    const meta = await archiveItem(book.item);
    const chapters = meta.files.filter((f) => f.format === "64Kbps MP3").sort((a, b) => a.name.localeCompare(b.name)).slice(0, book.chapters);
    console.log(`\nAudiobook: ${book.author} / ${book.title} (${book.item}) ${chapters.length} chapter(s)`);
    for (const [i, ch] of chapters.entries()) {
      const name = chapterFileName(i, ch.title, ch.name.replace(/\.mp3$/i, ""));
      console.log(`  ${name}`);
      credits.push({ library: "Audiobooks", name: `${book.title} - ${name}`, author: `LibriVox volunteers; ${book.author}`, licence: "Public domain", source: `https://archive.org/details/${book.item}` });
      if (dryRun || !roots.audiobooks) continue;
      const folder = await ensurePath(serverId!, roots.audiobooks, audiobookFolders(book), folders);
      if (await fileExists(serverId!, folder, name)) { console.log("    already there"); continue; }
      const file = join(work, "ch.mp3");
      await writeFile(file, await download(archiveUrl(book.item, ch.name)));
      console.log(`    ${await uploadIfNew(serverId!, folder, name, file)}`);
    }
  }
}

const work = join(tmpdir(), `roam-demo-extras-${process.pid}`);

async function main() {
  if (!dryRun && (!serverId || !(roots.photos || roots.music || roots.audiobooks))) throw new Error("Pass --server and at least one of --photos, --music, --audiobooks (or --dry-run).");
  await mkdir(work, { recursive: true });
  const folders = new Map<string, string>();
  const ffmpeg = await ensureFfmpeg();
  try {
    if (dryRun || roots.photos) await seedPhotos(folders);
    if (dryRun || roots.music) await seedMusic(folders, ffmpeg);
    if (dryRun || roots.audiobooks) await seedAudiobooks(folders);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  if (!dryRun) {
    const path = "demo-credits.json";
    const prior: Credit[] = await readFile(path, "utf8").then(JSON.parse).catch(() => []);
    const key = (c: Credit) => `${c.library}/${c.name}`;
    const merged = [...new Map([...prior, ...credits].map((c) => [key(c), c])).values()];
    await writeFile(path, JSON.stringify(merged, null, 2));
    console.log(`\nCredits recorded in ${path} (${merged.length}).`);
  } else console.log("\nDry run: nothing was downloaded beyond metadata, nothing uploaded.");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
