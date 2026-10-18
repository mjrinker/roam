import { after } from "next/server";

/** Runs best-effort work once the response has gone out (Next's `after`); outside a request (tests, scripts) it just runs it, ignoring failures. */
export function afterResponse(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task().catch(() => undefined);
  }
}
