#!/usr/bin/env node
// Remuxes movies and TV episodes whose audio browsers can't play (AC-3,
// E-AC-3, DTS, ...) to AAC, locally, next to the original. The full channel
// layout is kept (5.1 stays 5.1, at a bitrate to match), and an existing copy
// that was made smaller (e.g. downmixed to stereo) is redone at full size. Meant to run on a Windows PC
// where Box Drive syncs your Box library to a normal folder: each movie's
// copy is written into ITS OWN folder, so Box Drive uploads it to the same
// Box location, and a Roam rescan/resync links it as the browser-friendly
// version ("<name>.aac.<ext>" — the naming Roam's scanner recognizes).
//
// Needs ffmpeg and ffprobe on PATH (https://ffmpeg.org/download.html).
//
//   node scripts/remux-local.mjs                       # movies + shows, using the folders below
//   node scripts/remux-local.mjs --movies "D:\Box\Movies" --shows "D:\Box\TV"
//   node scripts/remux-local.mjs --only movies         # or: --only shows
//   node scripts/remux-local.mjs --dry-run             # only report what would be remuxed
//
// Layout expected (same as Roam's):
//   <MOVIES_ROOT>\<Movie Folder>\<Movie file>.mp4
//   <SHOWS_ROOT>\<Show Folder>\Season 01\<Episode file>.mp4

import { spawn } from "node:child_process";
import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

// Dummy parent folders — replace with your Box Drive folders, or pass them as arguments.
const MOVIES_ROOT = String.raw`C:\Users\YourName\Box\Movies`;
const SHOWS_ROOT = String.raw`C:\Users\YourName\Box\TV Shows`;

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);
const EXTRA_RE = /-(?:behindthescenes|deleted|featurette|interview|scene|short|trailer|other)\.[^.]+$/i;
const VARIANT_TAG = ".aac";
// Audio codecs every browser plays; anything else gets remuxed.
const BROWSER_SAFE = new Set(["aac", "mp3"]);

