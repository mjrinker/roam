/** Whether the next episode (or the next item of a playlist) starts by itself after a countdown: a choice kept on this device, on by default. */
export const AUTOPLAY_KEY = "roam-autoplay-next";
/** Seconds the countdown runs before the next one starts. */
export const AUTOPLAY_SECONDS = 10;

type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

export function readAutoplay(storage: Store = typeof localStorage === "undefined" ? undefined : localStorage): boolean {
  try {
    return storage?.getItem(AUTOPLAY_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeAutoplay(on: boolean, storage: Store = typeof localStorage === "undefined" ? undefined : localStorage): void {
  try {
    storage?.setItem(AUTOPLAY_KEY, on ? "1" : "0");
  } catch {
    // storage is blocked: the choice just doesn't last
  }
}
