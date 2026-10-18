/**
 * Screen time: a daily limit and quiet hours for a profile. Pure rules, on the clock of the profile's own time zone, so they can be tested
 * without a database or a real clock.
 */
export interface ScreenTimeSettings {
  /** The most minutes of watching in a day; null = no limit. */
  limitMinutes: number | null;
  /** Quiet hours, minutes after midnight (the window may run past midnight, 21:00 to 07:00); both null = none. */
  quietFrom: number | null;
  quietTo: number | null;
  /** An IANA time zone name ("America/Denver"); null or unknown = UTC. */
  timeZone: string | null;
}

export type ScreenTimeDecision =
  | { allowed: true; /** Seconds of the limit left today, or null with no limit. */ remainingSeconds: number | null; /** Seconds until quiet hours begin, or null when there are none today. */ untilQuietSeconds: number | null }
  | { allowed: false; reason: "limit" | "quiet"; message: string };

export const hasScreenTimeRules = (s: ScreenTimeSettings): boolean => s.limitMinutes !== null || (s.quietFrom !== null && s.quietTo !== null);

function zone(timeZone: string | null): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** The local date ("2026-10-18") and the minutes after local midnight at an instant, in a time zone. */
export function localClock(now: Date, timeZone: string | null): { day: string; minutes: number; seconds: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone(timeZone), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { day: `${get("year")}-${pad(get("month"))}-${pad(get("day"))}`, minutes: get("hour") * 60 + get("minute"), seconds: get("second") };
}

/** Whether a time of day (minutes after midnight) is inside a quiet window that may run past midnight. */
export function inQuietHours(minutes: number, from: number | null, to: number | null): boolean {
  if (from === null || to === null || from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

const clockWords = (minutes: number) => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
};

/** May this profile watch now, given what it has watched today? */
export function evaluateScreenTime(s: ScreenTimeSettings, usedSeconds: number, now: Date): ScreenTimeDecision {
  const clock = localClock(now, s.timeZone);
  if (inQuietHours(clock.minutes, s.quietFrom, s.quietTo)) return { allowed: false, reason: "quiet", message: `It's quiet time until ${clockWords(s.quietTo!)}.` };
  if (s.limitMinutes !== null && usedSeconds >= s.limitMinutes * 60) return { allowed: false, reason: "limit", message: "Screen time is up for today." };
  let untilQuiet: number | null = null;
  if (s.quietFrom !== null && s.quietTo !== null && s.quietFrom !== s.quietTo) {
    const nowSeconds = clock.minutes * 60 + clock.seconds;
    const start = s.quietFrom * 60;
    untilQuiet = start > nowSeconds ? start - nowSeconds : start + 86_400 - nowSeconds;
  }
  return { allowed: true, remainingSeconds: s.limitMinutes === null ? null : s.limitMinutes * 60 - usedSeconds, untilQuietSeconds: untilQuiet };
}

/** How long the player may keep going before it must stop: the sooner of the limit and quiet hours; null = no need to stop. */
export function stopInSeconds(d: Extract<ScreenTimeDecision, { allowed: true }>): number | null {
  const parts = [d.remainingSeconds, d.untilQuietSeconds].filter((n): n is number => n !== null);
  return parts.length ? Math.max(0, Math.min(...parts)) : null;
}
