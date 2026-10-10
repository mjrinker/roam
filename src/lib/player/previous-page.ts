/**
 * The page before the one showing now (this tab, this visit), so leaving the player can step back in history when the page it would
 * link to is the one just left. Linking there would add it to the history again and the browser's Back would reopen the player.
 */
let previous: string | null = null;
let current: string | null = null;

export function trackPage(pathname: string | null): void {
  if (!pathname || pathname === current) return;
  previous = current;
  current = pathname;
}

/** True when `href` (query and hash ignored) is the page shown before this one. */
export function cameFrom(href: string): boolean {
  return previous !== null && previous === href.split(/[?#]/)[0];
}

export function resetTrackedPages(): void {
  previous = null;
  current = null;
}
