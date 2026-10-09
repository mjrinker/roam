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
import { detailPage, homePage, listenPage, listPage, messagePage, pairPage, photoViewPage, searchPage, watchPage } from "../src/tv/render";

const MEDIA = process.env.TV_MEDIA_DIR ?? "/tmp/tvsite/media";
const browsers = (process.env.TV_BROWSERS ?? "").split(",").filter(Boolean).map((s) => s.split("=") as [string, string]);
if (browsers.length === 0) throw new Error("Set TV_BROWSERS=name=/path/to/chrome[,name=/path/to/chrome]");

const poster = (n: number) => ({ href: `/tv/s/x/title/${n}`, name: `Movie ${n}`, meta: "2020", posterUrl: null });
const pages: Record<string, string> = {
  "/tv": messagePage("Signed in", "Welcome."),
  "/tv/pair": pairPage({ userCode: "ABCDE", linkUrl: "roam.example/link", pollUrl: "/tv/pair/poll", expiredUrl: "/tv/pair" }),
  "/tv/s/x": homePage({ serverName: "Test Server", base: "/tv/s/x", profileName: "Matt", continueWatching: [poster(1), poster(2)], libraries: [{ id: "a", name: "Movies", kind: "Movies" }, { id: "b", name: "Shows", kind: "TV Shows" }], unsupported: 1 }),
  "/tv/s/x/library/a": listPage({ base: "/tv/s/x", title: "Movies", backHref: "/tv/s/x", items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(poster), prevHref: null, nextHref: "/tv/s/x/library/a?page=2" }),
  "/tv/s/x/title/1": detailPage({ title: "Movie 1", meta: "2020", overview: "About it.", posterUrl: null, backdropUrl: "/media/pic2.png", backHref: "/tv/s/x/library/a", actions: [{ href: "/tv/s/x/watch/title/1", label: "Play", primary: true }, { href: "/tv/s/x", label: "Home" }] }),
  "/tv/s/x/search": searchPage({ base: "/tv/s/x", query: "mo", focusKey: null, max: 40, results: [1, 2, 3].map(poster) }),
  "/tv/s/x/library/f": listPage({ base: "/tv/s/x", title: "Videos", backHref: "/tv/s/x", folders: [{ href: "/tv/s/x/library/f?path=Trips", name: "Trips" }, { href: "/tv/s/x/library/f?path=Pets", name: "Pets" }], items: [1, 2, 3].map(poster), prevHref: null, nextHref: null }),
  "/tv/s/x/album/1": detailPage({ title: "First Record", meta: "The Band · 1999 · 2 songs", overview: null, posterUrl: null, square: true, backHref: "/tv/s/x/library/m", actions: [{ href: "/tv/s/x/listen/1", label: "Play album", primary: true }], listHeading: "Songs", episodes: [{ href: "/tv/s/x/listen/1", label: "1. Intro", sub: "0:12" }, { href: "/tv/s/x/listen/2", label: "2. Second", sub: "0:12" }] }),
  "/tv/s/x/listen/1": listenPage({ title: "Intro", subtitle: "The Band", coverUrl: null, ownerId: "1", remembers: false, skip: 10, back: "/tv/s/x/album/1", next: "/tv/s/x/listen/2", queue: { items: [{ id: "1", title: "Intro", by: "The Band", cover: "/media/pic1.png" }, { id: "2", title: "Second", by: "The Band", cover: "/media/pic2.png" }], index: 0 } }),
  "/tv/s/x/listen/9": listenPage({ title: "A Book", subtitle: "Someone", coverUrl: null, ownerId: "9", remembers: true, skip: 30, back: "/tv/s/x/album/1", next: null }),
  "/tv/s/x/listen/2": listenPage({ title: "Second", subtitle: "The Band", coverUrl: null, ownerId: "2", remembers: false, skip: 10, back: "/tv/s/x/album/1", next: null, queue: { items: [{ id: "1", title: "Intro", by: "The Band", cover: "/media/pic1.png" }, { id: "2", title: "Second", by: "The Band", cover: "/media/pic2.png" }], index: 1 } }),
  "/tv/s/y": homePage({ serverName: "Saver Server", base: "/tv/s/x", profileName: "Matt", continueWatching: [], libraries: [{ id: "a", name: "Pictures", kind: "Photos" }], unsupported: 0, screensaver: { href: "/tv/s/x/photo/1#slide", afterSeconds: 2 } }),
  "/tv/s/x/photo/1": photoViewPage({ title: "Picture one", imageUrl: "/media/pic1.png", prev: null, next: "/tv/s/x/photo/2", back: "/tv/s/x/library/p", position: "2024-05-01", nextImage: "/media/pic2.png" }),
  "/tv/s/x/photo/2": photoViewPage({ title: "Picture two", imageUrl: "/media/pic2.png", prev: "/tv/s/x/photo/1", next: "/tv/s/x/photo/3", back: "/tv/s/x/library/p", position: "2024-05-02" }),
  "/tv/s/x/photo/3": photoViewPage({ title: "Picture three", imageUrl: "/media/missing.png", prev: "/tv/s/x/photo/2", next: null, back: "/tv/s/x/library/p", position: null }),
  "/tv/s/x/watch/episode/1": watchPage({ title: "The Show", subtitle: "S1 · E1", ownerKind: "episode", ownerId: "1", back: "/tv/s/x/title/1", next: "/tv/s/x/watch/episode/2" }),
  "/tv/s/x/watch/episode/2": watchPage({ title: "The Show", subtitle: "S1 · E2", ownerKind: "episode", ownerId: "2", back: "/tv/s/x/title/1", next: null }),
  "/tv/s/x/title/9": detailPage({ title: "Many actions", meta: "2020", overview: null, posterUrl: null, backHref: "/tv/s/x/library/a", actions: [{ href: "/tv/s/x/watch/title/1", label: "Play", primary: true }, { href: "/tv/s/x/title/1", label: "Add" }, { href: "/tv/s/x/title/2", label: "Third" }], posts: [{ action: "/tv/s/x/mark", label: "Fourth", fields: { kind: "title", id: "1" } }] }),
  "/tv/s/x/watch/title/1": watchPage({ title: "Movie 1", subtitle: null, ownerKind: "title", ownerId: "1", back: "/tv/s/x/title/1", next: null }),
};

