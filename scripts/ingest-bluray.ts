/**
 * Turns a ripped Blu-ray (MakeMKV's `Movie_t00.mkv` ... files) into what Roam's library wants, in a local staging folder:
 *
 *   encode   one H.264 picture per resolution below the original ("work/v-720p.mkv" ...), video only
 *   cut      for every resolution (the original's own too, as a stream copy): the film with its ORIGINAL audio (every track) and a
 *            copy with every track as AAC ("<name> - 720p - pt1.mp4", "<name> - 720p - pt1.aac.mp4"), cut into parts that stay under
 *            Box's 2 GiB file limit, at picture keyframes (preferring chapter marks), with the chapters, languages and any subtitles
 *            written into each part.
 *   extras   the trailers and bonus features, as H.264/AAC MP4s named the way Plex names extras
 *   check    reads every file back and reports its streams, chapters, size and length
 *
 * Nothing here touches Box or the database; upload is a separate step. Safe to re-run: finished files are kept.
 *
 *   npx tsx scripts/ingest-bluray.ts encode --src /mnt/b/pending/blurays/David --out ~/staging/david --movie David_t00.mkv
 *
 * Options: --name "David (2025)" (default: the folder's name)  --rungs 720,480,360,240,144  --preset medium  --crf 23
 *          --subs <folder of NAME.<lang>.srt files> (cut: written into every part as text subtitles)
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { audioKbps, MAX_OUTPUT_BYTES, rungSize, videoKbps } from "@/lib/remux/version-plan";

const args = process.argv.slice(2);
const phase = args[0];
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const src = flag("--src") ?? "";
const out = flag("--out") ?? "";
const movieFile = flag("--movie") ?? "";
const name = flag("--name") ?? basename(src);
const preset = flag("--preset") ?? "medium";
const crf = Number(flag("--crf") ?? 23);
const subsDir = flag("--subs");
const wantedRungs = (flag("--rungs") ?? "720,480,360,240,144").split(",").map(Number);
const work = join(out, "work");
const final = join(out, "final", name);
const GIB = 1024 ** 3;
/** Box refuses a file of 2 GiB or more; a part is planned to be well under it. */
const PART_LIMIT = 2 * GIB - 1;

type Probe = {
  format: { duration: string; size: string };
  streams: { index: number; codec_type: string; codec_name: string; width?: number; height?: number; channels?: number; channel_layout?: string; tags?: Record<string, string> }[];
  chapters: { start_time: string; end_time: string; tags?: { title?: string } }[];
};

