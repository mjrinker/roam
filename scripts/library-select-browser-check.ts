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
      contents: `import { createRoot } from "react-dom/client"; import { LibraryBrowser } from "@/components/library/library-browser"; import { Toaster } from "@/components/ui/sonner";
        const items = ${JSON.stringify(items)};
        createRoot(document.getElementById("root")!).render(<><LibraryBrowser items={items as any} serverId="S1" /><Toaster /></>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": "./src", "next/link": "./scripts/stubs/next-link.tsx", "next/image": "./scripts/stubs/next-image.tsx" },
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
