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

/** The app's real stylesheet (from a build), so layout checks see what people see. Run `next build` first. */
function builtCss(): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".css")) out.push(fs.readFileSync(p, "utf8"));
    }
  };
  walk(".next/static");
  if (out.length === 0) throw new Error("No built CSS under .next/static: run `next build` first.");
  return out.join("\n");
}
const appCss = builtCss();

const SERVER = "11111111-1111-4111-8111-111111111111";
const CONN2 = "22222222-2222-4222-8222-222222222222";
const calls: string[] = [];
let connections = [
  { id: SERVER, provider: "box", label: "Box", accountName: "me@example.com", authStatus: "connected", libraries: 1 },
  { id: CONN2, provider: "box", label: "Dad's Box", accountName: null, authStatus: "needs_reauth", libraries: 0 },
  { id: "33333333-3333-4333-8333-333333333333", provider: "dropbox", label: "A-very-long-connection-name-with-no-spaces-that-keeps-going-on-and-on-and-on", accountName: "an.extremely.long.email.address.for.testing@some-really-long-domain-name-example.com", authStatus: "connected", libraries: 12 },
];
const tree: Record<string, { id: string; name: string }[]> = {
  "": [{ id: `cn_${CONN2}:f1`, name: "Home Movies" }, { id: `cn_${CONN2}:f2`, name: "Old Shows" }],
  [`cn_${CONN2}:f1`]: [{ id: `cn_${CONN2}:f11`, name: "1990s" }],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (body: unknown, status = 200) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (url.pathname === "/app.css") return void res.writeHead(200, { "content-type": "text/css" }).end(appCss);
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
  if (url.pathname === `/api/servers/${SERVER}` && req.method === "DELETE") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    return void req.on("end", () => {
      calls.push(`DELETE server ${raw}`);
      json({ ok: true });
    });
  }
  if (url.pathname === "/api/libraries/L1/status") return json({ scanning: true, titleCount: 1234, probeCounts: { pending: 40, ok: 1190, failed: 4 }, lastScannedAt: null, folderProgress: { done: 300, total: 900 }, lastScan: null });
  if (url.pathname === "/api/libraries/L1" && req.method === "DELETE") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    return void req.on("end", () => {
      calls.push(`DELETE L1 ${raw}`);
      json({ ok: true });
    });
  }
  if (url.pathname.endsWith("/sources") || url.pathname.includes("/sources/")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    return void req.on("end", () => {
      calls.push(`${req.method} ${url.pathname.split("/").slice(3).join("/")} ${raw}`);
      json({ ok: true });
    });
  }
  res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});

