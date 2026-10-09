/**
 * Drives the offline downloads in a real, modern Chromium against a pretend server: saves files into the browser's private storage through
 * the worker (including picking up after a dropped connection and an expired address), plays a saved file, queues progress offline, and
 * checks that the service worker opens the offline page with the server gone. Run from the repo root:
 *
 *   OFFLINE_BROWSER=/path/to/chrome npx tsx scripts/offline-browser-check.ts
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { build } from "esbuild";
import { launch } from "./lib-cdp";

const exe = process.env.OFFLINE_BROWSER;
if (!exe) throw new Error("Set OFFLINE_BROWSER=/path/to/a recent chrome");
const ffmpeg = "node_modules/@ffmpeg-installer/linux-x64/ffmpeg";
const dir = fs.mkdtempSync("/tmp/offline-check-");

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
  if (!ok) failures++;
};

// Two parts of a "film": a small one and a bigger one (so a dropped connection happens mid-file).
function makeMedia(name: string, seconds: number, kbps: number) {
  const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=640x270:rate=24:duration=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:v", "libx264", "-b:v", `${kbps}k`, "-c:a", "aac", "-movflags", "+faststart", `${dir}/${name}`]);
  if (r.status !== 0) throw new Error("ffmpeg failed: " + r.stderr);
}
makeMedia("a.mp4", 6, 400);
makeMedia("b.mp4", 40, 2500);
const bytes = { "a.mp4": fs.readFileSync(`${dir}/a.mp4`), "b.mp4": fs.readFileSync(`${dir}/b.mp4`) };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// ── pretend servers ─────────────────────────────────────────────────────────
let manifestCalls = 0;
let dropNextBig = false;
let stallNextBig = false;
let expireIssuedUpTo = -1;
const mediaRequests: { file: string; range: string | undefined; n: number }[] = [];
const watchState: unknown[] = [];

const media = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  const file = url.pathname.slice(1) as keyof typeof bytes;
  const n = Number(url.searchParams.get("n"));
  mediaRequests.push({ file, range: req.headers.range, n });
  if (!bytes[file]) return void res.writeHead(404).end();
  if (n <= expireIssuedUpTo) return void res.writeHead(403).end("expired");
  const data = bytes[file];
  let start = 0;
  const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
  if (m) start = Number(m[1]);
  if (m && start >= data.length) return void res.writeHead(416, { "Content-Range": `bytes */${data.length}` }).end();
  const slice = data.subarray(start);
  res.writeHead(m ? 206 : 200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": slice.length, ...(m ? { "Content-Range": `bytes ${start}-${data.length - 1}/${data.length}` } : {}) });
  if (file === "b.mp4" && dropNextBig && !m) {
    dropNextBig = false;
    res.write(slice.subarray(0, Math.floor(slice.length * 0.4)));
    setTimeout(() => res.destroy(), 50);
    return;
  }
  if (file === "b.mp4" && stallNextBig && !m) {
    stallNextBig = false;
    res.write(slice.subarray(0, Math.floor(slice.length * 0.3))); // then silence: the response is neither finished nor closed
    return;
  }
  res.end(slice);
});

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${body}</title><link rel="stylesheet" href="/_next/static/css/a.css"></head><body><p id="marker">${body}</p><script src="/harness.js"></script><script src="/_next/static/chunks/app.js"></script></body></html>`;
let appServer: http.Server;
const app = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const send = (type: string, body: string | Buffer, status = 200) => void res.writeHead(status, { "Content-Type": type }).end(body);
  if (url.pathname === "/harness.js") return send("text/javascript", fs.readFileSync(`${dir}/harness.js`));
  if (url.pathname === "/worker.js") return send("text/javascript", fs.readFileSync(`${dir}/worker.js`));
  if (url.pathname === "/sw.js") return send("text/javascript", fs.readFileSync(`${dir}/sw.js`));
  if (url.pathname === "/offline") return send("text/html", html("offline page"));
  if (url.pathname === "/_next/static/chunks/app.js") return send("text/javascript", "window.__chunkRan = true;");
  if (url.pathname === "/_next/static/css/a.css") return send("text/css", "@font-face{font-family:x;src:url(/_next/static/media/f.woff2)} body{color:#111}");
  if (url.pathname === "/_next/static/media/f.woff2") return send("font/woff2", "font");
  if (url.pathname.startsWith("/icons/") || url.pathname === "/icon.svg") return send("image/png", "x");
  if (url.pathname === "/api/play/title/T1") {
    manifestCalls++;
    const base = `http://127.0.0.1:${(media.address() as { port: number }).port}`;
    const files = ["a.mp4", "b.mp4"] as const;
    const segments = files.map((f, i) => ({ index: i, url: `${base}/${f}?n=${manifestCalls}`, durationSeconds: i === 0 ? 6 : 40, startSeconds: i === 0 ? 0 : 6, sizeBytes: bytes[f].length }));
    return send("application/json", JSON.stringify({ ownerKind: "title", ownerId: "T1", durationSeconds: 46, segments, resumeSeconds: 0, expiresAt: "2099-01-01T00:00:00Z", version: "720p", versions: [{ label: "720p", name: "720p", height: 720 }], libraryId: "L1", defaultRate: null }));
  }
  if (url.pathname === "/api/audiobooks/B1/manifest") {
    manifestCalls++;
    const base = `http://127.0.0.1:${(media.address() as { port: number }).port}`;
    return send("application/json", JSON.stringify({ titleId: "B1", name: "A Song", authors: ["Someone"], narrators: [], seriesName: null, seriesPosition: null, coverUrl: null, albumId: null, durationSeconds: 6, segments: [{ index: 0, startSeconds: 0, durationSeconds: 6 }], chapters: [], resumeSeconds: 0, urls: [{ index: 0, url: `${base}/a.mp4?n=${manifestCalls}`, expiresAt: "2099-01-01T00:00:00Z" }], libraryId: "L2", defaultRate: null }));
  }
  if (url.pathname === "/api/watch-state" && req.method === "PATCH") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => (watchState.push(JSON.parse(raw)), send("application/json", "{}")));
    return;
  }
  if (url.pathname === "/") return send("text/html", html("home"));
  send("text/html", html("page " + url.pathname));
});

