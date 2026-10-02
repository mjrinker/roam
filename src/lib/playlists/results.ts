export type Failure = { ok: false; status: 400 | 403 | 404 | 409 | 429; error: string };
export type Result<T> = { ok: true; value: T } | Failure;

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (status: Failure["status"], error: string): Failure => ({ ok: false, status, error });

/** One identical response for "missing", "not yours to see" and "not a valid target" (viewer ids are guessable). */
export const NOT_FOUND: Failure = fail(404, "Not found");
