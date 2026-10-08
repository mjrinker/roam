/**
 * Drives the TV pages in real (old) Chromium builds with remote-control key presses, against fixture pages and a stand-in API.
 * Not part of `npm test` (it needs the browsers); run it by hand when the TV interface changes:
 *
 *   TV_BROWSERS="m69=/path/to/chrome,m86=/path/to/chrome" npx tsx scripts/tv-browser-check.ts
 *
 * Each browser runs twice: as it is, and with the APIs newer than Chromium 56 removed ("m56 mode"), which shows the script
 * does not lean on any of them. Old Chromium builds: https://storage.googleapis.com/chromium-browser-snapshots/ (Linux_x64).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { launch, type Page } from "./lib-cdp";
import { detailPage, homePage, listPage, watchPage } from "../src/tv/render";

const MEDIA = process.env.TV_MEDIA_DIR ?? "/tmp/tvsite/media";
const browsers = (process.env.TV_BROWSERS ?? "").split(",").filter(Boolean).map((s) => s.split("=") as [string, string]);
if (browsers.length === 0) throw new Error("Set TV_BROWSERS=name=/path/to/chrome[,name=/path/to/chrome]");

const poster = (n: number) => ({ href: `/tv/s/x/title/${n}`, name: `Movie ${n}`, meta: "2020", posterUrl: null });
const pages: Record<string, string> = {
  "/tv/s/x": homePage({ serverName: "Test Server", base: "/tv/s/x", profileName: "Matt", continueWatching: [poster(1), poster(2)], libraries: [{ id: "a", name: "Movies", kind: "Movies" }, { id: "b", name: "Shows", kind: "TV Shows" }], unsupported: 1 }),
  "/tv/s/x/library/a": listPage({ base: "/tv/s/x", title: "Movies", backHref: "/tv/s/x", items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(poster), prevHref: null, nextHref: "/tv/s/x/library/a?page=2" }),
  "/tv/s/x/title/1": detailPage({ title: "Movie 1", meta: "2020", overview: "About it.", posterUrl: null, backHref: "/tv/s/x/library/a", actions: [{ href: "/tv/s/x/watch/title/1", label: "Play", primary: true }, { href: "/tv/s/x", label: "Home" }] }),
  "/tv/s/x/watch/title/1": watchPage({ title: "Movie 1", subtitle: null, ownerKind: "title", ownerId: "1", back: "/tv/s/x/title/1", next: null }),
};

const saves: { positionSeconds: number; finished: boolean }[] = [];
let manifestRequests = 0;
let failFirstManifestUrl = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  if (pages[url.pathname]) return void res.writeHead(200, { "content-type": "text/html" }).end(pages[url.pathname]);
  if (url.pathname === "/tv/tv.css") return void res.writeHead(200, { "content-type": "text/css" }).end(fs.readFileSync("public/tv/tv.css"));
  if (url.pathname === "/tv/tv.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync("public/tv/tv.js"));
  if (url.pathname.startsWith("/api/play/")) {
    manifestRequests++;
    const bad = failFirstManifestUrl && manifestRequests === 1;
    const segments = [1, 2].map((i) => ({ index: i - 1, url: bad ? "/media/missing.webm" : `/media/part${i}.webm`, durationSeconds: 12, startSeconds: (i - 1) * 12 }));
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ownerKind: "title", ownerId: "1", durationSeconds: 24, segments, resumeSeconds: 0, expiresAt: "2099-01-01T00:00:00Z" }));
  }
  if (url.pathname === "/api/watch-state") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (process.env.TV_DEBUG) console.log("SAVE", req.method, body);
      saves.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    return;
  }
  if (url.pathname.startsWith("/media/")) {
    const file = path.join(MEDIA, path.basename(url.pathname));
    if (!fs.existsSync(file)) return void res.writeHead(404).end();
    const size = fs.statSync(file).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { "content-type": "video/webm", "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
      return void fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "content-type": "video/webm", "content-length": size, "accept-ranges": "bytes" });
    return void fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404).end("not found");
});

/** Removes what Chromium 56 does not have, before any page script runs. */
const M56_PRELUDE = `
  for (const [o, names] of [[Promise.prototype, ['finally']], [Object, ['fromEntries', 'hasOwn']], [Array.prototype, ['flat', 'flatMap', 'at', 'findLast']],
    [String.prototype, ['padStart', 'padEnd', 'trimStart', 'trimEnd', 'matchAll', 'replaceAll', 'at']]]) for (const n of names) { try { delete o[n]; } catch (e) {} }
  for (const n of ['AbortController', 'ResizeObserver', 'structuredClone', 'queueMicrotask']) { try { delete window[n]; } catch (e) {} }
`;