async function main() {
  // The code under test, bundled for the browser (the worker separately: the page is told to load it from /worker.js).
  const common = { bundle: true, platform: "browser" as const, alias: { "@": "./src" }, logLevel: "error" as const };
  await build({ ...common, entryPoints: ["src/lib/offline/storage.worker.ts"], outfile: `${dir}/worker.js`, format: "iife" });
  await build({
    ...common,
    stdin: {
      contents: `import * as manager from "@/lib/offline/manager"; import * as local from "@/lib/offline/local-playback"; import * as sync from "@/lib/offline/sync"; import * as storage from "@/lib/offline/storage"; window.H = { manager, local, sync, storage };`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    outfile: `${dir}/harness.js`,
    format: "iife",
    define: { "import.meta.url": '"http://localhost/harness.js"' },
  });
  // The real service worker, as the route would serve it.
  const { GET } = await import("../src/app/sw.js/route");
  fs.writeFileSync(`${dir}/sw.js`, await (GET() as Response).text());

  await new Promise<void>((r) => media.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => (appServer = app.listen(0, "127.0.0.1", r)));
  const appPort = (appServer!.address() as { port: number }).port;
  const base = `http://127.0.0.1:${appPort}`;
  const browser = await launch(exe!, 9333);
  const page = browser.page;
  try {
    await page.addInitScript(`localStorage.setItem("roam-offline-viewer", "V1");`);
    await page.addInitScript(`(() => { const W = window.Worker; window.Worker = class extends W { constructor(u, o) { super("/worker.js"); } }; })();`);
    await page.goto(`${base}/`);
    check("the harness loads", await page.waitFor(`!!window.H`, 5000));

    const options = JSON.stringify({ kind: "watch", ownerKind: "title", ownerId: "T1", title: "The Film", subtitle: "2020", posterUrl: null, options: [] });
    const choice = JSON.stringify({ label: "720p", name: "720p", height: 720, sizeBytes: bytes["a.mp4"].length + bytes["b.mp4"].length, parts: 2 });
    const state = () => page.evaluate<string>(`JSON.stringify((H.manager.getSnapshot()[0] || {}))`).then((s) => JSON.parse(s || "{}"));

    // 1. A normal download, then comparing every byte with the source.
    await page.evaluate(`H.manager.startDownload("S1", ${options}, ${choice})`);
    check("a download of two parts completes", await page.waitFor(`H.manager.getSnapshot()[0]?.status === "complete"`, 30000), await state().then((r) => [r.status, r.error]));
    const rec = await state();
    check("it knows the title, version and total size", rec.title === "The Film" && rec.versionName === "720p" && rec.totalBytes === bytes["a.mp4"].length + bytes["b.mp4"].length, [rec.title, rec.totalBytes]);
    const hashes = await page.evaluate<string[]>(`(async () => { const r = H.manager.getSnapshot()[0]; const out = []; for (const f of r.files) { const file = await H.storage.openSavedFile(f.name); const buf = await file.arrayBuffer(); const d = await crypto.subtle.digest("SHA-256", buf); out.push([...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("")); } return out; })()`);
    check("each saved file matches the original byte for byte", hashes[0] === sha(bytes["a.mp4"]) && hashes[1] === sha(bytes["b.mp4"]));

    // 1b. Downloads belong to the profile that made them.
    const asOther = await page.evaluate<{ listed: number; found: boolean; refused: string }>(`(async () => { localStorage.setItem("roam-offline-viewer", "V2"); H.manager.notifyViewerChanged(); const listed = H.manager.getSnapshot().length; const found = !!(await H.local.localVideoFor("title", "T1")); let refused = ""; try { await H.manager.startDownload("S1", ${options}, ${choice}); } catch (e) { refused = e.message; } localStorage.setItem("roam-offline-viewer", "V1"); H.manager.notifyViewerChanged(); return { listed, found, refused }; })()`);
    check("another profile on the same browser doesn't see, find or replace a download", asOther.listed === 0 && !asOther.found && asOther.refused.includes("Another profile"), asOther);

    // 2. A saved file plays.
    const played = await page.evaluate<{ duration: number; ready: number }>(`(async () => { const r = H.manager.getSnapshot()[0]; const files = await H.local.openLocalFiles(r); const v = document.createElement("video"); v.muted = true; v.src = files.urls[1]; await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("video error")); }); v.currentTime = 20; await new Promise((res) => (v.onseeked = res)); const out = { duration: v.duration, ready: v.readyState }; files.release(); return out; })()`);
    check("a saved file plays from this device and can be sought", Math.abs(played.duration - 40) < 1 && played.ready >= 2, played);

    // 3. The offline manifest and where playback resumes.
    await page.evaluate(`H.sync.queueProgress({ ownerKind: "title", ownerId: "T1", positionSeconds: 12, durationSeconds: 46, finished: false })`);
    const offlineManifest = await page.evaluate<{ resume: number; urls: string[]; duration: number }>(`(async () => { const r = H.manager.getSnapshot()[0]; const files = await H.local.openLocalFiles(r); const m = await H.local.offlineVideoManifest(r, files); const out = { resume: m.resumeSeconds, urls: m.segments.map(s => s.url.slice(0, 5)), duration: m.durationSeconds }; files.release(); return out; })()`);
    check("without a connection the saved timeline plays from blob addresses, resuming from offline progress", offlineManifest.resume === 12 && offlineManifest.urls.every((u) => u === "blob:") && offlineManifest.duration === 46, offlineManifest);
    watchState.length = 0;
    await page.evaluate(`localStorage.setItem("roam-offline-viewer", "V2")`);
    check("another profile's waiting progress is not sent as theirs", (await page.evaluate<number>(`H.sync.flushProgress()`)) === 0 && watchState.length === 0);
    await page.evaluate(`localStorage.setItem("roam-offline-viewer", "V1")`);
    check("progress made offline is sent when there is a connection, then forgotten", (await page.evaluate<number>(`H.sync.flushProgress()`)) === 1 && watchState.length === 1 && (await page.evaluate<number>(`H.sync.flushProgress()`)) === 0, watchState);

    // 4. Removing it clears the files and the record.
    await page.evaluate(`H.manager.removeDownload(H.manager.getSnapshot()[0].id)`);
    const left = await page.evaluate<number>(`(async () => { const s = await H.storage.savedSizes(["title"]); return Object.values(s).reduce((a, b) => a + b, 0); })()`);
    check("removing a download empties the list and the storage", (await page.evaluate<number>(`H.manager.getSnapshot().length`)) === 0 && left === 0);
    check("and it is gone from the saved records after a reload", await (async () => { await page.goto(`${base}/?again`); return page.evaluate<number>(`H.manager.initDownloads().then(() => H.manager.getSnapshot().length)`).then((n) => n === 0); })());

    // 5. A dropped connection part way through the big file: it carries on by itself from the same byte.
    dropNextBig = true;
    mediaRequests.length = 0;
    await page.evaluate(`H.manager.startDownload("S1", ${options}, ${choice})`);
    check("a connection that drops is picked up again by itself, and the download completes", await page.waitFor(`H.manager.getSnapshot()[0]?.status === "complete"`, 40000), await state().then((r) => [r.status, r.error]));
    const bigRequests = mediaRequests.filter((r) => r.file === "b.mp4");
    check("the second request asked only for the rest (a Range request from the saved byte)", bigRequests.length >= 2 && !bigRequests[0].range && /^bytes=[1-9]\d+-$/.test(bigRequests[1].range ?? ""), bigRequests);
    const hash2 = await page.evaluate<string>(`(async () => { const r = H.manager.getSnapshot()[0]; const buf = await (await H.storage.openSavedFile(r.files[1].name)).arrayBuffer(); const d = await crypto.subtle.digest("SHA-256", buf); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); })()`);
    check("the finished file is identical to the original", hash2 === sha(bytes["b.mp4"]));
    await page.evaluate(`H.manager.removeDownload(H.manager.getSnapshot()[0].id)`);

    // 5b. A connection that goes silent (no data, no close) is given up on, then resumed.
    stallNextBig = true;
    mediaRequests.length = 0;
    await page.evaluate(`H.manager.startDownload("S1", ${options}, ${choice})`);
    check("a connection that goes silent is dropped after a while and resumed, completing the download", await page.waitFor(`H.manager.getSnapshot()[0]?.status === "complete"`, 60000), await state().then((r) => [r.status, r.error]));
    const hash3 = await page.evaluate<string>(`(async () => { const r = H.manager.getSnapshot()[0]; const buf = await (await H.storage.openSavedFile(r.files[1].name)).arrayBuffer(); const d = await crypto.subtle.digest("SHA-256", buf); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); })()`);
    check("and nothing was lost or doubled", hash3 === sha(bytes["b.mp4"]));
    await page.evaluate(`H.manager.removeDownload(H.manager.getSnapshot()[0].id)`);

    // 5c. Pausing and resuming straight away still ends with a complete, identical file.
    await page.evaluate(`H.manager.startDownload("S1", ${options}, ${choice})`);
    await page.evaluate(`(async () => { const id = H.manager.getSnapshot()[0].id; await H.manager.pauseDownload(id); await H.manager.resumeDownload(id); })()`);
    check("pause then resume at once carries on to the end", await page.waitFor(`H.manager.getSnapshot()[0]?.status === "complete"`, 40000), await state().then((r) => [r.status, r.error]));
    const hash4 = await page.evaluate<string>(`(async () => { const r = H.manager.getSnapshot()[0]; let h = []; for (const f of r.files) { const buf = await (await H.storage.openSavedFile(f.name)).arrayBuffer(); const d = await crypto.subtle.digest("SHA-256", buf); h.push([...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("")); } return h.join(","); })()`);
    check("with both files intact", hash4 === `${sha(bytes["a.mp4"])},${sha(bytes["b.mp4"])}`);
    await page.evaluate(`H.manager.removeDownload(H.manager.getSnapshot()[0].id)`);

    // 5d. Removing while it downloads leaves nothing behind.
    await page.evaluate(`H.manager.startDownload("S1", ${options}, ${choice})`);
    await new Promise((r) => setTimeout(r, 150));
    const names = await page.evaluate<string[]>(`H.manager.getSnapshot()[0].files.map(f => f.name)`);
    await page.evaluate(`H.manager.removeDownload(H.manager.getSnapshot()[0].id)`);
    await new Promise((r) => setTimeout(r, 800));
    const leftover = await page.evaluate<number>(`H.storage.savedSizes(${JSON.stringify(names)}).then(s => Object.values(s).reduce((a, b) => a + b, 0))`);
    check("removing a download that is running leaves no files behind", leftover === 0 && (await page.evaluate<number>(`H.manager.getSnapshot().length`)) === 0, leftover);

    // 6. Addresses that have expired are replaced by fresh ones.
    const callsBefore = manifestCalls;
    expireIssuedUpTo = callsBefore + 1; // the addresses the download is first given are already expired; fresh ones work
    await page.evaluate(`H.manager.startDownload("S1", ${options}, ${choice})`);
    check("an expired address is refreshed and the download still completes", await page.waitFor(`H.manager.getSnapshot()[0]?.status === "complete"`, 30000), await state().then((r) => [r.status, r.error, manifestCalls - callsBefore]));
    check("by asking the server for new addresses", manifestCalls - callsBefore >= 2, manifestCalls - callsBefore);
    await page.evaluate(`H.manager.removeDownload(H.manager.getSnapshot()[0].id)`);

    // 6b. A song or audiobook is saved the same way and plays offline from where it was left.
    const audioOptions = JSON.stringify({ kind: "listen", ownerKind: "title", ownerId: "B1", title: "A Song", subtitle: null, posterUrl: null, options: [] });
    const audioChoice = JSON.stringify({ label: "", name: "Audio", height: null, sizeBytes: bytes["a.mp4"].length, parts: 1 });
    await page.evaluate(`H.manager.startDownload("S1", ${audioOptions}, ${audioChoice})`);
    check("an audio download completes", await page.waitFor(`H.manager.getSnapshot()[0]?.status === "complete"`, 20000), await state().then((r) => [r.status, r.error]));
    await page.evaluate(`H.sync.queueProgress({ ownerKind: "title", ownerId: "B1", positionSeconds: 3, durationSeconds: 6, finished: false })`);
    const audioManifest = await page.evaluate<{ name: string; resume: number; url: string; found: boolean }>(`(async () => { const r = await H.local.localAudioFor("B1"); const files = await H.local.openLocalFiles(r); const m = await H.local.offlineAudioManifest(r, files); const out = { name: m.name, resume: m.resumeSeconds, url: m.urls[0].url.slice(0, 5), found: !!r }; files.release(); return out; })()`);
    check("the saved song's timeline plays from this device, resuming from offline progress", audioManifest.found && audioManifest.name === "A Song" && audioManifest.resume === 3 && audioManifest.url === "blob:", audioManifest);
    await page.evaluate(`H.sync.flushProgress()`);
    // A finished file whose last step was lost before it was recorded: the server says there is nothing more to send; it counts as done.
    await page.evaluate(`new Promise((res, rej) => { const r = indexedDB.open("roam-offline", 1); r.onsuccess = () => { const tx = r.result.transaction("downloads", "readwrite"); const st = tx.objectStore("downloads"); st.getAll().onsuccess = (e) => { for (const rec of e.target.result) { rec.files[0].done = false; rec.status = "paused"; st.put(rec); } }; tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); }; })`);
    await page.goto(`${base}/?again2`);
    await page.evaluate(`H.manager.initDownloads().then(() => H.manager.resumeDownload(H.manager.getSnapshot()[0].id))`);
    check("a file that is already whole (the server answers 416) is counted as done", await page.waitFor(`H.manager.getSnapshot()[0]?.status === "complete"`, 15000), await state().then((r) => [r.status, r.error]));
    await page.evaluate(`H.manager.removeDownload(H.manager.getSnapshot()[0].id)`);

    // 7. The service worker opens the offline page when the server is gone.
    await page.goto(`${base}/`);
    check("the service worker installs", await page.evaluate<boolean>(`navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(() => true)`));
    await new Promise((r) => setTimeout(r, 800));
    const cached = await page.evaluate<string[]>(`caches.keys().then(async (ks) => { const c = await caches.open(ks[0]); return (await c.keys()).map(r => new URL(r.url).pathname); })`);
    check("it kept the offline page, its script and style, and the font", ["/offline", "/_next/static/chunks/app.js", "/_next/static/css/a.css", "/_next/static/media/f.woff2"].every((p) => cached.includes(p)), cached);
    appServer!.closeAllConnections();
    await new Promise<void>((r) => appServer!.close(() => r()));
    await page.send("Page.navigate", { url: `${base}/s/some-server/anything` });
    check("with the server gone, any page opens the offline page from the saved copy", await page.waitFor(`document.getElementById("marker")?.textContent === "offline page"`, 8000), await page.evaluate<string>("document.body ? document.body.innerText.slice(0, 80) : 'no body'"));
    check("and its script runs from the saved copy too", await page.waitFor(`window.__chunkRan === true`, 3000));
  } finally {
    browser.close();
    media.close();
    appServer!.closeAllConnections?.();
  }
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(), 200));
