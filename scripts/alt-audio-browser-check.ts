/**
 * A real-Chrome check of the audio overlay (lib/player/alt-audio.ts): plays a test video muted, plays its SECOND audio track through the
 * overlay, and checks that the sound is that track's tone (1320 Hz, not the default track's 440), stays within a fraction of a second of
 * the picture, and follows a seek, a pause and the crossing from one 20-second piece to the next.
 *
 *   npx tsx scripts/alt-audio-browser-check.ts [path to chrome]
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { launch } from "./lib-cdp";
import { audioFragment, audioInit, audioTrack, fetchMoov, fragmentRange, readSamples, readTracks, samplesOf } from "@/lib/media-tracks/mp4-tracks";

const S = `${tmpdir()}/roam-alt-audio-check`;
mkdirSync(S, { recursive: true });
if (!existsSync(`${S}/long.mp4`)) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=24:duration=70", "-f", "lavfi", "-i", "sine=frequency=440:duration=70", "-f", "lavfi", "-i", "sine=frequency=1320:duration=70", "-map", "0", "-map", "1", "-map", "2", "-c:v", "libx264", "-preset", "veryfast", "-g", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart", `${S}/long.mp4`]);
}
(async () => {
  const file = readFileSync(`${S}/long.mp4`);
  const f = async (a: number, b: number) => { const p = file.subarray(a, b + 1); return p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) as ArrayBuffer; };
  const tracks = readTracks(await fetchMoov(f, file.length)).tracks;
  const bundle = await build({ entryPoints: ["src/lib/player/alt-audio.ts"], bundle: true, format: "iife", globalName: "Alt", write: false, alias: { "@": "./src" } });
  const server = createServer(async (req, res) => {
    const url = req.url!;
    if (url === "/") { res.setHeader("Content-Type", "text/html"); return res.end(`<video id=v muted playsinline></video><script>${bundle.outputFiles[0].text}</script>`); }
    if (url === "/video.mp4") {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
      if (m) { const a = Number(m[1]); const b = m[2] ? Number(m[2]) : file.length - 1; res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": `bytes ${a}-${b}/${file.length}`, "Accept-Ranges": "bytes", "Content-Length": b - a + 1 }); return res.end(file.subarray(a, b + 1)); }
      res.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": file.length }); return res.end(file);
    }
    const m = /^\/a\/(\d+)\/(init|\d+)$/.exec(url);
    if (!m) { res.writeHead(404); return res.end(); }
    const t = audioTrack(tracks, Number(m[1]))!;
    const s = samplesOf(t);
    let bytes: Uint8Array;
    if (m[2] === "init") bytes = audioInit(t);
    else { const [a, b] = fragmentRange(s, t.timescale, Number(m[2])); if (b <= a) { res.writeHead(204); return res.end(); } bytes = audioFragment(s, a, b, await readSamples(f, s, a, b), Number(m[2]) + 1); }
    res.writeHead(200, { "Content-Type": "audio/mp4" }); res.end(bytes);
  }).listen(8765);
  const exe = process.argv[2] ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
  const { page, close } = await launch(exe, 9333);
  try {
    await page.goto("http://127.0.0.1:8765/");
    const out = await page.evaluate<unknown>(`(async () => {
      const v = document.getElementById("v"); v.src = "/video.mp4"; v.muted = false; v.volume = 0;
      const alt = new Alt.AltAudio({ base: "/a/1", mime: 'audio/mp4; codecs="mp4a.40.2"', onFailure: (m) => (window.fail = m) });
      const ctx = new AudioContext(); await ctx.resume(); const src = ctx.createMediaElementSource(alt.element); const an = ctx.createAnalyser(); an.fftSize = 8192; src.connect(an); an.connect(ctx.destination);
      alt.attach(v); await v.play();
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const peak = () => { const d = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(d); let bi = 0; for (let i = 1; i < d.length; i++) if (d[i] > d[bi]) bi = i; return Math.round(bi * ctx.sampleRate / an.fftSize); };
      const log = [];
      await sleep(3000); log.push(["t3", v.currentTime.toFixed(2), alt.element.currentTime.toFixed(2), alt.element.paused, peak()]);
      v.currentTime = 45; await sleep(3000); log.push(["seek45", v.currentTime.toFixed(2), alt.element.currentTime.toFixed(2), alt.element.paused, peak()]);
      v.pause(); await sleep(600); log.push(["paused", alt.element.paused]);
      v.currentTime = 19; v.playbackRate = 1; await v.play(); await sleep(4000); log.push(["cross20", v.currentTime.toFixed(2), alt.element.currentTime.toFixed(2), alt.element.paused, peak()]);
      return JSON.stringify({ log, fail: window.fail || null, errors: [] });
    })()`);
    console.log(out);
    const r = JSON.parse(String(out)) as { log: (string | number | boolean)[][]; fail: string | null };
    const problems: string[] = [];
    for (const row of r.log) {
      if (row[0] === "paused") { if (row[1] !== true) problems.push("the overlay kept playing while the video was paused"); continue; }
      if (Math.abs(Number(row[1]) - Number(row[2])) > 0.4) problems.push(`${row[0]}: sound is ${row[2]}s, picture ${row[1]}s`);
      if (Math.abs(Number(row[4]) - 1320) > 40) problems.push(`${row[0]}: heard ${row[4]} Hz, not the second track's 1320`);
    }
    if (r.fail) problems.push(r.fail);
    console.log(problems.length ? `FAILED:\n${problems.join("\n")}` : "OK");
    if (problems.length) process.exitCode = 1;
  } finally {
    close();
    server.close();
  }
  process.exit(process.exitCode ?? 0);
})().catch((e) => { console.error(e); process.exit(1); });