const results: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + detail}`);
}


let nextPort = 9400;
async function key(page: Page, code: number) {
  await page.evaluate(`(() => { const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true }); Object.defineProperty(e, "keyCode", { get: () => ${code} }); document.dispatchEvent(e); })()`);
}
const focusedText = (page: Page) => page.evaluate<string>(`(document.activeElement && document.activeElement.textContent || "(none)").trim().slice(0, 30)`);
const V = `document.getElementById("video")`;
const ready = (page: Page) => page.waitFor(`document.readyState === "complete"`);

async function run(label: string, exe: string, m56: boolean) {
  const { page, close } = await launch(exe, nextPort++);
  if (m56) await page.addInitScript(M56_PRELUDE);
  const L = (s: string) => `${label}${m56 ? "+m56" : ""}: ${s}`;
  const base = "http://localhost:8799";
  const at = async (suffix: string) => (await page.url()).endsWith(suffix);

  // Home: the first continue-watching card has focus; arrows move; OK opens a library.
  await page.goto(base + "/tv/s/x");
  check(L("home focuses the first card"), (await focusedText(page)).startsWith("Movie 1"), await focusedText(page));
  await key(page, 39);
  check(L("right moves to the second card"), (await focusedText(page)).startsWith("Movie 2"), await focusedText(page));
  await key(page, 40);
  check(L("down reaches the libraries"), (await focusedText(page)).startsWith("Movies"), await focusedText(page));
  await key(page, 39);
  check(L("right moves along the libraries"), (await focusedText(page)).startsWith("Shows"), await focusedText(page));
  await key(page, 37);
  await key(page, 13);
  check(L("OK opens the focused library"), await page.waitFor(`location.pathname === "/tv/s/x/library/a"`));
  await ready(page);

  // Back keys of Tizen (10009) and webOS (461) follow the page's Back button.
  await key(page, 10009);
  check(L("Tizen Back key goes back"), await page.waitFor(`location.pathname === "/tv/s/x"`));
  await page.goto(base + "/tv/s/x/library/a");
  await key(page, 461);
  check(L("webOS Back key goes back"), await page.waitFor(`location.pathname === "/tv/s/x"`));

  // A grid: moving down from the top row lands on the second row.
  await page.goto(base + "/tv/s/x/library/a");
  const first = await focusedText(page);
  await key(page, 40);
  const second = await focusedText(page);
  check(L("down moves through the grid"), first !== second && second !== "(none)", `${first} -> ${second}`);

  // Detail -> watch.
  await page.goto(base + "/tv/s/x/title/1");
  check(L("detail focuses the Play button"), (await focusedText(page)) === "Play", await focusedText(page));
  saves.length = 0;
  await key(page, 13);
  await page.waitFor(`location.pathname === "/tv/s/x/watch/title/1"`);

  // Player: plays part one, pauses/resumes, skips, rolls into part two, ends, saves as finished and goes back.
  await page.waitFor(`${V} && ${V}.currentTime > 0.5 && !${V}.paused`, 15000);
  const playing = await page.evaluate<{ t: number; paused: boolean; src: string }>(`({ t: ${V}.currentTime, paused: ${V}.paused, src: ${V}.currentSrc.split("/").pop() })`);
  check(L("the video plays part one"), playing.t > 0.5 && !playing.paused && playing.src === "part1.webm", JSON.stringify(playing));
  await key(page, 19);
  check(L("the Pause key pauses"), await page.evaluate<boolean>(`${V}.paused`));
  await key(page, 415);
  await new Promise((r) => setTimeout(r, 400));
  check(L("the Play key resumes"), !(await page.evaluate<boolean>(`${V}.paused`)));
  const before = await page.evaluate<number>(`${V}.currentTime`);
  await key(page, 39);
  await new Promise((r) => setTimeout(r, 500));
  const after = await page.evaluate<number>(`${V}.currentTime`);
  check(L("right skips ahead about ten seconds"), after - before > 7, `${before} -> ${after}`);
  await key(page, 417);
  check(L("fast-forward moves into part two"), await page.waitFor(`${V}.currentSrc.endsWith("part2.webm")`, 8000));
  check(L("finishing returns to the title"), await page.waitFor(`location.pathname === "/tv/s/x/title/1"`, 25000), await page.url());
  for (let i = 0; i < 30 && !saves.some((s) => s.finished); i++) await new Promise((r) => setTimeout(r, 100)); // a beacon arrives just after the page changes
  check(L("the end was saved as finished"), saves.some((s) => s.finished), JSON.stringify(saves));

  // A link that has gone bad is replaced: the first manifest points at a missing file; the script asks again and plays.
  manifestRequests = 0;
  failFirstManifestUrl = true;
  await page.goto(base + "/tv/s/x/watch/title/1");
  await page.waitFor(`${V} && ${V}.currentTime > 0.3 && !${V}.paused`, 15000);
  check(L("a failed link is replaced by a fresh one"), manifestRequests >= 2 && (await page.evaluate<number>(`${V}.currentTime`)) > 0.3, `requests=${manifestRequests}`);
  failFirstManifestUrl = false;
  await key(page, 27);
  check(L("Back leaves the player"), await page.waitFor(`location.pathname === "/tv/s/x/title/1"`));

  check(L("no script errors"), page.errors.length === 0, page.errors.join(" | "));
  close();
}

server.listen(8799, async () => {
  let crashed = false;
  try {
    for (const [name, exe] of browsers) for (const m56 of [false, true]) await run(name, exe, m56);
  } catch (e) {
    crashed = true;
    console.error("The check itself failed:", e instanceof Error ? e.message : e);
  } finally {
    server.close();
    console.log(results.join("\n"));
    console.log(`\n${results.filter((r) => r.startsWith("PASS")).length} passed, ${results.filter((r) => r.startsWith("FAIL")).length} failed`);
    process.exit(crashed || results.length === 0 || results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
  }
});
