#!/usr/bin/env node
// Remuxes movies whose audio browsers can't play (AC-3, E-AC-3, DTS, ...) to
// stereo AAC, locally, next to the original. Meant to run on a Windows PC
// where Box Drive syncs your Box library to a normal folder: each movie's
// copy is written into ITS OWN folder, so Box Drive uploads it to the same
// Box location, and a Roam rescan/resync links it as the browser-friendly
// version ("<name>.aac.<ext>" — the naming Roam's scanner recognizes).
//
// Needs ffmpeg and ffprobe on PATH (https://ffmpeg.org/download.html).
//
//   node scripts/remux-local.mjs                     # uses ROOT below
//   node scripts/remux-local.mjs "D:\Box\Movies"     # override the parent folder
//   node scripts/remux-local.mjs --dry-run           # only report what would be remuxed
//
// Layout expected (same as Roam's): <ROOT>\<Movie Folder>\<Movie file>.mp4

import { spawn } from "node:child_process";
import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

// Dummy parent folder — replace with your Box Drive movies folder, or pass it as an argument.
const ROOT = String.raw`C:\Users\YourName\Box\Movies`;

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);
const EXTRA_RE = /-(?:behindthescenes|deleted|featurette|interview|scene|short|trailer|other)\.[^.]+$/i;
const VARIANT_TAG = ".aac";
// Audio codecs every browser plays; anything else gets remuxed.
const BROWSER_SAFE = new Set(["aac", "mp3"]);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const root = args.find((a) => !a.startsWith("--")) ?? ROOT;

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

async function audioCodec(file) {
  const out = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_name",
    "-of", "csv=p=0",
    file,
  ]);
  return out.trim().toLowerCase() || null; // null = no audio stream
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

// Same audio handling as Roam's server-side remux: video untouched, first
// audio track to stereo AAC, plain faststart (Roam's duration probe needs a non-fragmented moov).
async function remux(input, output) {
  const partial = `${output}.partial`;
  await rm(partial, { force: true });
  try {
    await run("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", input,
      "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "copy", "-c:a", "aac", "-ac", "2", "-b:a", "192k",
      "-movflags", "+faststart",
      "-f", "mp4",
      partial,
    ]);
    // Renamed only when complete, so Box Drive never syncs (and Roam never scans) a half-written file.
    await rename(partial, output);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
}

const counts = { checked: 0, remuxed: 0, alreadyOk: 0, hasCopy: 0, noAudio: 0, failed: 0 };

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

    if (await exists(output)) {
      counts.hasCopy++;
      continue;
    }
    try {
      const codec = await audioCodec(input);
      if (codec === null) {
        counts.noAudio++;
        continue;
      }
      if (BROWSER_SAFE.has(codec)) {
        counts.alreadyOk++;
        continue;
      }
      if (dryRun) {
        console.log(`[would remux] ${input}  (${codec})`);
        counts.remuxed++;
        continue;
      }
      console.log(`[remuxing] ${input}  (${codec} -> aac) ...`);
      const started = Date.now();
      await remux(input, output);
      console.log(`[done] ${outName}  (${Math.round((Date.now() - started) / 1000)}s)`);
      counts.remuxed++;
    } catch (err) {
      counts.failed++;
      console.error(`[failed] ${input}: ${err.message}`);
    }
  }
}

async function main() {
  if (!(await exists(root))) {
    console.error(`Parent folder not found: ${root}\nEdit ROOT in this script or pass the folder as an argument.`);
    process.exit(1);
  }
  const entries = await readdir(root, { withFileTypes: true });
  const movieFolders = entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  console.log(`${dryRun ? "Dry run: " : ""}scanning ${movieFolders.length} movie folder(s) in ${root}`);
  for (const folder of movieFolders) await processFolder(folder);
  console.log(
    `\nChecked ${counts.checked} file(s): ${counts.remuxed} ${dryRun ? "need" : "remuxed"}, ` +
      `${counts.alreadyOk} already browser-safe, ${counts.hasCopy} already have an .aac copy, ` +
      `${counts.noAudio} without audio, ${counts.failed} failed.`
  );
  if (counts.remuxed && !dryRun) {
    console.log("Let Box Drive finish syncing, then rescan the library (or Resync each title) in Roam to link the copies.");
  }
  if (counts.failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
