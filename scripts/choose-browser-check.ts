/**
 * "Help me choose" in a real Chromium against a pretend server: two things at a time, pick one, watch it or keep choosing, the offer to
 * choose for you after fifteen rounds, and what happens when the libraries run out.
 *
 *   CHOOSE_BROWSER=/path/to/chrome npx tsx scripts/choose-browser-check.ts
 */
import fs from "node:fs";
import http from "node:http";
import { build } from "esbuild";
import { launch } from "./lib-cdp";

const exe = process.env.CHOOSE_BROWSER;
if (!exe) throw new Error("Set CHOOSE_BROWSER=/path/to/a recent chrome");
const dir = fs.mkdtempSync("/tmp/choose-check-");
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
  if (!ok) failures++;
};

let poolSize = 60;
const requests: { exclude: string[]; count: number }[] = [];
const item = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, noun: "movie", verb: "Watch", libraryId: "L1", libraryName: "Movies", name: `Item ${n}`, subtitle: String(2000 + n), overview: `About item ${n}`,
  posterUrl: null, runtimeSeconds: 5400, pageHref: `/s/S1/title/${n}`, action: { kind: "go", href: `/s/S1/watch/title/${n}` },
});

const app = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const send = (type: string, body: string | Buffer, status = 200) => void res.writeHead(status, { "Content-Type": type }).end(body);
  if (url.pathname === "/bundle.js") return send("text/javascript", fs.readFileSync(`${dir}/bundle.js`));
  if (url.pathname === "/__pool") return send("text/plain", String((poolSize = Number(url.searchParams.get("n")))));
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (url.pathname === "/api/servers/S1/choose") {
      const body = JSON.parse(raw) as { exclude: string[]; count: number };
      requests.push({ exclude: body.exclude, count: body.count });
      const items = [];
      for (let n = 0; n < poolSize && items.length < body.count; n++) if (!body.exclude.includes(item(n).id)) items.push(item(n));
      return send("application/json", JSON.stringify({ items, libraries: 1 }));
    }
    send("text/html", '<!doctype html><html class="dark"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
});

