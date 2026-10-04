/** Postgres error codes worth ONE retry: deadlock, serialization failure. */
export const CONTENTION_CODES = ["40P01", "40001"] as const;
/** A referenced row (viewer, title, episode) was deleted between a check and the write. */
export const FK_VIOLATION = "23503";

/** The Postgres error code, wherever the driver or drizzle put it. */
export function dbErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

const MAX_ATTEMPTS = 3;

/**
 * Runs `fn`; if it fails with one of `codes` it runs again, up to three attempts in
 * all with a short random pause between them (the callback is expected to re-read
 * everything under a fresh lock), then rethrows. Lock order differs between the
 * viewer routes and playlist mutations, so a rare deadlock is expected and retried
 * rather than surfaced as a 500; the jitter keeps two colliding requests from
 * deadlocking again in lockstep.
 */
export async function retryOnContention<T>(
  fn: () => Promise<T>,
  codes: readonly string[] = CONTENTION_CODES
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = dbErrorCode(err);
      if (!code || !codes.includes(code) || attempt >= MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60));
    }
  }
}