async function main() {
  await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { StorageConnections } from "@/components/admin/storage-connections";
        import { LibraryManager } from "@/components/admin/library-manager";
        import { DeleteServerButton } from "@/components/admin/delete-server-button";
        const conns = ${JSON.stringify(connections)};
        const lib = { id: "L1", name: "Movies and a very long library name that just keeps on going and going", kind: "video", access: "everyone", ratingAges: null, pruneMissing: true, musicLookup: false, boxFolderId: "0", firstFolderConnection: "Box", sources: [], audibleRegion: "us", lastScannedAt: "2026-10-01T00:00:00Z", lastScan: { trigger: "manual", finishedAt: null, filesSeen: 12, titlesAdded: 3, errors: ["probe Some-Extremely-Long-File-Name-With-No-Spaces-At-All-That-Goes-On-And-On-Forever-And-Ever-(1983).mp4: OneDrive gave no download link for that item"] } };
        window.__render = (sources) => createRoot(document.getElementById("root")).render(<><StorageConnections serverId="${SERVER}" connections={conns} available={["box","dropbox"]} /><DeleteServerButton serverId="${SERVER}" serverName="Roam Dev server with a rather long name" /><LibraryManager serverId="${SERVER}" libraries={[{ ...lib, sources }]} connections={conns.map((c) => ({ ...c, authStatus: "connected" }))} /></>);
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
    await click('Add "Home Movies" to Movies and a very long library name that just keeps on going and going');
    await new Promise((r) => setTimeout(r, 500));
    check("adding sends the folder's stored id and name", calls.some((c) => c.startsWith("POST L1/sources") && c.includes(`cn_${CONN2}:f1`) && c.includes("Home Movies")), calls);

    // Show it listed (with a very long folder name), then remove it.
    await page.evaluate(`window.__render([{ id: "s1", label: "Home Movies", connection: "Dad's Box" }, { id: "s2", label: "A-folder-with-a-really-long-name-and-no-spaces-in-it-at-all-to-see-whether-it-wraps-or-spills", connection: "Box" }])`);
    await page.waitFor(`document.body.innerText.includes("Home Movies")`, 3000);
    check("an added folder is listed with its connection", (await text()).includes("Home Movies") && (await text()).includes("· Dad"));
    await page.evaluate(`window.confirm = () => true`);
    await page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Remove" && b.closest("li")).click()`);
    await new Promise((r) => setTimeout(r, 400));
    check("removing a folder asks the API to", calls.some((c) => c.startsWith("DELETE L1/sources/s1")), calls);
    // Nothing is cut off or spills sideways, at a phone's width and a desktop's.
    const overflow = `(() => {
      const bad = [];
      for (const card of document.querySelectorAll('[data-slot="card"]')) {
      const box = card.getBoundingClientRect();
      for (const el of card.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1)) bad.push(el.tagName + ":" + (el.textContent || "").trim().slice(0, 30));
        // Text wider than its own box is cut off by the card (or spills out of it).
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible" && el.clientWidth > 0 && el.tagName !== "svg") bad.push("CLIPPED " + el.tagName + "." + String(el.className).slice(0, 50) + ":" + el.scrollWidth + ">" + el.clientWidth);
      }
      }
      const wide = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).map((e) => e.tagName + "." + String(e.className).slice(0, 60) + ":" + Math.round(e.getBoundingClientRect().right)).slice(0, 4);
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, bad: bad.slice(0, 5), wide };
    })()`;
    for (const [label, width, mobile] of [["phone", 375, true], ["desktop", 1280, false]] as const) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile });
      await new Promise((r) => setTimeout(r, 300));
      const o = await page.evaluate<{ page: number; bad: string[] }>(overflow);
      check(`the library card fits at ${label} width`, o.bad.length === 0 && o.page <= 0, o);
    }

    if (process.env.STORAGE_SHOT) {
      for (const [label, width, mobile] of [["phone", 375, true], ["desktop", 1100, false]] as const) {
        await page.send("Emulation.setDeviceMetricsOverride", { width, height: label === "phone" ? 2300 : 1300, deviceScaleFactor: 1, mobile });
        await new Promise((r) => setTimeout(r, 400));
        const shot = await page.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(`${process.env.STORAGE_SHOT}-${label}.png`, Buffer.from(shot.data as string, "base64"));
      }
    }

    // At a phone's width the words get the card's width: the buttons wrap below them instead of squeezing them into a thin column.
    await page.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
    await new Promise((r) => setTimeout(r, 300));
    const widths = await page.evaluate<{ storage: number; library: number; status: number }>(`(() => {
      const w = (el) => el.getBoundingClientRect().width;
      const cardOf = (text) => [...document.querySelectorAll('[data-slot="card"]')].find((c) => c.textContent.includes(text));
      const storageCard = cardOf("A-very-long-connection-name");
      const libCard = cardOf("Original folder");
      const status = [...libCard.querySelectorAll("p")].find((p) => p.textContent.startsWith("last scanned"));
      const name = libCard.querySelector("p.font-medium");
      return { storage: Math.round(w(storageCard.querySelector("p.font-medium")) / w(storageCard) * 100), library: Math.round(w(name) / w(libCard) * 100), status: Math.round(w(status) / w(libCard) * 100) };
    })()`);
    check("on a phone, a storage name gets most of its card's width", widths.storage >= 50, widths);
    check("on a phone, a library name gets most of its card's width", widths.library >= 50, widths);
    check("a library's scan status spans the card", widths.status >= 85, widths);

    // Deleting asks for the name first.
    await click("Delete");
    await page.waitFor(`document.body.innerText.includes("Type the library")`, 3000);
    const submitDisabled = () => page.evaluate<boolean>(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Delete library").disabled`);
    check("the delete button waits for the name to be typed", await submitDisabled());
    await page.evaluate(`(() => { const i = document.querySelector('input[autocomplete="off"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "Movies"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    check("a wrong name keeps it disabled", await submitDisabled());
    await page.evaluate(`(() => { const i = document.querySelector('input[autocomplete="off"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "Movies and a very long library name that just keeps on going and going"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    check("the right name enables it", !(await submitDisabled()));
    await click("Delete library");
    await new Promise((r) => setTimeout(r, 500));
    check("deleting sends the library's name to the API", calls.some((c) => c.startsWith("DELETE L1 ") && c.includes("Movies and a very long library name")), calls);
    // The server's own Danger zone: the same type-the-name guard.
    await page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Delete server" && !b.closest('[role="dialog"]')).click()`);
    await page.waitFor(`document.body.innerText.includes("Type the server")`, 3000);
    const serverSubmit = () => page.evaluate<boolean>(`[...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === "Delete server").disabled`);
    check("deleting the server waits for its name", await serverSubmit());
    await page.evaluate(`(() => { const i = document.querySelector('[role="dialog"] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "Roam Dev server with a rather long name"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    check("the right name enables it", !(await serverSubmit()));
    await page.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === "Delete server").click()`);
    await new Promise((r) => setTimeout(r, 500));
    check("it sends the server's name and goes to the servers list", calls.some((c) => c.startsWith("DELETE server") && c.includes("Roam Dev server")) && (await page.evaluate<string[]>("window.__nav || []")).includes("/servers"), calls);
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