function run(cmd: string, argv: string[], opts: { quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let err = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => {
      const text = String(d);
      err = (err + text).slice(-4000);
      if (!opts.quiet) process.stderr.write(text.split("\n").filter((l) => /^(frame=|size=|video:)|time=/.test(l) && l.trim()).slice(-1).map((l) => `\r${l.slice(0, 110)}`).join(""));
    });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${cmd} ${argv.slice(0, 6).join(" ")} ... exited ${code}\n${err}`))));
  });
}

async function probe(file: string): Promise<Probe> {
  return JSON.parse(await run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", file], { quiet: true }));
}

/** Seconds of every picture keyframe, in order. */
async function keyframes(file: string): Promise<number[]> {
  const text = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file], { quiet: true });
  return text.split("\n").map((l) => Number(l.split(",")[0])).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

const sizeOf = async (f: string) => (await stat(f)).size;
const say = (s: string) => console.log(`\n[${new Date().toLocaleTimeString()}] ${s}`);

/** The film, copied to local disk once: every pass reads it, and the Blu-ray drive's folder is slow. */
async function localMovie(): Promise<string> {
  await mkdir(work, { recursive: true });
  const local = join(work, "movie.mkv");
  if (!existsSync(local)) {
    say(`copying ${movieFile} to local disk`);
    await copyFile(join(src, movieFile), `${local}.part`);
    await rename(`${local}.part`, local);
  }
  return local;
}

async function encode() {
  const movie = await localMovie();
  const info = await probe(movie);
  const v = info.streams.find((s) => s.codec_type === "video")!;
  const duration = Number(info.format.duration);
  for (const rung of wantedRungs) {
    const dest = join(work, `v-${rung}p.mkv`);
    if (existsSync(dest)) continue;
    const size = rungSize(v.width!, v.height!, rung);
    const kbps = videoKbps(rung, null);
    say(`encoding ${rung}p (${size.width}x${size.height}, up to ${kbps} kbit/s) of ${Math.round(duration / 60)} minutes`);
    await run("ffmpeg", [
      "-y", "-v", "error", "-stats", "-i", movie, "-map", "0:v:0", "-an", "-sn", "-dn", "-map_chapters", "-1",
      "-vf", `scale=${size.width}:${size.height}:flags=lanczos`, "-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-g", "120", "-keyint_min", "24", "-r", "24000/1001", `${dest}.part.mkv`,
    ]);
    await rename(`${dest}.part.mkv`, dest);
    say(`${rung}p done: ${((await sizeOf(dest)) / GIB).toFixed(2)} GiB`);
  }
}

// ── Cutting ──

/** AAC bitrate for one track: more for surround, less for the small versions. */
function aacBitrate(rung: number, channels: number): number {
  if (channels > 2) return rung >= 720 ? 384 : rung >= 360 ? 256 : 128;
  return audioKbps(rung);
}

const LANGUAGES: Record<string, string> = { eng: "English", spa: "Spanish", por: "Portuguese", fra: "French", fre: "French", deu: "German", ita: "Italian" };

function labelOf(s: Probe["streams"][number]): string {
  const lang = LANGUAGES[s.tags?.language ?? ""] ?? s.tags?.language ?? "Unknown";
  const channels = s.channels === 6 ? "5.1" : s.channels === 2 ? "Stereo" : s.channels ? `${s.channels}ch` : "";
  return `${lang} ${channels}`.trim();
}

/** Where to cut a film of `duration` seconds into `n` parts: near equal lengths, at keyframes, preferring the nearest chapter mark within a few minutes. */
export function planCuts(duration: number, n: number, keys: number[], chapterStarts: number[]): number[] {
  const nearest = (t: number, from: number[]) => from.reduce((best, k) => (Math.abs(k - t) < Math.abs(best - t) ? k : best), from[0]);
  const cuts: number[] = [];
  for (let i = 1; i < n; i++) {
    const target = (duration * i) / n;
    const chapter = chapterStarts.length ? nearest(target, chapterStarts) : null;
    const key = chapter !== null && Math.abs(chapter - target) < 240 ? nearest(chapter, keys) : nearest(target, keys);
    if (key > (cuts.at(-1) ?? 0) + 60 && key < duration - 60) cuts.push(key);
  }
  return cuts;
}

function chapterFile(chapters: Probe["chapters"], from: number, to: number): string {
  const lines = [";FFMETADATA1"];
  for (const c of chapters) {
    const start = Number(c.start_time);
    const end = Number(c.end_time);
    if (end <= from + 1 || start >= to - 1) continue;
    lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${Math.round((Math.max(start, from) - from) * 1000)}`, `END=${Math.round((Math.min(end, to) - from) * 1000)}`, `title=${c.tags?.title ?? "Chapter"}`);
  }
  return `${lines.join("\n")}\n`;
}

async function subtitleFiles(): Promise<{ file: string; lang: string }[]> {
  if (!subsDir) return [];
  const files = (await readdir(subsDir)).filter((f) => /\.srt$/i.test(f)).sort();
  return files.map((f) => ({ file: join(subsDir, f), lang: /\.([a-z]{3})\.srt$/i.exec(f)?.[1]?.toLowerCase() ?? "eng" }));
}

