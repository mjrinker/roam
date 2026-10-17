/**
 * A tiny web server on this machine that hands ffmpeg a file from your storage. The ffmpeg that ships with Roam is a static build that crashes
 * when it opens an https address itself, so ffmpeg is pointed at http://127.0.0.1:<port>/<id> and this fetches the bytes it asks for (ranges,
 * so it can jump to wherever the file keeps its index) from the real address with Node's own networking. Only for the script that listens to
 * episodes; it listens on the loopback address only and goes away when that script ends.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";

export interface RangeProxy {
  /** The address to give ffmpeg for the file with this id. */
  urlFor(id: string): string;
  close(): Promise<void>;
}

const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

async function handle(getUrl: (id: string) => Promise<string>, req: IncomingMessage, res: ServerResponse) {
  const id = decodeURIComponent((req.url ?? "/").slice(1).split("?")[0]);
  if (!id || (req.method !== "GET" && req.method !== "HEAD")) {
    res.writeHead(405).end();
    return;
  }
  try {
    const upstream = await getUrl(id);
    // A HEAD is asked as a one-byte range, since a storage service's download address may not answer HEAD.
    const range = req.method === "HEAD" ? "bytes=0-0" : req.headers.range;
    const got = await fetch(upstream, { headers: range ? { range } : {}, signal: AbortSignal.timeout(120_000) });
    const headers: Record<string, string> = {};
    for (const h of PASS) {
      const v = got.headers.get(h);
      if (v) headers[h] = v;
    }
    headers["accept-ranges"] = "bytes";
    if (req.method === "HEAD") {
      // The whole size comes from "bytes 0-0/12345".
      const total = /\/(\d+)$/.exec(got.headers.get("content-range") ?? "")?.[1] ?? got.headers.get("content-length") ?? "0";
      delete headers["content-range"];
      headers["content-length"] = total;
      res.writeHead(200, headers).end();
      await got.body?.cancel();
      return;
    }
    res.writeHead(got.status, headers);
    if (!got.body) return void res.end();
    const body = Readable.fromWeb(got.body as never);
    body.on("error", () => res.destroy());
    res.on("close", () => body.destroy());
    body.pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
}

export async function startRangeProxy(getUrl: (id: string) => Promise<string>): Promise<RangeProxy> {
  const server: Server = createServer((req, res) => void handle(getUrl, req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    urlFor: (id) => `http://127.0.0.1:${port}/${encodeURIComponent(id)}`,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections?.(), server.close(() => resolve()))),
  };
}
