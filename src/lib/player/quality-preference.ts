/** The resolution a viewer last picked on this device, as a pixel height; used to choose among the versions of any title. */
const KEY = "roam-preferred-height";

export function readPreferredHeight(storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): number | null {
  try {
    const n = Number(storage?.getItem(KEY));
    return Number.isInteger(n) && n >= 100 && n <= 5000 ? n : null;
  } catch {
    return null;
  }
}

export function writePreferredHeight(height: number | null, storage: Pick<Storage, "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): void {
  if (height === null) return;
  try {
    storage?.setItem(KEY, String(Math.round(height)));
  } catch {
    // blocked storage: the choice just isn't remembered
  }
}