async function main() {
  await build({
    stdin: {
      contents: `import { createRoot } from "react-dom/client"; import { ChooseSession } from "@/components/choose/choose-session"; import { AudioPlayerProvider } from "@/components/audio/audio-player-provider"; import { Toaster } from "@/components/ui/sonner";
        createRoot(document.getElementById("root")!).render(<AudioPlayerProvider><ChooseSession serverId="S1" libraries={[{ id: "L1", name: "Movies", kind: "movies" }]} /><Toaster /></AudioPlayerProvider>);`,
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
  const browser = await launch(exe!, 9338);
  const page = browser.page;
  const text = () => page.evaluate<string>("document.body.innerText");
  const click = (label: string) => page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)}).click()`);
  const names = () => page.evaluate<string[]>(`[...document.querySelectorAll('button[aria-label^="Choose "]')].map(b => b.getAttribute("aria-label").slice(7))`);
  const navs = () => page.evaluate<string[]>(`window.__nav || []`);
  try {
    await page.goto(`${base}/`);
    check("two things appear to choose between", await page.waitFor(`document.querySelectorAll('button[aria-label^="Choose "]').length === 2`, 5000), await text());
    check("it says it's round 1, and names the library", (await text()).includes("Round 1") && (await text()).includes("From Movies"));
    check("the first request asks for two with nothing excluded", requests[0].count === 2 && requests[0].exclude.length === 0, requests[0]);

    await click("Choose Item 0");
    check("choosing one asks whether to watch it or keep choosing", await page.waitFor(`document.body.innerText.includes("You chose “Item 0”") && [...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Keep choosing")`, 3000), await text());
    check("the one not chosen is dimmed", await page.evaluate<boolean>(`!!document.querySelector('button[aria-label="Choose Item 1"]').closest("div.opacity-50")`));
    await click("Keep choosing");
    check("keep choosing sets the pick against a new one (round 2)", await page.waitFor(`document.body.innerText.includes("Round 2")`, 3000) && JSON.stringify((await names()).sort()) === JSON.stringify(["Item 0", "Item 2"]), await names());
    check("the new item was asked for alone, excluding what had been shown", requests[1].count === 1 && JSON.stringify(requests[1].exclude) === JSON.stringify([item(0).id, item(1).id]), requests[1]);
    await click("Choose Item 2");
    await page.waitFor(`document.body.innerText.includes("You chose “Item 2”")`, 3000);
    await click("Watch it");
    check("watching goes to that item's player", (await navs()).pop() === "/s/S1/watch/title/2", await navs());

    // Fifteen rounds without deciding: it offers to choose for you.
    await page.goto(`${base}/`);
    await page.waitFor(`document.querySelectorAll('button[aria-label^="Choose "]').length === 2`, 5000);
    for (let round = 1; round <= 14; round++) {
      const [first] = await names();
      await click(`Choose ${first}`);
      await click("Keep choosing");
      await page.waitFor(`document.body.innerText.includes("Round ${round + 1}")`, 3000);
    }
    check("after fourteen rounds it is still choosing between two", (await names()).length === 2 && (await text()).includes("Round 15"));
    const [fifteenth] = await names();
    await click(`Choose ${fifteenth}`);
    await click("Keep choosing");
    check("after the fifteenth round it asks whether to choose for you, in those words", await page.waitFor(`document.body.innerText.includes("Looks like you're having a hard time deciding, want me to just choose one for you?")`, 3000), await text());
    check("and offers: choose for me, keep going, or one of the two", (await text()).includes("Choose one for me") && (await text()).includes("Keep going") && (await text()).includes("one of these"));

    // Keep going: carries on, round 16.
    await click("Keep going");
    check("keep going carries on with the next round", await page.waitFor(`document.body.innerText.includes("Round 16") && document.querySelectorAll('button[aria-label^="Choose "]').length === 2`, 3000), await text());

    // Back at the offer: choose for me plays a random one (asked for with nothing excluded); or play one of the two shown.
    for (let i = 0; i < 15; i++) {
      const [first] = await names();
      await click(`Choose ${first}`);
      await click("Keep choosing");
      if (await page.waitFor(`document.body.innerText.includes("hard time deciding")`, 800)) break;
      await page.waitFor(`document.querySelectorAll('button[aria-label^="Choose "]').length === 2`, 3000);
    }
    check("it asks again after another run of rounds", (await text()).includes("hard time deciding"));
    await page.evaluate(`window.__nav = []`);
    requests.length = 0;
    await click("Choose one for me");
    await page.waitFor(`(window.__nav || []).length > 0`, 3000);
    check("choose one for me asks for a single item with nothing excluded and plays it", requests[0].count === 1 && requests[0].exclude.length === 0 && /^\/s\/S1\/watch\/title\/\d+$/.test((await navs()).pop() ?? ""), [requests[0], await navs()]);

    // The libraries run out: it starts again, apart from the one picked; with only one thing at all it says so.
    await fetch(`${base}/__pool?n=3`);
    await page.goto(`${base}/`);
    await page.waitFor(`document.querySelectorAll('button[aria-label^="Choose "]').length === 2`, 5000);
    await click(`Choose Item 0`);
    await click("Keep choosing");
    check("when the pool is nearly spent the last item still comes", await page.waitFor(`document.body.innerText.includes("Round 2")`, 3000) && (await names()).sort().join() === "Item 0,Item 2", await names());
    await click("Choose Item 0");
    await click("Keep choosing");
    check("when everything has been shown, it starts the pool again around the pick", await page.waitFor(`document.body.innerText.includes("Round 3")`, 3000) && (await names()).includes("Item 0") && (await names()).length === 2, await names());
    await fetch(`${base}/__pool?n=1`);
    await page.goto(`${base}/`);
    check("with a single thing available it shows just that, to watch", await page.waitFor(`document.body.innerText.includes("Watch it") && document.querySelectorAll('button[aria-label^="Choose "]').length === 1`, 3000), await text());
    await fetch(`${base}/__pool?n=0`);
    await page.goto(`${base}/`);
    check("with nothing available it says so", await page.waitFor(`document.body.innerText.includes("nothing to choose from")`, 3000), await text());
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