async function cutOne(opts: {
  video: string;
  movie: string;
  mode: "orig" | "aac";
  rung: number;
  from: number;
  to: number | null;
  info: Probe;
  dest: string;
  subs: { file: string; lang: string }[];
}) {
  const { video, movie, mode, rung, from, to, info, dest, subs } = opts;
  const audio = info.streams.filter((s) => s.codec_type === "audio");
  const meta = `${dest}.chapters.txt`;
  await writeFile(meta, chapterFile(info.chapters, from, to ?? Number(info.format.duration) + 1));
  const window = ["-ss", String(from), ...(to === null ? [] : ["-to", String(to)])];
  const argv = ["-y", "-v", "error", "-stats", ...window, "-i", video, ...window, "-i", movie, "-i", meta];
  subs.forEach((s) => argv.push(...window, "-i", s.file));
  argv.push("-map", "0:v:0", "-map", "1:a", "-map_chapters", "2");
  subs.forEach((_, i) => argv.push("-map", `${3 + i}:0`));
  argv.push("-c:v", "copy");
  if (mode === "orig") argv.push("-c:a", "copy");
  else audio.forEach((s, i) => argv.push(`-c:a:${i}`, "aac", `-b:a:${i}`, `${aacBitrate(rung, s.channels ?? 2)}k`));
  if (subs.length) argv.push("-c:s", "mov_text");
  argv.push("-map_metadata", "-1");
  audio.forEach((s, i) => argv.push(`-metadata:s:a:${i}`, `language=${s.tags?.language ?? "und"}`, `-metadata:s:a:${i}`, `handler_name=${labelOf(s)}`, `-disposition:a:${i}`, i === 0 ? "default" : "0"));
  subs.forEach((s, i) => argv.push(`-metadata:s:s:${i}`, `language=${s.lang}`, `-metadata:s:s:${i}`, `handler_name=${LANGUAGES[s.lang] ?? s.lang}`, `-disposition:s:${i}`, "0"));
  argv.push("-metadata", `title=${name.replace(/ \(\d{4}\)$/, "")}`, "-movflags", "+faststart", "-f", "mp4", `${dest}.part`);
  await run("ffmpeg", argv);
  await rename(`${dest}.part`, dest);
  await rm(meta, { force: true });
}

async function cut() {
  const movie = await localMovie();
  const info = await probe(movie);
  const duration = Number(info.format.duration);
  const chapterStarts = info.chapters.map((c) => Number(c.start_time));
  const subs = await subtitleFiles();
  await mkdir(final, { recursive: true });
  const v = info.streams.find((s) => s.codec_type === "video")!;
  const rungs = [Math.max(v.height!, Math.round((v.width! * 9) / 16)) >= 1000 ? 1080 : v.height!, ...wantedRungs.filter((r) => r < v.height!)];
  const audioBytes = (kbps: number) => (kbps * 1000 * duration) / 8;
  for (const rung of rungs) {
    const isOriginal = rung === rungs[0];
    const video = isOriginal ? movie : join(work, `v-${rung}p.mkv`);
    if (!existsSync(video)) {
      console.log(`skipping ${rung}p: ${video} isn't there yet`);
      continue;
    }
    const base = `${name} - ${rung}p`;
    if (existsSync(join(final, `${base}.mp4`)) || existsSync(join(final, `${base} - pt1.mp4`))) {
      say(`${rung}p is already cut`);
      continue;
    }
    const keys = await keyframes(video);
    const origAudio = info.streams.filter((s) => s.codec_type === "audio").reduce((sum, s) => sum + ((s.channels ?? 2) > 2 ? 448 : 192), 0);
    // Video alone: the encode's own size, or for the stream copy what is left of the film's file after its audio and subtitles.
    const videoBytes = isOriginal ? Number(info.format.size) - audioBytes(origAudio) - 300 * 1024 ** 2 : await sizeOf(video);
    let n = Math.max(1, Math.ceil((videoBytes + audioBytes(origAudio)) / (PART_LIMIT * 0.92)));
    for (;;) {
      const cuts = planCuts(duration, n, keys, chapterStarts);
      const bounds = [0, ...cuts, null] as (number | null)[];
      say(`${rung}p: ${bounds.length - 1} part(s), cut at ${cuts.map((c) => c.toFixed(1)).join(", ") || "-"}`);
      const made: string[] = [];
      let tooBig = false;
      for (const mode of ["orig", "aac"] as const) {
        for (let i = 0; i < bounds.length - 1; i++) {
          const parts = bounds.length - 1;
          const file = `${base}${parts > 1 ? ` - pt${i + 1}` : ""}${mode === "aac" ? ".aac" : ""}.mp4`;
          const dest = join(final, file);
          await cutOne({ video, movie, mode, rung, from: bounds[i]!, to: bounds[i + 1], info, dest, subs });
          made.push(dest);
          const bytes = await sizeOf(dest);
          console.log(`\n   ${file}: ${(bytes / GIB).toFixed(2)} GiB`);
          if (bytes > PART_LIMIT) tooBig = true;
        }
      }
      if (!tooBig) break;
      for (const f of made) await rm(f, { force: true });
      n++;
      if (n > 40) throw new Error("couldn't get the parts under the limit");
    }
  }
}

