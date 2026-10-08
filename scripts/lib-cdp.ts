/**
 * A tiny Chrome DevTools Protocol client, just enough to drive an old Chromium build (Playwright and Puppeteer both speak newer
 * protocol versions than Chromium 69 understands). Uses Node's built-in WebSocket.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }; // eslint-disable-line @typescript-eslint/no-explicit-any -- devtools replies are free-form

export class Page {
  private id = 0;
  private pending = new Map<number, Pending>();
  private loadWaiters: (() => void)[] = [];
  readonly errors: string[] = [];

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method === "Page.loadEventFired") {
        for (const w of this.loadWaiters.splice(0)) w();
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "exception");
      }
    });
  }

  static async connect(wsUrl: string): Promise<Page> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("devtools connection failed")));
    });
    const page = new Page(ws);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    return page;
  }

  send(method: string, params: object = {}): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any -- devtools replies are free-form
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async addInitScript(source: string) {
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  async goto(url: string) {
    await this.send("Page.navigate", { url });
    // The load event of the page we are leaving can arrive late, so wait for the address we asked for to be loaded.
    const target = JSON.stringify(url);
    if (!(await this.waitFor(`location.href === ${target} && document.readyState === "complete"`, 20000))) throw new Error("page load timed out: " + url);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  async waitFor(expression: string, timeoutMs = 10000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch {
        /* the page is mid-navigation */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  url = () => this.evaluate<string>("location.href");
  close() {
    this.ws.close();
  }
}

export interface Browser {
  page: Page;
  close(): void;
}

export async function launch(exe: string, port: number): Promise<Browser> {
  const child: ChildProcess = spawn(exe, ["--headless", "--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", `--remote-debugging-port=${port}`, "--window-size=1280,720", "--user-data-dir=" + fs.mkdtempSync("/tmp/tvchrome-"), "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const target = targets.find((t) => t.type === "page");
      if (target) {
        const page = await Page.connect(target.webSocketDebuggerUrl);
        await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
        return { page, close: () => (page.close(), child.kill("SIGKILL")) };
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill("SIGKILL");
  throw new Error("The browser did not start");
}
