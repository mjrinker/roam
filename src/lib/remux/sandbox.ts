/**
 * Tier 2: remux a large file inside a Vercel Sandbox. This function only
 * STARTS the sandbox (detached) and returns; the sandbox reports back via
 * /api/remux/token and /api/remux/complete. Credentials for the Sandbox SDK
 * come from the deployment's OIDC token.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { getFreshDownloadUrl } from "@/lib/storage/box";
import { failRemuxJob, TIER2_BUDGET_MS, type RemuxJob } from "./remux-pass";

const SANDBOX_TIMEOUT_MS = TIER2_BUDGET_MS - 5 * 60_000; // ends before queueRemux would call the job dead

/** Returns whether the sandbox started (false = the job was marked failed). */
export async function startTier2Job(job: RemuxJob): Promise<boolean> {
  let sandbox: Sandbox | undefined;
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!baseUrl) throw new Error("NEXT_PUBLIC_APP_URL is not set");

    // Minted last, right before the sandbox starts using it.
    const [core, worker, ffmpeg] = await Promise.all([
      readFile(join(process.cwd(), "src/lib/remux/remux-core.mjs")),
      readFile(join(process.cwd(), "src/lib/remux/remux-worker.mjs")),
      import("@ffmpeg-installer/ffmpeg").then((m) => readFile(m.default.path)),
    ]);
    const { url } = await getFreshDownloadUrl(job.serverId, job.boxFileId);

    sandbox = await Sandbox.create({ runtime: "node22", timeout: SANDBOX_TIMEOUT_MS, resources: { vcpus: 2 } });
    await sandbox.writeFiles([
      { path: "remux-core.mjs", content: core },
      { path: "remux-worker.mjs", content: worker },
      { path: "ffmpeg", content: ffmpeg, mode: 0o755 },
    ]);
    await sandbox.runCommand({
      cmd: "node",
      args: ["remux-worker.mjs"],
      detached: true,
      env: {
        DOWNLOAD_URL: url,
        TOKEN_URL: new URL("/api/remux/token", baseUrl).toString(),
        COMPLETE_URL: new URL("/api/remux/complete", baseUrl).toString(),
        JOB_TOKEN: job.jobToken,
        OUT_NAME: job.outputName,
        INPUT_SIZE: String(job.sizeBytes ?? 0),
        FFMPEG: "./ffmpeg",
      },
    });
    return true;
  } catch (err) {
    await sandbox?.stop().catch(() => {});
    await failRemuxJob(job.jobToken, `couldn't start sandbox: ${(err as Error).message}`).catch(() => {});
    return false;
  }
}
