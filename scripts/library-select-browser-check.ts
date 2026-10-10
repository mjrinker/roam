/**
 * Selecting several titles on a library page in a real Chromium: choose, shift-select a range, select all (also ones scrolled out of view
 * or filtered), then the bulk actions - add to a playlist and download - against a pretend server.
 *
 *   SELECT_BROWSER=/path/to/chrome npx tsx scripts/library-select-browser-check.ts
 */
import fs from "node:fs";
import http from "node:http";
import { build } from "esbuild";
import { launch } from "./lib-cdp";

const exe = process.env.SELECT_BROWSER;
if (!exe) throw new Error("Set SELECT_BROWSER=/path/to/a recent chrome");
const dir = fs.mkdtempSync("/tmp/select-check-");
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
  if (!ok) failures++;
};

const ids = Array.from({ length: 120 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
const items = ids.map((id, i) => ({ id, kind: "movie", name: `Film ${String(i).padStart(3, "0")}`, year: 2000 + (i % 20), posterUrl: null, genres: [], certification: null, ratingAge: null, runtimeSeconds: 6000, addedAt: "2024-01-01T00:00:00Z" }));

const folderPage = [0, 1, 2].map((i) => ({ id: ids[i], kind: "movie", name: `Clip ${i}`, year: null, posterUrl: null, runtimeSeconds: null, authors: null, width: null, height: null, favorite: false, watched: false }));
const folderAll = ids.slice(0, 10);
const albumCards = [0, 1, 2].map((i) => ({ id: ids[i], name: `Album ${i}`, artistId: "A", artistName: "Band", year: 2000, coverUrl: null, trackCount: 2 }));
const albumAll = ids.slice(0, 7);
const songsFor = (albumIds: string[]) => albumIds.flatMap((a) => [`${a}-s1`, `${a}-s2`]);

const requests: { url: string; body: unknown }[] = [];
const app = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const send = (type: string, body: string | Buffer, status = 200) => void res.writeHead(status, { "Content-Type": type }).end(body);
  if (url.pathname === "/bundle.js") return send("text/javascript", fs.readFileSync(`${dir}/bundle.js`));
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    if (req.method !== "GET") requests.push({ url: url.pathname, body });
    if (url.pathname === "/api/libraries/L1/folder-ids") return send("application/json", JSON.stringify({ ids: folderAll, truncated: false }));
    if (url.pathname === "/api/libraries/L1/music-ids") return send("application/json", JSON.stringify({ ids: albumAll, truncated: false }));
    if (url.pathname === "/api/libraries/L1/music-songs") return send("application/json", JSON.stringify({ ids: songsFor(body.albumIds), truncated: false }));
    if (url.pathname === "/api/servers/S1/playlists/editable") return send("application/json", JSON.stringify({ playlists: [{ id: "P1", name: "Weekend" }] }));
    if (url.pathname === "/api/playlists/P1/items") return send("application/json", JSON.stringify({ added: body.titleIds.length, alreadyThere: 0, unavailable: 0 }), 201);
    if (url.pathname === "/api/download/bulk") {
      const chosen = body.titleIds as string[];
      return send("application/json", JSON.stringify({
        items: chosen.map((id: string) => ({ kind: "watch", ownerKind: "title", ownerId: id, title: id.slice(-3), subtitle: null, posterUrl: null, options: [{ label: "1080p", name: "1080p", height: 1080, sizeBytes: 2_000_000_000, parts: 1 }, { label: "720p", name: "720p", height: 720, sizeBytes: 1_000_000_000, parts: 1 }] })),
        skipped: 2, truncated: false,
      }));
    }
    send("text/html", '<!doctype html><html class="dark"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
});

async function main() {
  await build({
    stdin: {
      contents: `import { createRoot } from "react-dom/client"; import { LibraryBrowser } from "@/components/library/library-browser"; import { SelectableFolderItems, SelectableMusicTiles } from "@/components/library/selectable-views"; import { VideoFolderView } from "@/components/library/video-folder-view"; import { AudioGroupGrid, SongViewTabs, SongsView } from "@/components/library/audio-views"; import { AudioPlayerProvider } from "@/components/audio/audio-player-provider"; import { parseFolderSort } from "@/lib/libraries/folder-browse"; import { Toaster } from "@/components/ui/sonner";
        const items = ${JSON.stringify(items)};
        const mode = new URLSearchParams(location.search).get("mode");
        createRoot(document.getElementById("root")!).render(<>
          {mode === "tabs-music" ? <SongViewTabs serverId="S1" libraryId="L1" kind="music" active="songs" /> : mode === "tabs-audio" ? <SongViewTabs serverId="S1" libraryId="L1" kind="audio" active="songs" /> : mode === "groups" ? <AudioGroupGrid serverId="S1" libraryId="L1" kind="genre" groups={[{ name: "Rock", label: "Rock", count: 3, coverUrl: null }, { name: "__unknown__", label: "Unknown genre", count: 1, coverUrl: null }] as any} nextHref="/more" /> : mode === "songs" ? <AudioPlayerProvider><SongsView serverId="S1" libraryId="L1" extra="view=genres&group=Rock" group={{ kind: "genre", name: "Rock", label: "Rock" }} items={${JSON.stringify(folderPage)} as any} sort={parseFolderSort(null, null)} search={null} nextHref="/next" /></AudioPlayerProvider> : mode === "audio" ? <VideoFolderView serverId="S1" libraryId="L1" libraryName="Audio" path="Mix" folders={[]} items={${JSON.stringify(folderPage)} as any} nextHref={null} itemKind="audiobook" sortable search={new URLSearchParams(location.search).get("q")} sort={parseFolderSort(new URLSearchParams(location.search).get("sort"), new URLSearchParams(location.search).get("dir"))} /> : mode === "folder" ? <SelectableFolderItems serverId="S1" libraryId="L1" path="Trips" items={${JSON.stringify(folderPage)} as any} itemKind="movie" sort={parseFolderSort(null, null)} /> : mode === "music" ? <SelectableMusicTiles serverId="S1" libraryId="L1" view="albums" albums={${JSON.stringify(albumCards)} as any} artists={null} /> : <LibraryBrowser items={items as any} serverId="S1" />}
          <Toaster /></>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": "./src", "next/link": "./scripts/stubs/next-link.tsx", "next/image": "./scripts/stubs/next-image.tsx", "next/navigation": "./scripts/stubs/next-navigation.tsx" },
    define: { "process.env.NODE_ENV": '"development"' },
    outfile: `${dir}/bundle.js`,
    logLevel: "error",
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const browser = await launch(exe!, 9337);
  const page = browser.page;
  const click = (label: string) => page.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const count = () => page.evaluate<number>(`document.querySelectorAll('[role="checkbox"][aria-checked="true"]').length`);
  try {
    await page.goto(`${base}/`);
    check("the library shows", await page.waitFor(`document.body.innerText.includes("Film 000")`, 5000));
    check("cards open a title until Select is on (no checkboxes yet)", (await page.evaluate<number>(`document.querySelectorAll('[role="checkbox"]').length`)) === 0);
    await page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Select").click()`);
    check("Select shows a checkbox on every card and a bar with no actions enabled", (await page.evaluate<number>(`document.querySelectorAll('[role="checkbox"]').length`)) === 120 && (await page.evaluate<boolean>(`[...document.querySelectorAll('[role="toolbar"] button')].filter(b => ["Add to playlist","Download"].includes(b.textContent.trim())).every(b => b.disabled)`)));
    await click("Select Film 001");
    await click("Select Film 003");
    check("clicking selects (and doesn't open) the titles", (await count()) === 2 && (await page.evaluate<string>(`document.querySelector('[role="toolbar"]').innerText`)).includes("2 selected"));
    await page.evaluate(`document.querySelector('[aria-label="Select Film 008"]').dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }))`);
    check("Shift-click selects the range from the last one clicked", (await count()) === 2 + 5 /* 004..008 */, await count());
    await page.evaluate(`[...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.trim().startsWith("Select all")).click()`);
    check("Select all takes every title, including ones out of view", (await count()) === 120 && (await page.evaluate<string>(`document.querySelector('[role="toolbar"]').innerText`)).includes("120 selected"));
    await page.evaluate(`[...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.trim() === "Clear").click()`);
    check("Clear empties the selection", (await count()) === 0);

    // Filtering by the search box: Select all means the ones shown.
    await page.evaluate(`(() => { const i = document.querySelector('input[aria-label="Filter this library"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "Film 01"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await page.waitFor(`document.querySelectorAll('[role="checkbox"]').length === 10`, 3000);
    await page.evaluate(`[...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.trim().startsWith("Select all")).click()`);
    check("with a filter, Select all takes the ones that match (10)", (await count()) === 10, await count());

    // Add to the playlist: one request with the ids, in library order.
    await page.evaluate(`[...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.trim() === "Add to playlist").click()`);
    check("the playlist menu lists the playlists that can be edited", await page.waitFor(`document.body.innerText.includes("Weekend")`, 3000));
    requests.length = 0;
    await page.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.includes("Weekend")).click()`);
    await page.waitFor(`document.body.innerText.includes('Added 10 to "Weekend"')`, 3000);
    const added = requests.find((r) => r.url === "/api/playlists/P1/items")?.body as { titleIds: string[] } | undefined;
    check("choosing a playlist adds the ten, in order, in one request", JSON.stringify(added?.titleIds) === JSON.stringify(ids.slice(10, 20)), added);

    // Download: the dialog sums the chosen resolution.
    requests.length = 0;
    await page.evaluate(`[...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.trim() === "Download").click()`);
    check("the download dialog shows the count and total for the best resolution", await page.waitFor(`document.body.innerText.includes("10 items") && document.body.innerText.includes("20.0 GB")`, 4000), await page.evaluate<string>("document.body.innerText.slice(-400)"));
    check("it says how many can't be downloaded", await page.evaluate<boolean>(`document.body.innerText.includes("2 selected items can't be downloaded")`));
    await page.evaluate(`(() => { const s = document.querySelector("select"); s.value = "720"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    check("choosing 720p updates the total (10 GB)", await page.waitFor(`document.body.innerText.includes("10.0 GB")`, 2000));
    check("the request carried the selected ids in library order", JSON.stringify((requests.find((r) => r.url === "/api/download/bulk")?.body as { titleIds: string[] })?.titleIds) === JSON.stringify(ids.slice(10, 20)));
    // A video or audio library's folder: Select all takes every page of the folder, not only the three shown.
    await page.goto(`${base}/?mode=folder`);
    await page.waitFor(`document.body.innerText.includes("Clip 0")`, 5000);
    await page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Select").click()`);
    await click("Select Clip 1");
    check("in a folder, a click selects one of the files shown", (await count()) === 1);
    await page.evaluate(`[...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.trim() === "Select all in this folder").click()`);
    check("Select all in this folder takes the whole folder (10), not just the 3 shown", await page.waitFor(`document.querySelector('[role="toolbar"]').innerText.includes("10 selected")`, 3000), await page.evaluate<string>(`document.querySelector('[role="toolbar"]').innerText`));
    await page.evaluate(`[...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.trim() === "Add to playlist").click()`);
    await page.waitFor(`document.body.innerText.includes("Weekend")`, 3000);
    requests.length = 0;
    await page.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.includes("Weekend")).click()`);
    await page.waitFor(`document.body.innerText.includes('Added 10 to "Weekend"')`, 3000);
    check("the playlist gets all ten, in folder order", JSON.stringify((requests.find((r) => r.url === "/api/playlists/P1/items")?.body as { titleIds: string[] })?.titleIds) === JSON.stringify(folderAll), requests);

    // A generic Audio library's folder: a search box and a sort menu like the Movies page's.
    await page.goto(`${base}/?mode=audio`);
    check("the audio folder has a search box and a Sort menu", await page.waitFor(`!!document.querySelector('input[aria-label="Search this library"]') && !!document.querySelector('button[aria-label="Sort"]')`, 5000));
    check("the sort menu shows the current sort (Name, A to Z)", (await page.evaluate<string>(`document.querySelector('button[aria-label="Sort"]').innerText`)).includes("Name"));
    const navs = () => page.evaluate<string[]>(`window.__nav || []`);
    await page.evaluate(`document.querySelector('button[aria-label="Sort"]').click()`);
    await page.waitFor(`document.querySelectorAll('[role="menuitem"]').length === 3`, 3000);
    check("the menu lists Name, Duration and Artist", (await page.evaluate<string>(`[...document.querySelectorAll('[role="menuitem"]')].map(i => i.textContent.trim()).join()`)) === "Name,Duration,Artist");
    await page.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(i => i.textContent.includes("Duration")).click()`);
    check("choosing Duration opens the page sorted longest first", (await navs()).pop() === "/s/S1/library/L1?sort=duration&dir=desc&path=Mix", await navs());
    await page.evaluate(`window.__nav = []; const i = document.querySelector('input[aria-label="Search this library"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "m83"); i.dispatchEvent(new Event("input", { bubbles: true }));`);
    check("typing in the search box opens the results after a short pause", await page.waitFor(`(window.__nav || []).includes("/s/S1/library/L1?q=m83&path=Mix")`, 2000), await navs());
    await page.goto(`${base}/?mode=audio&sort=duration&dir=desc&q=m83`);
    await page.waitFor(`!!document.querySelector('input[aria-label="Search this library"]')`, 5000);
    check("with a search, the results line shows and the folder trail goes", await page.evaluate<boolean>(`document.body.innerText.includes("Results for") && !document.querySelector('nav[aria-label="Folder"]')`));
    check("the box keeps the search, and the sort menu keeps the sort", (await page.evaluate<string>(`document.querySelector('input[aria-label="Search this library"]').value`)) === "m83" && (await page.evaluate<string>(`document.querySelector('button[aria-label="Sort"]').innerText`)).includes("Duration"));
    await page.evaluate(`window.__nav = []; document.querySelector('button[aria-label="Clear search"]').click()`);
    check("clearing the search goes back to the folder, keeping the sort", (await navs()).pop() === "/s/S1/library/L1?sort=duration&dir=desc&path=Mix", await navs());
    requests.length = 0;
    await page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Select").click()`);
    const seenUrls: string[] = [];
    app.on("request", (r) => seenUrls.push(r.url!));
    await page.evaluate(`[...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.trim() === "Select all results").click()`);
    await page.waitFor(`document.querySelector('[role="toolbar"]').innerText.includes("10 selected")`, 3000);
    check("Select all results asks for the same search in the same order", seenUrls.some((u) => u.startsWith("/api/libraries/L1/folder-ids") && u.includes("sort=duration&dir=desc") && u.includes("q=m83")), seenUrls);

    // The views of a song library: music's, then generic audio's (Tracks first, Folders last).
    const tabs = () => page.evaluate<string>(`[...document.querySelectorAll('nav[aria-label="Views"] a')].map(a => a.textContent.trim() + (a.getAttribute("aria-current") ? "*" : "") + ">" + a.getAttribute("href")).join(" | ")`);
    await page.goto(`${base}/?mode=tabs-music`);
    await page.waitFor(`!!document.querySelector('nav[aria-label="Views"]')`, 5000);
    check("music has Artists, Albums, Songs and Genres (no Folders)", (await tabs()) === "Artists>/s/S1/library/L1 | Albums>/s/S1/library/L1?view=albums | Songs*>/s/S1/library/L1?view=songs | Genres>/s/S1/library/L1?view=genres", await tabs());
    await page.goto(`${base}/?mode=tabs-audio`);
    await page.waitFor(`!!document.querySelector('nav[aria-label="Views"]')`, 5000);
    check("generic audio has Tracks, Artists, Albums, Genres, then Folders", (await tabs()) === "Tracks*>/s/S1/library/L1 | Artists>/s/S1/library/L1?view=artists | Albums>/s/S1/library/L1?view=albums | Genres>/s/S1/library/L1?view=genres | Folders>/s/S1/library/L1?view=folders", await tabs());
    await page.goto(`${base}/?mode=groups`);
    await page.waitFor(`document.body.innerText.includes("Rock")`, 5000);
    check("a genre tile opens that genre; the unknown group has its own link; Show more is there", (await page.evaluate<string>(`[...document.querySelectorAll("a")].map(a => a.getAttribute("href")).join(" ")`)).includes("view=genres&group=Rock") && (await page.evaluate<string>(`[...document.querySelectorAll("a")].map(a => a.getAttribute("href")).join(" ")`)).includes("group=__unknown__") && (await page.evaluate<boolean>(`document.body.innerText.includes("Show more") && document.body.innerText.includes("3 songs")`)));
    await page.goto(`${base}/?mode=songs`);
    await page.waitFor(`document.body.innerText.includes("Clip 0")`, 5000);
    check("a genre's songs page has its name, a way back, Play and Shuffle, a search box and a sort menu, and Select", await page.evaluate<boolean>(`document.body.innerText.includes("Rock") && document.body.innerText.includes("All genres") && [...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Shuffle" && !b.disabled) && !!document.querySelector('input[aria-label="Search this library"]') && !!document.querySelector('button[aria-label="Sort"]') && [...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Select")`));
    const idsSeen: string[] = [];
    app.on("request", (r) => idsSeen.push(r.url!));
    await page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Shuffle").click()`);
    await page.waitFor(`true`, 100);
    await new Promise((r) => setTimeout(r, 700));
    check("Shuffle asks for every song of the genre (not only the page shown)", idsSeen.some((u) => u.startsWith("/api/libraries/L1/folder-ids?all=1&groupKind=genre&group=Rock")), idsSeen);
    await page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Select").click()`);
    idsSeen.length = 0;
    await page.evaluate(`[...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.trim() === "Select all").click()`);
    await new Promise((r) => setTimeout(r, 500));
    check("Select all in a genre reads that genre's songs", idsSeen.some((u) => u.includes("all=1") && u.includes("groupKind=genre") && u.includes("group=Rock")), idsSeen);

    // A music library's albums: the actions work on the songs of the albums chosen.
    await page.goto(`${base}/?mode=music`);
    await page.waitFor(`document.body.innerText.includes("Album 0")`, 5000);
    await page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Select").click()`);
    await page.evaluate(`[...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.trim() === "Select all albums").click()`);
    check("Select all albums takes every album of the library (7), not just the 3 shown", await page.waitFor(`document.querySelector('[role="toolbar"]').innerText.includes("7 selected")`, 3000), await page.evaluate<string>(`document.querySelector('[role="toolbar"]').innerText`));
    await page.evaluate(`[...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.trim() === "Add to playlist").click()`);
    await page.waitFor(`document.body.innerText.includes("Weekend")`, 3000);
    requests.length = 0;
    await page.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.includes("Weekend")).click()`);
    await page.waitFor(`document.body.innerText.includes('Added 14 to "Weekend"')`, 3000);
    check("the albums become their 14 songs before they go in the playlist", JSON.stringify((requests.find((r) => r.url === "/api/playlists/P1/items")?.body as { titleIds: string[] })?.titleIds) === JSON.stringify(songsFor(albumAll)) && (requests.find((r) => r.url === "/api/libraries/L1/music-songs")?.body as { albumIds: string[] }).albumIds.length === 7, requests.map((r) => r.url));
    check("without any page error", page.errors.length === 0, page.errors.slice(0, 2));
  } finally {
    browser.close();
    app.close();
  }
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exitCode = failures ? 1 : 0;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(), 200));
