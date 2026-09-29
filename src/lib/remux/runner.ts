import { claimNextJob } from "./remux-pass";
import { startTier2Job } from "./sandbox";
import { runTier1Job } from "./tier1";

export type RunOutcome = {
  /** A job was claimed (false = nothing pending for this title). */
  claimed: boolean;
  /** Safe to immediately run the next pending job. False while a sandbox is still working — its completion callback chains instead. */
  chain: boolean;
};

/**
 * Claims and starts ONE pending job for a title. A Tier 1 job runs to
 * completion here; a Tier 2 job is only started (the sandbox reports back on
 * its own), so files in a multi-file title work through their queue one at a
 * time rather than launching a sandbox each in parallel.
 */
export async function runNextRemuxJob(titleId: string): Promise<RunOutcome> {
  const job = await claimNextJob(titleId);
  if (!job) return { claimed: false, chain: false };
  if (job.tier === 1) {
    await runTier1Job(job);
    return { claimed: true, chain: true };
  }
  const started = await startTier2Job(job);
  return { claimed: true, chain: !started };
}
