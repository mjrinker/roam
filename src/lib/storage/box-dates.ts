/**
 * Box reports a file's dates as SDK `DateTime` wrappers (a `.value` Date that may be invalid), and the
 * uploader controls them: a file can claim any moment, including nonsense. Only a plausible date is
 * kept; anything else is "no date", so a bad value can never reach a sort key or a month heading.
 */
const EARLIEST_MS = Date.UTC(1970, 0, 2); // not the epoch-zero a missing date often turns into
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

export function boxDate(value: unknown, now = Date.now()): Date | undefined {
  let raw: unknown = value;
  if (raw && typeof raw === "object" && !(raw instanceof Date) && "value" in raw) raw = (raw as { value: unknown }).value;
  if (typeof raw === "string") raw = new Date(raw);
  if (!(raw instanceof Date)) return undefined;
  const ms = raw.getTime();
  if (!Number.isFinite(ms) || ms < EARLIEST_MS || ms > now + FUTURE_SLACK_MS) return undefined;
  return raw;
}