const saves: { positionSeconds: number; finished: boolean }[] = [];
let manifestRequests = 0;
let failFirstManifestUrl = false;
const mediaHits: Record<string, number> = {};
let polls = 0;
let audioManifests = 0;
let failFirstAudioUrl = false;
let signouts = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  if (url.searchParams.get("json") === "1" && url.pathname.startsWith("/tv/s/x/watch/episode/")) {
    // the real server's lookup of the next episode's details; a short countdown keeps the check quick
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ownerKind: "episode", ownerId: "2", back: "/tv/s/x/title/1", next: null, title: "The Show", subtitle: "S1 · E2", upNextSeconds: 2 }));
  }
  if (url.pathname === "/tv/s/x/library/a" && url.searchParams.get("page") === "2") {
    return void res.writeHead(200, { "content-type": "text/html" }).end(listPage({ base: "/tv/s/x", title: "Movies", backHref: "/tv/s/x", items: [13, 14, 15, 16, 17, 18].map(poster), prevHref: null, nextHref: null }));
  }
  if (pages[url.pathname]) return void res.writeHead(200, { "content-type": "text/html" }).end(pages[url.pathname]);
  if (url.pathname === "/tv/tv.css") return void res.writeHead(200, { "content-type": "text/css" }).end(fs.readFileSync("public/tv/tv.css"));
  if (url.pathname === "/tv/tv.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync("public/tv/tv.js"));
  if (url.pathname === "/tv/signout" && req.method === "POST") {
    signouts++;
    return void res.writeHead(302, { location: "/tv/pair" }).end();
  }
  if (url.pathname === "/tv/pair/poll") {
    polls++;
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: polls < 3 ? "pending" : "approved" }));
  }
  if (url.pathname.startsWith("/api/play/")) {
    manifestRequests++;
    const bad = failFirstManifestUrl && manifestRequests === 1;
    const segments = [1, 2].map((i) => ({ index: i - 1, url: bad ? "/media/missing.webm" : `/media/part${i}.webm`, durationSeconds: 12, startSeconds: (i - 1) * 12 }));
    // the first movie's library starts at 1.5x, as an admin could have set it; everything else at normal speed
    const defaultRate = url.pathname.endsWith("/title/1") ? 1.5 : null;
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ownerKind: "title", ownerId: "1", durationSeconds: 24, segments, resumeSeconds: 0, expiresAt: "2099-01-01T00:00:00Z", defaultRate }));
  }
  const audioId = /^\/api\/audiobooks\/([^/]+)\/manifest$/.exec(url.pathname);
  if (audioId) {
    audioManifests++;
    const n = audioId[1] === "2" ? 2 : 1;
    const segments = [0, 1].map((i) => ({ index: i, startSeconds: i * 12, durationSeconds: 12 }));
    const bad = failFirstAudioUrl && audioManifests === 1;
    const urls = [0, 1].map((i) => ({ index: i, url: bad ? "/media/missing.ogg" : `/media/aud${i + 1}.ogg`, expiresAt: "2099-01-01T00:00:00Z" }));
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ titleId: String(n), durationSeconds: 24, segments, resumeSeconds: 0, urls, defaultRate: audioId[1] === "9" ? 1.25 : null }));
  }
  if (/^\/api\/audiobooks\/[^/]+\/segments\/\d+$/.test(url.pathname)) {
    const i = Number(url.pathname.split("/").pop());
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ index: i, url: `/media/aud${i + 1}.ogg`, expiresAt: "2099-01-01T00:00:00Z" }));
  }
  if (url.pathname === "/api/subtitles/search") {
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results: [{ fileId: 11, language: url.searchParams.get("languages"), release: "Release One", fileName: "a.srt", downloads: 5 }] }));
  }
  if (url.pathname === "/api/subtitles/download") {
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ cues: [[0, 1000, "Hello subtitle"]], remaining: 9 }));
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
    mediaHits[path.basename(url.pathname)] = (mediaHits[path.basename(url.pathname)] || 0) + 1;
    const file = path.join(MEDIA, path.basename(url.pathname));
    if (!fs.existsSync(file)) return void res.writeHead(404).end();
    const size = fs.statSync(file).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { "content-type": file.endsWith(".ogg") ? "audio/ogg" : file.endsWith(".png") ? "image/png" : "video/webm", "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
      return void fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "content-type": file.endsWith(".ogg") ? "audio/ogg" : file.endsWith(".png") ? "image/png" : "video/webm", "content-length": size, "accept-ranges": "bytes" });
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
const V = `document.getElementById("pv")`;
/** A page that has finished loading and had a moment to start its script (a real person cannot press a key faster than that). */
const settled = async (page: Page) => {
  await page.waitFor(`document.readyState === "complete" && document.getElementById("pimg") && document.getElementById("pimg").complete`, 8000);
  await new Promise((r) => setTimeout(r, 300));
};
const ready = (page: Page) => page.waitFor(`document.readyState === "complete"`);

