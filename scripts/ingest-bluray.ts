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
 *          --night  (cut: the AAC versions get one more audio track, the first one with its loud parts evened out and mixed down to stereo,
 *                   named "<language> (night mode)": it shows in the player's Audio choice, for watching quietly late at night)
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
const night = args.includes("--night");
/** Evens out loud and quiet parts (explosions against dialogue) and keeps peaks from clipping. */
const NIGHT_FILTER = "acompressor=threshold=-24dB:ratio=4:attack=20:release=250:makeup=6dB,alimiter=limit=0.9";
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

/** Every picture keyframe's time in seconds and how many bytes of picture come before it, plus the picture's total bytes. */
async function keyframes(file: string): Promise<{ times: number[]; before: number[]; total: number }> {
  const text = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,size,flags", "-of", "csv=p=0", file], { quiet: true });
  const rows: { time: number; before: number }[] = [];
  let total = 0;
  for (const line of text.split("\n")) {
    const c = line.split(",");
    const size = Number(c[1]);
    if (!Number.isFinite(size)) continue;
    if ((c[2] ?? "").startsWith("K") && Number.isFinite(Number(c[0]))) rows.push({ time: Number(c[0]), before: total });
    total += size;
  }
  rows.sort((x, y) => x.time - y.time);
  return { times: rows.map((r) => r.time), before: rows.map((r) => r.before), total };
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

/**
 * Where to cut a film into `n` parts of near equal SIZE (not length: a film's action scenes take far more bytes than its talk): at keyframes,
 * each as close as possible to its share of the bytes, preferring a chapter mark when one costs under 5% of a part's size.
 */
export function planCuts(n: number, keys: { times: number[]; before: number[] }, audioBytesPerSecond: number, chapterStarts: number[]): number[] {
  const cost = (i: number) => keys.before[i] + audioBytesPerSecond * keys.times[i];
  const last = keys.times.length - 1;
  const all = cost(last);
  const cuts: number[] = [];
  let from = 0;
  for (let k = 1; k < n; k++) {
    const target = (all * k) / n;
    let best = from;
    for (let i = from; i <= last && cost(i) < target + all / n; i++) if (Math.abs(cost(i) - target) < Math.abs(cost(best) - target)) best = i;
    // A chapter start just as good (within 5% of a part) is nicer to cut at.
    let pick = best;
    for (const c of chapterStarts) {
      let j = best;
      while (j > from && keys.times[j] > c) j--;
      while (j < last && keys.times[j] < c - 0.5) j++;
      if (Math.abs(keys.times[j] - c) < 1 && Math.abs(cost(j) - target) < all / n / 20 && Math.abs(cost(j) - target) < Math.abs(cost(pick) - target) + all / n / 20) pick = j;
    }
    if (pick > from || cuts.length === 0) {
      cuts.push(keys.times[pick]);
      from = pick + 1;
    }
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
  argv.push("-map", "0:v:0", "-map", "1:a");
  const withNight = night && mode === "aac" && audio.length > 0;
  if (withNight) argv.push("-map", "1:a:0");
  argv.push("-map_chapters", "2");
  subs.forEach((_, i) => argv.push("-map", `${3 + i}:0`));
  argv.push("-c:v", "copy");
  if (mode === "orig") argv.push("-c:a", "copy");
  else audio.forEach((s, i) => argv.push(`-c:a:${i}`, "aac", `-b:a:${i}`, `${aacBitrate(rung, s.channels ?? 2)}k`));
  if (withNight) {
    const n = audio.length;
    argv.push(`-c:a:${n}`, "aac", `-b:a:${n}`, "128k", `-filter:a:${n}`, NIGHT_FILTER, `-ac:a:${n}`, "2", `-metadata:s:a:${n}`, `language=${audio[0].tags?.language ?? "und"}`, `-metadata:s:a:${n}`, `handler_name=${labelOf(audio[0]).replace(/ (5\.1|Stereo|Mono|\d+ch)$/, "")} (night mode)`, `-disposition:a:${n}`, "0");
  }
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
    const audioPerSecond = (origAudio * 1000) / 8;
    // The pictures' real bytes, the original audio (the larger of the two audio versions) and a little for subtitles and the container.
    const totalBytes = (keys.total + audioPerSecond * duration) * 1.01;
    let share = 0.9;
    let n = Math.max(1, Math.ceil(totalBytes / (PART_LIMIT * share)));
    console.log(`${rung}p: ${keys.times.length} keyframes, about ${(totalBytes / GIB).toFixed(1)} GiB, so ${n} parts to start with`);
    for (;;) {
      const cuts = planCuts(n, keys, audioPerSecond, chapterStarts);
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
          if (bytes > PART_LIMIT) {
            tooBig = true;
            break; // no point finishing the others: plan again with smaller parts
          }
        }
        if (tooBig) break;
      }
      if (!tooBig) break;
      for (const f of made) await rm(f, { force: true });
      share -= 0.05;
      n = Math.max(n + 1, Math.ceil(totalBytes / (PART_LIMIT * share)));
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
