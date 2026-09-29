// Shared by BOTH remux tiers: the Fluid Compute function imports this
// directly, and the Vercel Sandbox worker runs it from a copy written into
// the sandbox. Keep it dependency-free (Node built-ins + global fetch only)
// and never import app modules — it must run standalone.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Files at/above this use Box's chunked upload API (its minimum is 20MB). */
export const CHUNKED_UPLOAD_MIN_BYTES = 20 * 1024 * 1024;

/**
 * Video is passed through untouched; only audio is re-encoded, to stereo
 * AAC (browser-universal; a browser downmixes surround itself anyway, and
 * this keeps the copy small). Plain faststart, NOT fragmented: our own
 * duration prober reads mvhd, which is 0 in a fragmented file.
 */
export function buildFfmpegArgs(input, output) {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    output,
  ];
}

/** Runs ffmpeg against local files. Rejects with the tail of stderr on a nonzero exit. */
export function runFfmpeg(ffmpegPath, input, output, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, buildFfmpegArgs(input, output), { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

/** Streams a (presigned) URL's body to disk. */
export async function downloadToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

// ── Box uploads ──────────────────────────────────────────────────────────

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * fetch against Box with the current token; retries once with a fresh token
 * on 401 (a long chunked upload can outlive its token) and a few times with
 * backoff on 429/5xx. `makeInit(token)` is called per attempt so bodies are rebuilt.
 */
async function boxFetch(getToken, url, makeInit) {
  let token = await getToken(false);
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, makeInit(token));
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      token = await getToken(true);
      continue;
    }
    if (RETRYABLE.has(res.status) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 15_000)));
      continue;
    }
    return res;
  }
}

/** The id of the file already occupying a name, from a Box 409 body — or null. */
export function conflictIdFrom(body) {
  const conflicts = body?.context_info?.conflicts;
  const first = Array.isArray(conflicts) ? conflicts[0] : conflicts;
  return first?.id ?? null;
}

async function errorFrom(res, what) {
  const body = await res.json().catch(() => null);
  const err = new Error(`Box ${what} failed (${res.status}${body?.code ? ` ${body.code}` : ""}): ${body?.message ?? "no detail"}`);
  err.status = res.status;
  err.body = body;
  return err;
}

/**
 * Asks Box whether an upload of this name/size into this folder would be
 * accepted — catches a name that's already taken (the previous attempt
 * already uploaded it: `conflictId`) and an account/file size cap, BEFORE
 * any heavy work. Returns `{ conflictId }` or `{ conflictId: null }`.
 */
export async function preflightUpload({ getToken, folderId, name, size }) {
  const res = await boxFetch(getToken, "https://api.box.com/2.0/files/content", (token) => ({
    method: "OPTIONS",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, parent: { id: folderId }, size }),
  }));
  if (res.ok) return { conflictId: null };
  const body = await res.json().catch(() => null);
  if (res.status === 409) {
    const conflictId = conflictIdFrom(body);
    if (conflictId) return { conflictId };
  }
  const err = new Error(`Box rejected the upload (${res.status}${body?.code ? ` ${body.code}` : ""}): ${body?.message ?? "no detail"}`);
  err.status = res.status;
  throw err;
}

async function uploadSimple({ getToken, folderId, name, filePath }) {
  const { readFile } = await import("node:fs/promises");
  const data = await readFile(filePath);
  const res = await boxFetch(getToken, "https://upload.box.com/api/2.0/files/content", (token) => {
    const form = new FormData();
    // "attributes" must precede the file part.
    form.append("attributes", JSON.stringify({ name, parent: { id: folderId } }));
    form.append("file", new Blob([data]), name);
    return { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form };
  });
  if (res.status === 409) {
    const conflictId = conflictIdFrom(await res.json().catch(() => null));
    if (conflictId) return { conflictId };
    throw await errorFrom(res, "upload");
  }
  if (!res.ok) throw await errorFrom(res, "upload");
  const entry = (await res.json()).entries?.[0];
  if (!entry) throw new Error("Box upload returned no file entry");
  return { id: entry.id, name: entry.name, size: entry.size };
}

async function uploadChunked({ getToken, folderId, name, filePath, size }) {
  const sessionRes = await boxFetch(getToken, "https://upload.box.com/api/2.0/files/upload_sessions", (token) => ({
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ folder_id: folderId, file_size: size, file_name: name }),
  }));
  if (sessionRes.status === 409) {
    const conflictId = conflictIdFrom(await sessionRes.json().catch(() => null));
    if (conflictId) return { conflictId };
    throw await errorFrom(sessionRes, "upload session");
  }
  if (!sessionRes.ok) throw await errorFrom(sessionRes, "upload session");
  const session = await sessionRes.json();
  const partSize = session.part_size;
  const endpoints = session.session_endpoints;

  const fileHash = createHash("sha1");
  const parts = [];
  const handle = await open(filePath, "r");
  try {
    for (let offset = 0; offset < size; offset += partSize) {
      const length = Math.min(partSize, size - offset);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      if (bytesRead !== length) throw new Error(`short read at offset ${offset}`);
      fileHash.update(buf);
      const partDigest = createHash("sha1").update(buf).digest("base64");

      const partRes = await boxFetch(getToken, endpoints.upload_part, (token) => ({
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/octet-stream",
          digest: `sha=${partDigest}`,
          "content-range": `bytes ${offset}-${offset + length - 1}/${size}`,
        },
        body: buf,
      }));
      if (!partRes.ok) throw await errorFrom(partRes, "part upload");
      parts.push((await partRes.json()).part);
    }
  } finally {
    await handle.close();
  }

  const digest = `sha=${fileHash.digest("base64")}`;
  for (let attempt = 0; attempt < 10; attempt++) {
    const commitRes = await boxFetch(getToken, endpoints.commit, (token) => ({
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", digest },
      body: JSON.stringify({ parts }),
    }));
    // 202: Box is still assembling the file — poll again per Retry-After.
    if (commitRes.status === 202) {
      const wait = Number(commitRes.headers.get("retry-after")) || 2;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (commitRes.status === 409) {
      const conflictId = conflictIdFrom(await commitRes.json().catch(() => null));
      if (conflictId) return { conflictId };
    }
    if (!commitRes.ok) throw await errorFrom(commitRes, "upload commit");
    const entry = (await commitRes.json()).entries?.[0];
    if (!entry) throw new Error("Box upload commit returned no file entry");
    return { id: entry.id, name: entry.name, size: entry.size };
  }
  throw new Error("Box upload commit still pending after 10 polls");
}

/**
 * Uploads a local file into a Box folder. Returns `{ id, name, size }`, or
 * `{ conflictId }` when a file by that name already exists (the earlier
 * attempt succeeded — the caller links that existing file rather than fail).
 */
export async function uploadFile({ getToken, folderId, name, filePath }) {
  const { size } = await stat(filePath);
  return size >= CHUNKED_UPLOAD_MIN_BYTES
    ? uploadChunked({ getToken, folderId, name, filePath, size })
    : uploadSimple({ getToken, folderId, name, filePath });
}
