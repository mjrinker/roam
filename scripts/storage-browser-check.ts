/**
 * The admin storage screens in a real Chromium against a pretend server: the Storage card (add / rename / remove) and a library's
 * Folders section (browse another connection, add a folder, remove it).
 *
 *   STORAGE_BROWSER=/path/to/chrome npx tsx scripts/storage-browser-check.ts
 */
import fs from "node:fs";
import http from "node:http";
import { build } from "esbuild";
import { launch } from "./lib-cdp";

const exe = process.env.STORAGE_BROWSER;
if (!exe) throw new Error("Set STORAGE_BROWSER=/path/to/a recent chrome");
const dir = fs.mkdtempSync("/tmp/storage-check-");
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
  if (!ok) failures++;
};

const SERVER = "11111111-1111-4111-8111-111111111111";
const CONN2 = "22222222-2222-4222-8222-222222222222";
const calls: string[] = [];
let connections = [
  { id: SERVER, provider: "box", label: "Box", accountName: "me@example.com", authStatus: "connected", libraries: 1 },
  { id: CONN2, provider: "box", label: "Dad's Box", accountName: null, authStatus: "needs_reauth", libraries: 0 },
];
let sources: { id: string; label: string; connection: string }[] = [];
const tree: Record<string, { id: string; name: string }[]> = {
  "": [{ id: `cn_${CONN2}:f1`, name: "Home Movies" }, { id: `cn_${CONN2}:f2`, name: "Old Shows" }],
  [`cn_${CONN2}:f1`]: [{ id: `cn_${CONN2}:f11`, name: "1990s" }],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (body: unknown, status = 200) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (url.pathname === "/bundle.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(`${dir}/bundle.js`));
  if (url.pathname === "/api/storage/browse") {
    calls.push(`browse ${url.searchParams.get("connectionId")} ${url.searchParams.get("folderId") ?? "(top)"}`);
    return json({ folders: tree[url.searchParams.get("folderId") ?? ""] ?? [], rootId: `cn_${CONN2}:root` });
  }
  if (url.pathname.startsWith("/api/storage/connections/")) {
    const id = url.pathname.split("/").pop()!;
    let raw = "";
    req.on("data", (c) => (raw += c));
    return void req.on("end", () => {
      calls.push(`${req.method} connection ${id} ${raw}`);
      if (req.method === "DELETE") connections = connections.filter((c) => c.id !== id);
      if (req.method === "PATCH") connections = connections.map((c) => (c.id === id ? { ...c, label: JSON.parse(raw).label } : c));
      json({ ok: true });
    });
  }
  if (url.pathname.endsWith("/sources") || url.pathname.includes("/sources/")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    return void req.on("end", () => {
      calls.push(`${req.method} ${url.pathname.split("/").slice(3).join("/")} ${raw}`);
      if (req.method === "POST") sources = [{ id: "s1", label: JSON.parse(raw).label, connection: "Dad's Box" }];
      if (req.method === "DELETE") sources = [];
      json({ ok: true });
    });
  }
  res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><html class="dark"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});