async function run(label: string, exe: string, m56: boolean) {
  const { page, close } = await launch(exe, nextPort++);
  if (m56) await page.addInitScript(M56_PRELUDE);
  // A stand-in for the browser's screen wake lock (the real one is not in Chromium 69), counting what the page asks of it.
  // And for the media session (Chromium 73+): what the page tells the system is playing.
  await page.addInitScript(`window.MediaMetadata = function (init) { this.title = init.title; this.artist = init.artist; }; Object.defineProperty(navigator, "mediaSession", { configurable: true, value: { metadata: null, setActionHandler: function (name, fn) { (window.__msHandlers = window.__msHandlers || {})[name] = fn; } } });`);
  await page.addInitScript(`Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: function () { window.__wl = (window.__wl || 0) + 1; return Promise.resolve({ release: function () { window.__wlr = (window.__wlr || 0) + 1; return Promise.resolve(); } }); } } });`);
  const L = (s: string) => `${label}${m56 ? "+m56" : ""}: ${s}`;
  const base = "http://localhost:8799";

  // The pairing screen asks again every few seconds and moves on by itself once the code is approved.
  polls = 0;
  await page.goto(base + "/tv/pair");
  check(L("the pairing screen shows the code"), (await page.evaluate<string>(`document.querySelector(".code").textContent`)) === "ABCDE");
  check(L("the pairing screen moves on once approved"), await page.waitFor(`location.pathname === "/tv"`, 20000), `polls=${polls}`);

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

  // Remembering your place: open a title from the grid, come back, and the highlight is on that title again.
  await page.goto(base + "/tv/s/x/library/a?modern=0");
  await key(page, 39);
  await key(page, 39);
  const third = await focusedText(page);
  await key(page, 13);
  await page.waitFor(`location.pathname === "/tv/s/x/title/3"`);
  await page.goto(base + "/tv/s/x/library/a?modern=0");
  check(L("coming back to a list puts the highlight on the item that was opened"), (await focusedText(page)) === third && third.startsWith("Movie 3"), `${third} -> ${await focusedText(page)}`);

  // Endless lists: on a newer browser the next page is added as the highlight nears the end; on the basic path the More button stays.
  const cardCount = `document.querySelectorAll("[data-cards] .card").length`;
  await page.goto(base + "/tv/s/x/library/a?modern=0");
  await key(page, 40);
  await new Promise((r) => setTimeout(r, 600));
  check(L("on the basic path nothing is added by itself and More is shown"), (await page.evaluate<number>(cardCount)) === 12 && (await page.evaluate<boolean>(`!!document.querySelector("a[data-more]") && document.querySelector("a[data-more]").getBoundingClientRect().width > 0`)));
  await page.goto(base + "/tv/s/x/library/a?modern=1");
  check(L("on a newer browser the More button is hidden"), await page.evaluate<boolean>(`document.querySelector("a[data-more]").getBoundingClientRect().width === 0`));
  await key(page, 40);
  check(L("the next page is added as the highlight nears the end"), await page.waitFor(`document.querySelectorAll("[data-cards] .card").length === 18`, 8000));
  check(L("the end of the list removes the button"), await page.evaluate<boolean>(`!document.querySelector("a[data-more]")`));
  // Opening a card that came from the added page and coming back puts the extra page back and the highlight on that card.
  await key(page, 40); // down to the row where the added page's cards start
  for (let i = 0; i < 8 && !(await focusedText(page)).startsWith("Movie 15"); i++) await key(page, 39);
  check(L("the highlight can reach a card from the added page"), (await focusedText(page)).startsWith("Movie 15"), await focusedText(page));
  await key(page, 13);
  await page.waitFor(`location.pathname === "/tv/s/x/title/15"`);
  await page.goto(base + "/tv/s/x/library/a?modern=1");
  check(L("coming back to a long list restores its added pages and the highlight"), await page.waitFor(`document.querySelectorAll("[data-cards] .card").length === 18 && document.activeElement && document.activeElement.textContent.indexOf("Movie 15") === 0`, 8000), `${await page.evaluate<number>(cardCount)} ${await focusedText(page)}`);

  // A POST button (Sign out) works with the remote's OK key, and only then.
  await page.goto(base + "/tv/s/x");
  signouts = 0;
  // Sign out sits behind More on the home screen: reach More, open it, and move on to Sign out.
  const inButtonRow = async () => ["Search", "Switch profile"].includes(await focusedText(page));
  for (let i = 0; i < 10 && !(await inButtonRow()); i++) await key(page, 40);
  for (let i = 0; i < 4 && (await focusedText(page)) !== "More"; i++) await key(page, 39);
  await key(page, 13);
  check(L("the actions revealed by More are all on screen, not cut off at the bottom"), await page.evaluate<boolean>(`Array.prototype.every.call(document.querySelectorAll(".more-item [data-f]"), function (e) { var r = e.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight; })`), await page.evaluate<string>(`Array.prototype.map.call(document.querySelectorAll(".more-item [data-f]"), function (e) { var r = e.getBoundingClientRect(); return Math.round(r.top) + "-" + Math.round(r.bottom); }).join(" ") + " of " + window.innerHeight`));
  for (let i = 0; i < 4 && (await focusedText(page)) !== "Sign out"; i++) await key(page, 39); // the revealed actions follow More
  check(L("the Sign out button can be reached with the arrows"), (await focusedText(page)) === "Sign out", await focusedText(page));
  await key(page, 13);
  check(L("OK on Sign out sends a POST and follows its redirect"), (await page.waitFor(`location.pathname === "/tv/pair"`)) && signouts === 1, `signouts=${signouts}`);

  // Back keys of Tizen (10009) and webOS (461) follow the page's Back button.
  await page.goto(base + "/tv/s/x/library/a");
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


  // Search: the keyboard is reachable with the arrows, and the arrows cross from the keys to the results.
  await page.goto(base + "/tv/s/x/search");
  check(L("search starts on the first key when nothing was typed"), (await focusedText(page)) === "A", await focusedText(page));
  await key(page, 40);
  check(L("down moves along the keyboard rows"), (await focusedText(page)) !== "A", await focusedText(page));
  for (let i = 0; i < 12 && !(await focusedText(page)).startsWith("Movie"); i++) await key(page, 39);
  check(L("right crosses from the keys to the results"), (await focusedText(page)).startsWith("Movie"), await focusedText(page));

  // More: two actions show, the rest sit behind a More button that reveals them in place.
  await page.goto(base + "/tv/s/x/title/9");
  const shownButtons = `Array.prototype.filter.call(document.querySelectorAll(".detail .text [data-f]"), function (e) { return e.getBoundingClientRect().width > 0; }).map(function (e) { return e.textContent.trim(); }).join("|")`;
  check(L("only two actions and More are shown at first"), (await page.evaluate<string>(shownButtons)) === "Play|Add|More", await page.evaluate<string>(shownButtons));
  await key(page, 39);
  await key(page, 39);
  check(L("the arrows reach More"), (await focusedText(page)) === "More", await focusedText(page));
  await key(page, 13);
  check(L("OK on More shows the rest and moves onto the first of them"), (await page.evaluate<string>(shownButtons)) === "Play|Add|More|Third|Fourth" && (await focusedText(page)) === "Third", `${await page.evaluate<string>(shownButtons)} / ${await focusedText(page)}`);
  await key(page, 39);
  check(L("the arrows move through the revealed actions"), (await focusedText(page)) === "Fourth", await focusedText(page));
  await key(page, 37);
  await key(page, 37);
  check(L("and back to More"), (await focusedText(page)) === "More", await focusedText(page));
  await key(page, 13);
  check(L("OK on More again hides them"), (await page.evaluate<string>(shownButtons)) === "Play|Add|More", await page.evaluate<string>(shownButtons));

  // The harder case: the actions are at the very bottom of the screen when More is opened. The page scrolls so they are all in view.
  await page.goto(base + "/tv/s/x/title/9");
  await page.evaluate(`document.querySelector(".detail").style.marginTop = (window.innerHeight - 120) + "px"; window.scrollTo(0, 0);`);
  await key(page, 39);
  await key(page, 39);
  check(L("More can be reached with its row at the bottom of the screen"), (await focusedText(page)) === "More", await focusedText(page));
  await key(page, 13);
  const inView = `Array.prototype.every.call(document.querySelectorAll(".more-item [data-f]"), function (e) { var r = e.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight; })`;
  check(L("opening More at the bottom of the screen scrolls the revealed actions fully into view"), await page.evaluate<boolean>(inView), await page.evaluate<string>(`Array.prototype.map.call(document.querySelectorAll(".more-item [data-f]"), function (e) { var r = e.getBoundingClientRect(); return Math.round(r.top) + "-" + Math.round(r.bottom); }).join(" ") + " of " + window.innerHeight`));

  // A folder page: folders come first and take focus, and arrows reach the files below.
  await page.goto(base + "/tv/s/x/library/f");
  check(L("a folder page focuses the first folder"), (await focusedText(page)).startsWith("Trips"), await focusedText(page));
  await key(page, 39);
  check(L("right moves between folders"), (await focusedText(page)).startsWith("Pets"), await focusedText(page));
  await key(page, 40);
  check(L("down reaches the files under the folders"), (await focusedText(page)).startsWith("Movie"), await focusedText(page));

  // An album page lists songs; OK on a song opens the listening page.
  await page.goto(base + "/tv/s/x/album/1");
  check(L("an album focuses Play album"), (await focusedText(page)) === "Play album", await focusedText(page));
  await key(page, 40);
  check(L("down reaches the songs"), (await focusedText(page)).startsWith("1. Intro"), await focusedText(page));

  // Listening: plays part one, pause/resume, skip, rolls into part two, ends, saves as finished and goes to the next song.
  const A = `document.getElementById("pa")`;
  saves.length = 0;
  await page.goto(base + "/tv/s/x/listen/1");
  await page.waitFor(`${A} && ${A}.currentTime > 0.5 && !${A}.paused`, 15000);
  check(L("the audio plays part one"), (await page.evaluate<string>(`${A}.currentSrc.split("/").pop()`)) === "aud1.ogg");
  await key(page, 19);
  check(L("the Pause key pauses the audio"), await page.evaluate<boolean>(`${A}.paused`));
  await key(page, 13);
  await new Promise((r) => setTimeout(r, 400));
  check(L("OK resumes the audio"), !(await page.evaluate<boolean>(`${A}.paused`)));
  const aBefore = await page.evaluate<number>(`${A}.currentTime`);
  await key(page, 39);
  await new Promise((r) => setTimeout(r, 500));
  check(L("right skips the audio ahead about ten seconds"), (await page.evaluate<number>(`${A}.currentTime`)) - aBefore > 7);
  check(L("the clock shows the whole length"), (await page.evaluate<string>(`document.getElementById("clock").textContent`)).endsWith("/ 0:24"), await page.evaluate<string>(`document.getElementById("clock").textContent`));
  await key(page, 417);
  check(L("fast-forward moves the audio into part two"), await page.waitFor(`${A}.currentSrc.endsWith("aud2.ogg")`, 8000));
  await page.evaluate(`window.__sameDocument = 1`);
  check(L("finishing goes on to the next song"), await page.waitFor(`location.pathname === "/tv/s/x/listen/2"`, 25000), await page.url());
  check(L("on a newer browser the next song starts in the same page (no reload)"), (await page.evaluate<number>(`window.__sameDocument || 0`)) === 1);
  check(L("and the screen shows the new song"), (await page.evaluate<string>(`document.getElementById("ttl").textContent`)) === "Second");
  await page.waitFor(`document.getElementById("pa").currentTime > 0.2`, 15000);
  check(L("a song at the end of an album never saves anything"), saves.length === 0, JSON.stringify(saves));

  // A book (or audio file) does save: its end is stored as finished, then Back's page opens.
  saves.length = 0;
  await page.goto(base + "/tv/s/x/listen/9");
  await page.waitFor(`document.getElementById("pa").currentTime > 0.3 && !document.getElementById("pa").paused`, 15000);
  await key(page, 417);
  check(L("a finished book returns to its page"), await page.waitFor(`location.pathname === "/tv/s/x/album/1"`, 25000), await page.url());
  for (let i = 0; i < 30 && !saves.some((s) => s.finished); i++) await new Promise((r) => setTimeout(r, 100));
  check(L("a book or file's end is saved as finished"), saves.some((s) => s.finished), JSON.stringify(saves));
  await page.goto(base + "/tv/s/x/listen/2");

  // The music screen: next songs listed, Down and Up move between songs in the page, and the system is told what plays.
  check(L("the queue shows the songs coming up"), (await page.evaluate<string>(`document.getElementById("queuelist").textContent`)).indexOf("Song 2 of 2") >= 0, await page.evaluate<string>(`document.getElementById("queuelist").textContent`));
  check(L("the system is told which song plays"), (await page.evaluate<string>(`navigator.mediaSession.metadata && navigator.mediaSession.metadata.title`)) === "Second");
  await page.waitFor(`document.getElementById("pa").currentTime > 0.2`, 15000);
  await page.evaluate(`window.__sameDocument = 1`);
  await key(page, 38);
  check(L("Up goes to the previous song in the same page"), await page.waitFor(`location.pathname === "/tv/s/x/listen/1" && document.getElementById("ttl").textContent === "Intro" && window.__sameDocument === 1`, 8000), await page.url());
  check(L("and the system hears about it"), (await page.evaluate<string>(`navigator.mediaSession.metadata.title`)) === "Intro");
  check(L("and the big cover follows the song"), await page.evaluate<boolean>(`document.getElementById("coverimg").getAttribute("src") === "/media/pic1.png"`));
  check(L("and the queue moves with it"), (await page.evaluate<string>(`document.getElementById("queuelist").textContent`)).indexOf("Next: Second") >= 0);
  await page.waitFor(`document.getElementById("pa").currentTime > 0.2`, 15000);
  await key(page, 40);
  check(L("Down goes to the next song in the same page"), await page.waitFor(`location.pathname === "/tv/s/x/listen/2" && document.getElementById("ttl").textContent === "Second" && window.__sameDocument === 1`, 8000), await page.url());
  check(L("and the cover changes with it"), await page.evaluate<boolean>(`document.getElementById("coverimg").getAttribute("src") === "/media/pic2.png"`));
  await page.waitFor(`document.getElementById("pa").currentTime > 0.2`, 15000);
  await key(page, 40);
  check(L("Down on the last song stays put"), (await page.url()).endsWith("/tv/s/x/listen/2"));
  check(L("the system's next-track button is off on the last song"), await page.evaluate<boolean>(`window.__msHandlers.nexttrack === null`));

  // A song never saves a place, and Back leaves for the album.
  saves.length = 0;
  await page.waitFor(`${A} && ${A}.currentTime > 0.3`, 15000);
  await key(page, 19);
  await new Promise((r) => setTimeout(r, 400));
  check(L("a song never saves a place"), saves.length === 0, JSON.stringify(saves));
  await key(page, 10009);
  check(L("Back leaves a song for its album"), await page.waitFor(`location.pathname === "/tv/s/x/album/1"`));

  // The basic path: with ?modern=0 a song's end loads the next song's page, and the wide picture is never downloaded.
  await page.goto(base + "/tv/s/x/title/1");
  check(L("a newer browser gets the backdrop picture and the modern class"), await page.waitFor(`document.documentElement.className.indexOf("modern") >= 0 && document.querySelector(".backdrop img").getAttribute("src") === "/media/pic2.png"`, 5000));
  await page.goto(base + "/tv/s/x/title/1?modern=0");
  check(L("?modern=0 gives the basic page: no modern class and the backdrop is never fetched"), await page.evaluate<boolean>(`document.documentElement.className.indexOf("modern") < 0 && !document.querySelector(".backdrop img").getAttribute("src")`));
  await page.goto(base + "/tv/s/x/listen/1");
  await page.waitFor(`document.getElementById("pa").currentTime > 0.3 && !document.getElementById("pa").paused`, 15000);
  await page.evaluate(`window.__sameDocument = 1`);
  await key(page, 417);
  check(L("on the basic path the next song is a new page"), await page.waitFor(`location.pathname === "/tv/s/x/listen/2" && !window.__sameDocument`, 25000), await page.url());
  await page.goto(base + "/tv/s/x/title/1?modern=1");
  check(L("?modern=1 turns the extras back on"), await page.waitFor(`document.documentElement.className.indexOf("modern") >= 0`, 5000));

  // A bad audio link is replaced by asking again.
  audioManifests = 0;
  failFirstAudioUrl = true;
  await page.goto(base + "/tv/s/x/listen/1");
  await page.waitFor(`${A} && ${A}.currentTime > 0.3 && !${A}.paused`, 15000);
  check(L("a failed audio link is replaced by a fresh one"), audioManifests >= 2, `requests=${audioManifests}`);
  failFirstAudioUrl = false;

  // Two quick seeks across parts: the second one wins and the audio starts where it said, not where the first said.
  await page.goto(base + "/tv/s/x/listen/1");
  await page.waitFor(`${A} && ${A}.currentTime > 0.3 && !${A}.paused`, 15000);
  await key(page, 417); // fast-forward: into part two
  await key(page, 412); // rewind straight away: back to the very start of part one
  await new Promise((r) => setTimeout(r, 1500));
  const raced = await page.evaluate<{ src: string; t: number }>(`({ src: ${A}.currentSrc.split("/").pop(), t: ${A}.currentTime })`);
  check(L("a quick second seek is not overridden by the first"), raced.src === "aud1.ogg" && raced.t < 4, JSON.stringify(raced));

  // Music keeps the screen awake while it plays, and lets go when paused.
  await page.goto(base + "/tv/s/x/listen/9");
  await page.waitFor(`document.getElementById("pa").currentTime > 0.3 && !document.getElementById("pa").paused`, 15000);
  check(L("playing audio asks the browser to keep the screen awake"), await page.waitFor(`window.__wl >= 1`, 3000));
  await key(page, 19);
  check(L("pausing lets the screen sleep again"), await page.waitFor(`window.__wlr >= 1`, 3000));

  // The next picture is fetched ahead on a newer browser only; the home screen starts the screensaver after a quiet spell.
  mediaHits["pic2.png"] = 0;
  await page.goto(base + "/tv/s/x/photo/1?modern=0");
  await new Promise((r) => setTimeout(r, 800));
  check(L("the basic path does not fetch the next picture early"), (mediaHits["pic2.png"] || 0) === 0, String(mediaHits["pic2.png"]));
  await page.goto(base + "/tv/s/x/photo/1?modern=1");
  check(L("a newer browser fetches the next picture while this one is shown"), (await new Promise<boolean>((r) => { const t = Date.now(); const poll = () => ((mediaHits["pic2.png"] || 0) >= 1 ? r(true) : Date.now() - t > 4000 ? r(false) : setTimeout(poll, 100)); poll(); })));
  await page.goto(base + "/tv/s/y?modern=0");
  await new Promise((r) => setTimeout(r, 3500));
  check(L("the basic path never starts the screensaver"), (await page.url()).endsWith("/tv/s/y?modern=0"), await page.url());
  await page.goto(base + "/tv/s/y?modern=1");
  check(L("after a quiet spell a newer browser starts the screensaver"), await page.waitFor(`location.pathname === "/tv/s/x/photo/1"`, 8000), await page.url());
  await page.goto(base + "/tv/s/y");
  await new Promise((r) => setTimeout(r, 1200));
  await key(page, 40);
  await new Promise((r) => setTimeout(r, 1200));
  check(L("a key press restarts the wait"), (await page.url()).endsWith("/tv/s/y"), await page.url());

  // A pointer remote counts as activity too.
  await page.goto(base + "/tv/s/y");
  await new Promise((r) => setTimeout(r, 1300));
  await page.evaluate(`document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 1300));
  check(L("moving the pointer restarts the screensaver wait"), (await page.url()).endsWith("/tv/s/y"), await page.url());

  // Pictures: right and left go to the neighbours, a slideshow advances by itself, and a picture that fails says so.
  await page.goto(base + "/tv/s/x/photo/2");
  await page.waitFor(`document.getElementById("pimg").complete`, 8000);
  check(L("a picture is shown"), await page.evaluate<boolean>(`document.getElementById("pimg").naturalWidth > 0`));
  await key(page, 37);
  check(L("left goes to the previous picture"), await page.waitFor(`location.pathname === "/tv/s/x/photo/1"`));
  await settled(page);
  await key(page, 37);
  check(L("left on the first picture stays put"), (await page.url()).endsWith("/tv/s/x/photo/1"));
  await key(page, 39);
  check(L("right goes to the next picture"), await page.waitFor(`location.pathname === "/tv/s/x/photo/2"`));
  await settled(page);
  await key(page, 13);
  check(L("a slideshow asks the browser to keep the screen awake"), await page.waitFor(`window.__wl >= 1`, 3000));
  check(L("OK starts a slideshow"), await page.evaluate<boolean>(`document.getElementById("status").textContent === "Slideshow"`));
  check(L("the slideshow moves on by itself and keeps going"), await page.waitFor(`location.pathname === "/tv/s/x/photo/3" && location.hash === "#slide"`, 15000), await page.url());
  check(L("a picture that fails to load says so"), await page.waitFor(`document.getElementById("status").textContent.indexOf("can't be shown") >= 0`, 8000));
  await key(page, 27);
  check(L("Back leaves the picture viewer for the grid"), await page.waitFor(`location.pathname === "/tv/s/x/library/p"`));

  // Playback speed: starts at the library's default, the remote changes it (steps of 0.25 up and down, 0.05 left and right, never past 0.25 to 3).
  const speedShown = `document.getElementById("speedbox").style.display === "block"`;
  const rateNow = `${V}.playbackRate`;
  await page.goto(base + "/tv/s/x/watch/title/1");
  await page.waitFor(`${V} && ${V}.currentTime > 0.3 && !${V}.paused`, 15000);
  check(L("the video starts at the library's default speed"), (await page.evaluate<number>(rateNow)) === 1.5, String(await page.evaluate<number>(rateNow)));
  check(L("and the clock says so"), (await page.evaluate<string>(`document.getElementById("clock").textContent`)).indexOf("1.5x") >= 0, await page.evaluate<string>(`document.getElementById("clock").textContent`));
  await key(page, 38);
  check(L("Up opens the speed overlay"), await page.evaluate<boolean>(speedShown) && (await page.evaluate<string>(`document.getElementById("speedbox").textContent`)).indexOf("1.5x") >= 0);
  await key(page, 38);
  check(L("Up in the overlay goes up a step (1.75x)"), (await page.evaluate<number>(rateNow)) === 1.75, String(await page.evaluate<number>(rateNow)));
  await key(page, 39);
  check(L("Right fine-tunes by 0.05 (1.8x)"), (await page.evaluate<number>(rateNow)) === 1.8, String(await page.evaluate<number>(rateNow)));
  await key(page, 40);
  check(L("Down snaps to the step below (1.75x)"), (await page.evaluate<number>(rateNow)) === 1.75, String(await page.evaluate<number>(rateNow)));
  await key(page, 39);
  await key(page, 38);
  check(L("Up from 1.8x snaps to the step above (2x)"), (await page.evaluate<number>(rateNow)) === 2, String(await page.evaluate<number>(rateNow)));
  for (let i = 0; i < 8; i++) await key(page, 38);
  check(L("it stops at 3x"), (await page.evaluate<number>(rateNow)) === 3, String(await page.evaluate<number>(rateNow)));
  for (let i = 0; i < 14; i++) await key(page, 40);
  check(L("and at 0.25x"), (await page.evaluate<number>(rateNow)) === 0.25, String(await page.evaluate<number>(rateNow)));
  for (let i = 0; i < 3; i++) await key(page, 38); // 0.25 -> 0.5 -> 0.75 -> 1
  await key(page, 27);
  check(L("Back closes the overlay but stays on the video"), !(await page.evaluate<boolean>(speedShown)) && (await page.url()).indexOf("/watch/title/1") > 0, await page.url());
  check(L("the chosen speed is on the video and the clock"), (await page.evaluate<number>(rateNow)) === 1 && (await page.evaluate<string>(`document.getElementById("clock").textContent`)).indexOf("x") < 0, await page.evaluate<string>(`document.getElementById("clock").textContent`));
  await key(page, 37);
  await new Promise((r) => setTimeout(r, 300));
  check(L("with the overlay closed, Left seeks again"), !(await page.evaluate<boolean>(speedShown)));

  // Subtitles (this viewing only): Down opens a picker; "Find subtitles" searches, OK on a result downloads it and draws its words;
  // nothing is remembered for the next video.
  await page.goto(base + "/tv/s/x/watch/title/1");
  await page.waitFor(`${V} && ${V}.currentTime > 0.3 && !${V}.paused`, 15000);
  const subsText = `document.getElementById("subs").textContent`;
  const pickerText = `document.getElementById("subpicker").textContent`;
  const pickerShown = `document.getElementById("subpicker").style.display === "block"`;
  check(L("the hint says Down opens subtitles"), (await page.evaluate<string>(`document.getElementById("vhint").textContent`)).indexOf("Down: subtitles") >= 0);
  check(L("no subtitles are drawn until one is loaded"), (await page.evaluate<string>(subsText)) === "");
  await key(page, 40);
  check(L("Down opens the subtitle picker with Off and Find subtitles"), (await page.evaluate<boolean>(pickerShown)) && /Off[\s\S]*Find subtitles: en/.test(await page.evaluate<string>(pickerText)), await page.evaluate<string>(pickerText));
  await key(page, 40);
  await key(page, 39);
  check(L("Left and Right on Find change the search language"), (await page.evaluate<string>(pickerText)).indexOf("Find subtitles: es") >= 0, await page.evaluate<string>(pickerText));
  await key(page, 13);
  check(L("OK on Find lists what OpenSubtitles has"), await page.waitFor(`document.getElementById("subpicker").textContent.indexOf("Release One") >= 0`, 5000), await page.evaluate<string>(pickerText));
  await key(page, 27);
  check(L("Back from the results returns to the picker, not the video's page"), (await page.evaluate<string>(pickerText)).indexOf("Find subtitles") >= 0 && (await page.url()).indexOf("/watch/title/1") > 0);
  await key(page, 13);
  await page.waitFor(`document.getElementById("subpicker").textContent.indexOf("Release One") >= 0`, 5000);
  await key(page, 13);
  check(L("choosing a result closes the picker and draws its words"), await page.waitFor(`document.getElementById("subs").textContent.indexOf("Hello subtitle") >= 0 && !(${pickerShown})`, 5000), await page.evaluate<string>(subsText));
  await key(page, 40);
  await key(page, 40);
  await key(page, 38);
  await key(page, 38);
  await key(page, 13);
  check(L("choosing Off clears the words at once"), await page.waitFor(`document.getElementById("subs").textContent === ""`, 5000), await page.evaluate<string>(subsText));
  await page.goto(base + "/tv/s/x/watch/title/1");
  await page.waitFor(`${V} && ${V}.currentTime > 0.3`, 15000);
  await key(page, 40);
  check(L("nothing is remembered: the next load has only Off and Find"), !/Release One|EN /.test(await page.evaluate<string>(pickerText)) && (await page.evaluate<string>(subsText)) === "");
  await key(page, 27);

  // A speed chosen on one episode carries to the next in the same page; an audiobook starts at its library's speed and has the same overlay; a song queue keeps Up for songs.
  await page.goto(base + "/tv/s/x/watch/episode/1?modern=1");
  await page.waitFor(`${V} && ${V}.currentTime > 0.3 && !${V}.paused`, 15000);
  for (let i = 0; i < 5; i++) await key(page, 38); // open, then 1 -> 1.25 -> 1.5 -> 1.75 -> 2
  await key(page, 13);
  check(L("a speed chosen on an episode is on the video"), (await page.evaluate<number>(rateNow)) === 2, String(await page.evaluate<number>(rateNow)));
  await key(page, 417);
  await page.waitFor(`location.pathname === "/tv/s/x/watch/episode/2" && ${V}.currentTime > 0.3`, 25000);
  check(L("and carries over to the next episode"), (await page.evaluate<number>(rateNow)) === 2, String(await page.evaluate<number>(rateNow)));

  await page.goto(base + "/tv/s/x/listen/9");
  await page.waitFor(`document.getElementById("pa").currentTime > 0.3 && !document.getElementById("pa").paused`, 15000);
  check(L("an audiobook starts at its library's speed"), (await page.evaluate<number>(`document.getElementById("pa").playbackRate`)) === 1.25);
  await key(page, 38);
  await key(page, 38);
  check(L("Up opens the same overlay for audio and steps it"), (await page.evaluate<boolean>(speedShown)) && (await page.evaluate<number>(`document.getElementById("pa").playbackRate`)) === 1.5);
  await key(page, 13);
  await page.goto(base + "/tv/s/x/listen/1");
  await page.waitFor(`document.getElementById("pa").currentTime > 0.3`, 15000);
  check(L("a song queue keeps Up for songs: no speed overlay and no speed hint"), !(await page.evaluate<boolean>(speedShown)) && (await page.evaluate<boolean>(`!document.getElementById("speedhint")`)));

  // Up next: a newer browser counts down and starts the next episode in the same page; Back stops it; the basic path loads the next page.
  const skipToEnd = async () => {
    await page.waitFor(`${V} && ${V}.currentTime > 0.3 && !${V}.paused`, 15000);
    await key(page, 417);
  };
  saves.length = 0;
  await page.goto(base + "/tv/s/x/watch/episode/1?modern=1");
  await page.evaluate(`window.__sameDocument = 1`);
  await skipToEnd();
  check(L("an episode's end shows the Up next countdown"), await page.waitFor(`document.getElementById("upnext").style.display === "block" && document.getElementById("upnext").textContent.indexOf("Up next in") >= 0`, 15000), await page.url());
  check(L("and the episode just watched is saved as finished"), saves.some((x) => x.finished), JSON.stringify(saves));
  check(L("the next episode starts by itself in the same page"), await page.waitFor(`location.pathname === "/tv/s/x/watch/episode/2" && ${V}.currentTime > 0.3 && !${V}.paused`, 15000), await page.url());
  check(L("with no reload, and the new episode's name on screen"), await page.evaluate<boolean>(`window.__sameDocument === 1 && document.getElementById("wsub").textContent.indexOf("E2") >= 0 && document.getElementById("upnext").style.display === "none"`));
  await skipToEnd();
  check(L("after the last episode the player goes back (no countdown)"), await page.waitFor(`location.pathname === "/tv/s/x/title/1"`, 20000), await page.url());

  await page.goto(base + "/tv/s/x/watch/episode/1");
  await skipToEnd();
  await page.waitFor(`document.getElementById("upnext").style.display === "block"`, 15000);
  await key(page, 27);
  check(L("Back during the countdown stops and goes back"), await page.waitFor(`location.pathname === "/tv/s/x/title/1"`, 5000), await page.url());

  await page.goto(base + "/tv/s/x/watch/episode/1");
  await page.waitFor(`document.getElementById("upnext")`, 5000);
  await page.waitFor(`${V}.currentTime > 0.3`, 15000);
  await key(page, 417);
  await page.waitFor(`document.getElementById("upnext").style.display === "block"`, 15000);
  await key(page, 13);
  check(L("OK during the countdown starts the next episode at once"), await page.waitFor(`location.pathname === "/tv/s/x/watch/episode/2"`, 5000), await page.url());

  await page.goto(base + "/tv/s/x/watch/episode/1?modern=0");
  await page.evaluate(`window.__sameDocument = 1`);
  await skipToEnd();
  check(L("on the basic path the next episode is a new page"), await page.waitFor(`location.pathname === "/tv/s/x/watch/episode/2" && !window.__sameDocument`, 20000), await page.url());
  await page.goto(base + "/tv/s/x/title/1?modern=1");

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
