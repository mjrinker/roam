// Runs INSIDE a Vercel Sandbox (Tier 2), next to a copy of remux-core.mjs
// and a static ffmpeg binary. It has no database and no long-lived Box
// credentials: it downloads via a pre-signed URL passed in at start, asks
// the app for a folder-scoped upload token (re-asked on expiry), and reports
// the outcome to the app's complete callback — nothing that started this
// sandbox stays alive to poll it. Never imports app modules.
import { mkdir, rm } from "node:fs/promises";
import { downloadToFile, preflightUpload, runFfmpeg, uploadFile } from "./remux-core.mjs";

const { DOWNLOAD_URL, TOKEN_URL, COMPLETE_URL, JOB_TOKEN, OUT_NAME, INPUT_SIZE, FFMPEG } = process.env;

async function postJson(url, body, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      lastErr = new Error(`${url} responded ${res.status}`);
      // A 4xx (bad/superseded token) will never succeed on retry.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  throw lastErr;
}

let folderId = null;
let cached = null;
async function getToken(force) {
  if (force || !cached || cached.expiresAt - Date.now() < 60_000) {
    const t = await postJson(TOKEN_URL, { jobToken: JOB_TOKEN });
    folderId = t.folderId;
    cached = { accessToken: t.accessToken, expiresAt: Date.parse(t.expiresAt) };
  }
  return cached.accessToken;
}

const dir = "work";
async function main() {
  await getToken(false);
  const pre = await preflightUpload({ getToken, folderId, name: OUT_NAME, size: Number(INPUT_SIZE) || 0 });
  if (pre.conflictId) return { ok: true, uploaded: { id: pre.conflictId } };

  await mkdir(dir, { recursive: true });
  await downloadToFile(DOWNLOAD_URL, `${dir}/input.mp4`);
  await runFfmpeg(FFMPEG, `${dir}/input.mp4`, `${dir}/output.mp4`);
  await rm(`${dir}/input.mp4`, { force: true });

  const uploaded = await uploadFile({ getToken, folderId, name: OUT_NAME, filePath: `${dir}/output.mp4` });
  return {
    ok: true,
    uploaded: "conflictId" in uploaded ? { id: uploaded.conflictId } : uploaded,
  };
}

let outcome;
try {
  outcome = await main();
} catch (err) {
  outcome = { ok: false, error: String(err?.message ?? err) };
}
try {
  await postJson(COMPLETE_URL, { jobToken: JOB_TOKEN, ...outcome });
} catch (err) {
  // The app will notice the missing completion and requeue after the tier's budget.
  console.error("couldn't report completion:", err);
  process.exitCode = 1;
}