// ── Extras ──

/** The bonus videos, by the file they came from: [file, Plex name]. Menus and the other playlists of the film are left out. */
function readExtras(): [string, string][] {
  const list = flag("--extras");
  if (!list) return [];
  return list.split("|").map((pair) => pair.split("=") as [string, string]);
}

async function extras() {
  await mkdir(final, { recursive: true });
  for (const [file, plexName] of readExtras()) {
    const dest = join(final, plexName);
    if (existsSync(dest)) continue;
    const input = join(src, file);
    const info = await probe(input);
    const duration = Number(info.format.duration);
    const v = info.streams.find((s) => s.codec_type === "video")!;
    const audio = info.streams.find((s) => s.codec_type === "audio");
    // Copy the picture when it is small enough; otherwise squeeze it to fit under Box's limit.
    const small = Number(info.format.size) < MAX_OUTPUT_BYTES * 0.9;
    const kbps = videoKbps(1080, duration, MAX_OUTPUT_BYTES, 128);
    say(`${file} -> ${plexName} (${small ? "picture copied" : `re-encoded to ~${kbps} kbit/s`})`);
    const argv = ["-y", "-v", "error", "-stats", "-i", input, "-map", "0:v:0"];
    if (audio) argv.push("-map", "0:a:0");
    argv.push("-sn", "-map_chapters", "0");
    if (small) argv.push("-c:v", "copy");
    else argv.push("-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p", "-profile:v", "high", "-g", "120");
    if (audio) argv.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
    argv.push("-metadata", `title=${plexName.replace(/-[a-z]+\.mp4$/, "")}`, "-movflags", "+faststart", "-f", "mp4", `${dest}.part`);
    void v;
    await run("ffmpeg", argv);
    await rename(`${dest}.part`, dest);
  }
}

async function check() {
  for (const f of (await readdir(final)).filter((n) => n.endsWith(".mp4")).sort()) {
    const info = await probe(join(final, f));
    const kinds = (t: string) => info.streams.filter((s) => s.codec_type === t);
    const audio = kinds("audio").map((s) => `${s.tags?.language}:${s.codec_name}:${s.channels}`).join(" ");
    const subs = kinds("subtitle").map((s) => `${s.tags?.language}:${s.codec_name}`).join(" ");
    const bytes = await sizeOf(join(final, f));
    console.log(`${bytes >= 2 * GIB ? "TOO BIG " : ""}${f}\n   ${(bytes / GIB).toFixed(2)} GiB, ${Math.round(Number(info.format.duration))}s, ${kinds("video").map((s) => `${s.codec_name} ${s.width}x${s.height}`).join(" ")}, audio [${audio}], subtitles [${subs || "none"}], ${info.chapters.length} chapters`);
  }
}

(async () => {
  if (!["encode", "cut", "extras", "check"].includes(phase) || !out) throw new Error("usage: ingest-bluray.ts encode|cut|extras|check --src <folder> --out <staging> [--movie file] [--name 'Title (Year)']");
  await mkdir(out, { recursive: true });
  if (phase === "encode") await encode();
  else if (phase === "cut") await cut();
  else if (phase === "extras") await extras();
  else await check();
  say("done");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
