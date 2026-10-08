/** The "play these songs in order" queue behind an album's Play and Shuffle: pure, so the rules are tested apart from the player. */

export interface ListQueue {
  ids: string[];
  index: number;
}

/** A song heard for longer than this restarts on "previous" instead of going back a song. */
export const RESTART_AFTER_SECONDS = 3;

/** The index of the song after the current one, or null at the end. */
export function nextIndex(q: ListQueue): number | null {
  return q.index + 1 < q.ids.length ? q.index + 1 : null;
}

/** What "previous" does: start the song over (late in it, or at the first song) or go back one. */
export function previousStep(q: ListQueue, positionSeconds: number): { restart: true } | { restart: false; index: number } {
  if (positionSeconds > RESTART_AFTER_SECONDS || q.index === 0) return { restart: true };
  return { restart: false, index: q.index - 1 };
}

/** A random order of the ids, with `firstId` (when given and present) first. Fisher-Yates; `random` is for tests. */
export function shuffled(ids: readonly string[], firstId?: string, random: () => number = Math.random): string[] {
  const rest = ids.filter((id) => id !== firstId);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return firstId !== undefined && ids.includes(firstId) ? [firstId, ...rest] : rest;
}
