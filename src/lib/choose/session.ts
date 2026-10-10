/** Small pure parts of the "Help me choose" session. */
import type { ChooseItem } from "./pick";

/** After this many rounds of choosing, the session offers to choose for you. */
export const ROUNDS_BEFORE_ASKING = 15;

/** The kept item and a new one in a random order, so the one you picked isn't always on the same side. */
export function otherSide(kept: ChooseItem, next: ChooseItem, random: () => number = Math.random): ChooseItem[] {
  return random() < 0.5 ? [kept, next] : [next, kept];
}

/** 5400 -> "1h 30m"; 125 -> "2m"; under a minute or unknown -> null. */
export function formatChooseRuntime(seconds: number | null | undefined): string | null {
  if (!seconds || seconds < 60) return null;
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}
