/** A profile's own settings on a TV: what to skip and what to skip automatically. (The same things the web's profile editor has; the rest stays there.) */
import { hmacSign, hmacVerify } from "@/lib/crypto";
import { CATEGORY_LABELS, FILTER_CATEGORIES, FILTER_SEVERITIES, isFilterCategory, type ContentFilterPrefs, type FilterCategory, type FilterSeverity } from "@/lib/content-filter/categories";
import type { AutoSkipPrefs } from "@/lib/skipdb/active";
import { canEditExtended } from "@/lib/content/roles";

export const AUTO_SKIP_KINDS = [
  { key: "intro", label: "Intros" },
  { key: "recap", label: "Recaps" },
  { key: "preview", label: "Next-time previews" },
  { key: "outro", label: "Credits (go to the next episode)" },
] as const;
export type AutoSkipKey = (typeof AUTO_SKIP_KINDS)[number]["key"];
export const isAutoSkipKey = (v: unknown): v is AutoSkipKey => AUTO_SKIP_KINDS.some((k) => k.key === v);

/** Whether this profile may change its own settings on a TV: the same rule as the web (a child's profile may not). */
export const canChangeOwnSettings = (viewer: { id: string; role: "owner" | "admin" | "limited" }): boolean => canEditExtended(viewer, viewer.id);

/** The next strength in a category's cycle: off, mild, moderate, strong, then off again. */
export function nextSeverity(current: FilterSeverity | undefined): FilterSeverity | undefined {
  if (!current) return FILTER_SEVERITIES[0];
  const i = FILTER_SEVERITIES.indexOf(current);
  return i + 1 < FILTER_SEVERITIES.length ? FILTER_SEVERITIES[i + 1] : undefined;
}

export const severityWords = (s: FilterSeverity | undefined): string => (s === "low" ? "Mild and up" : s === "medium" ? "Moderate and up" : s === "high" ? "Strong only" : "Off");

export function cycleCategory(prefs: ContentFilterPrefs, category: unknown): ContentFilterPrefs | null {
  if (!isFilterCategory(category)) return null;
  const next = { ...prefs };
  const value = nextSeverity(prefs[category]);
  if (value) next[category] = value;
  else delete next[category];
  return next;
}

export function toggleAutoSkip(prefs: AutoSkipPrefs, key: unknown): AutoSkipPrefs | null {
  if (!isAutoSkipKey(key)) return null;
  const next = { ...prefs };
  if (next[key]) delete next[key];
  else next[key] = true;
  return next;
}

export const CATEGORY_ROWS: { key: FilterCategory; label: string }[] = FILTER_CATEGORIES.map((k) => ({ key: k, label: CATEGORY_LABELS[k] }));

// ── Re-checking the PIN before settings change ──
// The web asks a PIN-protected profile for its PIN on every extended edit, so a device left signed in can't be used to loosen things. A TV
// asks once, then lets the settings page be used for a few minutes (a signed, short-lived cookie that names the profile).
export const UNLOCK_COOKIE = "roam_tv_settings";
const UNLOCK_MS = 10 * 60 * 1000;

export function signUnlock(viewerId: string, pinVersion: number, now = Date.now()): string {
  const payload = `${viewerId}.${pinVersion}.${now + UNLOCK_MS}`;
  return `${payload}.${hmacSign("roam-tv-settings", payload)}`;
}

export function unlockValid(cookie: string | undefined | null, viewerId: string, pinVersion: number, now = Date.now()): boolean {
  if (!cookie) return false;
  const i = cookie.lastIndexOf(".");
  if (i < 0) return false;
  const payload = cookie.slice(0, i);
  const [id, version, until] = payload.split(".");
  if (id !== viewerId || Number(version) !== pinVersion || !(Number(until) > now)) return false;
  return hmacVerify("roam-tv-settings", payload, cookie.slice(i + 1));
}