const SEASON_DIR_RE = /^season\s*0*\d+$/i;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const moviesRoot = flag("--movies") ?? MOVIES_ROOT;
const showsRoot = flag("--shows") ?? SHOWS_ROOT;
const only = flag("--only"); // "movies" | "shows" | undefined

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.on("error", (e) =>
      reject(e.code === "ENOENT" ? new Error(`${cmd} not found — install ffmpeg and add it to PATH`) : e)
    );
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`))
    );
  });
}

async function audioInfo(file) {
  const out = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,channels",
    "-of", "csv=p=0",
    file,
  ]);
  const [codec, channels] = out.trim().toLowerCase().split(",");
  if (!codec) return null; // no audio stream
  return { codec, channels: Number(channels) || 2 };
}

function isVariant(name) {
  const base = name.slice(0, name.lastIndexOf("."));
  return base.length > VARIANT_TAG.length && base.toLowerCase().endsWith(VARIANT_TAG);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Video untouched, first audio track to AAC keeping its channel layout (~64k per
// channel, never below 192k), plain faststart (Roam's duration probe needs a
// non-fragmented moov). A layout the AAC encoder can't take falls back to stereo.
async function encode(input, partial, channels) {
  const audio = channels
    ? ["-b:a", `${Math.max(192, channels * 64)}k`]
    : ["-ac", "2", "-b:a", "192k"];
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", input,
    "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "copy", "-c:a", "aac", ...audio,
    "-movflags", "+faststart",
    "-f", "mp4",
    partial,
  ]);
}

async function remux(input, output, channels) {
  const partial = `${output}.partial`;
  await rm(partial, { force: true });
  try {
    try {
      await encode(input, partial, channels);
    } catch (err) {
      if (channels <= 2) throw err;
      console.warn(`  full ${channels}-channel encode failed (${err.message.split("\n")[0]}); falling back to stereo`);
      await rm(partial, { force: true });
      await encode(input, partial, 0);
    }
    // Renamed only when complete, so Box Drive never syncs (and Roam never scans) a half-written file.
    // Replaces an older, smaller copy in place.
    await rename(partial, output);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
}

const counts = { checked: 0, remuxed: 0, upgraded: 0, alreadyOk: 0, hasCopy: 0, noAudio: 0, failed: 0 };

async function processFolder(folder) {
  const names = (await readdir(folder, { withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => e.name);
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext) || EXTRA_RE.test(name) || isVariant(name) || name.endsWith(".partial")) continue;

    const input = path.join(folder, name);
    const base = name.slice(0, name.length - ext.length);
    const outName = `${base}${VARIANT_TAG}${path.extname(name)}`;
    const output = path.join(folder, outName);
    counts.checked++;

    try {
      const src = await audioInfo(input);
      if (src === null) {
        counts.noAudio++;
        continue;
      }
      if (BROWSER_SAFE.has(src.codec)) {
        counts.alreadyOk++;
        continue;
      }
      // AAC can carry at most 8 channels here.
      const channels = Math.min(src.channels, 8);
      let upgrade = false;
      if (await exists(output)) {
        const copy = await audioInfo(output).catch(() => null);
        if (copy && copy.codec === "aac" && copy.channels >= channels) {
          counts.hasCopy++;
          continue;
        }
        upgrade = true;
      }
      const verb = upgrade ? "redo at full size" : "remux";
      if (dryRun) {
        console.log(`[would ${verb}] ${input}  (${src.codec} ${src.channels}ch)`);
        counts[upgrade ? "upgraded" : "remuxed"]++;
        continue;
      }
      console.log(`[${verb}] ${input}  (${src.codec} ${src.channels}ch -> aac ${channels}ch) ...`);
      const started = Date.now();
      await remux(input, output, channels);
      console.log(`[done] ${outName}  (${Math.round((Date.now() - started) / 1000)}s)`);
      counts[upgrade ? "upgraded" : "remuxed"]++;
    } catch (err) {
      counts.failed++;
      console.error(`[failed] ${input}: ${err.message}`);
    }
  }
}

async function subdirs(dir) {
  return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
}

async function requireDir(dir, label) {
  if (!(await exists(dir))) {
    console.error(`${label} folder not found: ${dir}\nEdit it at the top of this script or pass it as an argument.`);
    process.exit(1);
  }
}

async function main() {
  if (only && only !== "movies" && only !== "shows") {
    console.error('--only must be "movies" or "shows"');
    process.exit(1);
  }
  if (only !== "shows") {
    await requireDir(moviesRoot, "Movies");
    const folders = await subdirs(moviesRoot);
    console.log(`${dryRun ? "Dry run: " : ""}scanning ${folders.length} movie folder(s) in ${moviesRoot}`);
    for (const folder of folders) await processFolder(folder);
  }
  if (only !== "movies") {
    await requireDir(showsRoot, "TV shows");
    const shows = await subdirs(showsRoot);
    console.log(`${dryRun ? "Dry run: " : ""}scanning ${shows.length} show folder(s) in ${showsRoot}`);
    for (const show of shows) {
      for (const season of await subdirs(show)) {
        if (SEASON_DIR_RE.test(path.basename(season))) await processFolder(season);
      }
    }
  }
  console.log(
    `\nChecked ${counts.checked} file(s): ${counts.remuxed} ${dryRun ? "need a copy" : "remuxed"}, ` +
      `${counts.upgraded} ${dryRun ? "need" : "redone at"} full size, ` +
      `${counts.alreadyOk} already browser-safe, ${counts.hasCopy} already have a full-size copy, ` +
      `${counts.noAudio} without audio, ${counts.failed} failed.`
  );
  if (counts.remuxed + counts.upgraded && !dryRun) {
    console.log("Let Box Drive finish syncing, then rescan the library (or Resync each title) in Roam to link the copies.");
  }
  if (counts.failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
