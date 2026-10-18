/**
 * The resolution a viewer wants on this device. Three ways to say it:
 *   a pick        a version chosen by hand: its pixel height is kept, and the closest version of any title is used
 *   "original"    always the title's best version (it overrides data saver: it was asked for)
 *   "auto"        a version fitted to this screen and connection each time a title opens (see automatic-quality)
 * Nothing stored plays the best version, as before.
 */
const HEIGHT_KEY = "roam-preferred-height";
const MODE_KEY = "roam-quality-mode";

export type QualityMode = "auto" | "original" | "pick";
type Reader = Pick<Storage, "getItem"> | undefined;
type Writer = (Pick<Storage, "setItem"> & Partial<Pick<Storage, "removeItem">>) | undefined;
const local = () => (typeof localStorage === "undefined" ? undefined : localStorage);

export function readPreferredHeight(storage: Reader = local()): number | null {
  try {
    const n = Number(storage?.getItem(HEIGHT_KEY));
    return Number.isInteger(n) && n >= 100 && n <= 5000 ? n : null;
  } catch {
    return null;
  }
}

/** Remembers a version picked by hand (this ends Automatic or Original: a pick is a pick). */
export function writePreferredHeight(height: number | null, storage: Writer = local()): void {
  if (height === null) return;
  try {
    storage?.setItem(HEIGHT_KEY, String(Math.round(height)));
    storage?.removeItem?.(MODE_KEY);
  } catch {
    // blocked storage: the choice just isn't remembered
  }
}

export function readQualityMode(storage: Reader = local()): QualityMode {
  try {
    const v = storage?.getItem(MODE_KEY);
    return v === "auto" || v === "original" ? v : "pick";
  } catch {
    return "pick";
  }
}

export function writeQualityMode(mode: "auto" | "original", storage: Writer = local()): void {
  try {
    storage?.setItem(MODE_KEY, mode);
  } catch {
    // blocked storage: the choice just isn't remembered
  }
}