async function main() {
  await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { StorageConnections } from "@/components/admin/storage-connections";
        import { LibraryManager } from "@/components/admin/library-manager";
        const conns = ${JSON.stringify(connections)};
        const lib = { id: "L1", name: "Movies", kind: "movies", access: "everyone", ratingAges: null, pruneMissing: false, musicLookup: false, boxFolderId: "0", firstFolderConnection: "Box", sources: [], audibleRegion: "us", lastScannedAt: null, lastScan: null };
        window.__render = (sources) => createRoot(document.getElementById("root")).render(<><StorageConnections serverId="${SERVER}" connections={conns} /><LibraryManager serverId="${SERVER}" libraries={[{ ...lib, sources }]} connections={conns.map((c) => ({ ...c, authStatus: "connected" }))} /></>);
        window.__render([]);`,
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
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await launch(exe!, 9339);
  const page = browser.page;
  const text = () => page.evaluate<string>("document.body.innerText");
  const click = (label: string) => page.evaluate(`[...document.querySelectorAll("button, a")].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  try {
    await page.goto(`${base}/`);
    await page.waitFor(`document.body.innerText.includes("Dad's Box")`, 5000);
    const t = await text();
    check("the Storage card lists both connections with their state", t.includes("Box") && t.includes("Dad's Box") && t.includes("Needs signing in again") && t.includes("me@example.com") && t.includes("1 library"), t.slice(0, 300));
    check("a connection that needs signing in offers to do it", await page.evaluate<boolean>(`[...document.querySelectorAll("a")].some(a => a.textContent.trim() === "Sign in again" && a.getAttribute("href").includes("connectionId=${CONN2}"))`));
    check("a connection that is fine offers Reconnect to its own address", await page.evaluate<boolean>(`[...document.querySelectorAll("a")].some(a => a.textContent.trim() === "Reconnect" && a.getAttribute("href").includes("connectionId=${SERVER}"))`));

    // Rename.
    await page.evaluate(`[...document.querySelectorAll("button")].filter(b => b.textContent.trim() === "Rename")[1].click()`);
    await page.waitFor(`!!document.querySelector('input[maxlength="60"]')`, 2000);
    await page.evaluate(`(() => { const i = document.querySelector('input[maxlength="60"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "Dad Box 2"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await click("Save");
    await new Promise((r) => setTimeout(r, 400));
    check("renaming sends the new name", calls.some((c) => c.startsWith(`PATCH connection ${CONN2}`) && c.includes("Dad Box 2")), calls);

    // The library's Folders section: browse the other connection and add a folder.
    check("the library shows its original folder and where it is", (await text()).includes("Original folder") && (await text()).includes("· Box"));
    await click("Add a folder");
    await page.waitFor(`document.body.innerText.includes("Home Movies")`, 4000);
    check("the top folder is listed once, not fetched twice", calls.filter((c) => c.startsWith(`browse ${SERVER}`)).length === 1, calls);
    check("it browses the chosen connection from its top", calls.some((c) => c.startsWith(`browse ${SERVER} (top)`)), calls);
    await page.evaluate(`(() => { const s = [...document.querySelectorAll("select")].find(s => s.getAttribute("aria-label") === "Storage"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "${CONN2}"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await page.waitFor(`document.body.innerText.includes("Old Shows")`, 4000);
    check("switching connection browses that one", calls.some((c) => c.startsWith(`browse ${CONN2} (top)`)), calls);
    await click("Home Movies");
    await page.waitFor(`document.body.innerText.includes("1990s")`, 4000);
    check("opening a folder shows its subfolders", (await text()).includes("1990s"));
    await click('Add "Home Movies" to Movies');
    await new Promise((r) => setTimeout(r, 500));
    check("adding sends the folder's stored id and name", calls.some((c) => c.startsWith("POST L1/sources") && c.includes(`cn_${CONN2}:f1`) && c.includes("Home Movies")), calls);

    // Show it listed, then remove it.
    await page.evaluate(`window.__render([{ id: "s1", label: "Home Movies", connection: "Dad's Box" }])`);
    await page.waitFor(`document.body.innerText.includes("Home Movies")`, 3000);
    check("an added folder is listed with its connection", (await text()).includes("Home Movies") && (await text()).includes("· Dad"));
    await page.evaluate(`window.confirm = () => true`);
    await page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Remove" && b.closest("li")).click()`);
    await new Promise((r) => setTimeout(r, 400));
    check("removing a folder asks the API to", calls.some((c) => c.startsWith("DELETE L1/sources/s1")), calls);
    check("without any page error", page.errors.length === 0, page.errors.slice(0, 2));
  } finally {
    browser.close();
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exitCode = failures ? 1 : 0;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(), 200));
