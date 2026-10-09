/**
 * Opens the player's dropdown menus (speed, and the menu pieces they are built from) in a real Chromium and checks they open without an
 * error: a menu part used in the wrong place throws when the menu opens, which takes the whole player bar down with it.
 *
 *   MENUS_BROWSER=/path/to/chrome npx tsx scripts/menus-browser-check.ts
 */
import fs from "node:fs";
import http from "node:http";
import { build } from "esbuild";
import { launch } from "./lib-cdp";

const exe = process.env.MENUS_BROWSER;
if (!exe) throw new Error("Set MENUS_BROWSER=/path/to/a recent chrome");
const dir = fs.mkdtempSync("/tmp/menus-check-");
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
  if (!ok) failures++;
};

async function main() {
  await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { SpeedMenu } from "@/components/player/speed-menu";
        import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
        function Labelled() {
          return (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="labelled">open</DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>A label</DropdownMenuLabel>
                <DropdownMenuItem>Item</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        }
        createRoot(document.getElementById("root")!).render(
          <>
            <SpeedMenu rate={1.25} onChange={() => undefined} defaultSpeed={{ libraryId: "l", saved: null }} />
            <Labelled />
          </>
        );`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": "./src" },
    define: { "process.env.NODE_ENV": '"development"' },
    outfile: `${dir}/bundle.js`,
    logLevel: "error",
  });
  const server = http.createServer((req, res) => {
    if (req.url === "/bundle.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(`${dir}/bundle.js`));
    res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><html class="dark"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const browser = await launch(exe!, 9336);
  const page = browser.page;
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    check("the menus render", await page.waitFor(`!!document.querySelector('[aria-label^="Playback speed"]')`, 5000));
    await page.evaluate(`document.querySelector('[aria-label^="Playback speed"]').click()`);
    check("the speed menu opens and lists the speeds, a custom choice, and the default row", await page.waitFor(`document.body.innerText.includes("Speed") && document.body.innerText.includes("Custom") && document.body.innerText.includes("my default here")`, 3000), await page.evaluate<string>("document.body.innerText.slice(0, 200)"));
    check("and the page is still there", await page.evaluate<boolean>(`!!document.getElementById("root")?.firstChild`));
    await page.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await page.evaluate(`document.querySelector('[aria-label="labelled"]').click()`);
    check("a menu with a label opens too", await page.waitFor(`document.body.innerText.includes("A label")`, 3000), await page.evaluate<string>("document.body.innerText.slice(0, 200)"));
    check("without any error", page.errors.length === 0, page.errors.slice(0, 2));
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
