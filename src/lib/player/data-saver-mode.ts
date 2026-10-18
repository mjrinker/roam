/**
 * Whether data saver is on for THIS device. The profile has a setting, but a phone moves between home Wi-Fi and mobile data, so a device can
 * also be told to follow the connection:
 *   profile  use the profile's setting (the default)
 *   on / off always on, or always off, on this device
 *   auto     on while on mobile data (or when the browser's own data saver is on); off on Wi-Fi; and where the browser can't tell what kind of
 *            connection it has (Safari, Firefox: no network information at all), the profile's setting.
 */
export const DATA_SAVER_MODES = ["profile", "on", "off", "auto"] as const;
export type DataSaverMode = (typeof DATA_SAVER_MODES)[number];

export const DATA_SAVER_MODE_KEY = "roam-data-saver-mode";

export const isDataSaverMode = (v: unknown): v is DataSaverMode => typeof v === "string" && (DATA_SAVER_MODES as readonly string[]).includes(v);

type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

export function readDataSaverMode(storage: Store = typeof localStorage === "undefined" ? undefined : localStorage): DataSaverMode {
  try {
    const v = storage?.getItem(DATA_SAVER_MODE_KEY);
    return isDataSaverMode(v) ? v : "profile";
  } catch {
    return "profile";
  }
}

export function writeDataSaverMode(mode: DataSaverMode, storage: Store = typeof localStorage === "undefined" ? undefined : localStorage): void {
  try {
    storage?.setItem(DATA_SAVER_MODE_KEY, mode);
  } catch {
    // storage is blocked: the choice just doesn't last
  }
}

/** What a browser's Network Information object tells (only Chrome and Edge have one, and only Android Chrome says cellular or Wi-Fi). */
export interface ConnectionInfo {
  type?: string;
  saveData?: boolean;
}

/** True on mobile data or with the browser's own data saver on, false on Wi-Fi or a wired connection, null when it can't tell. */
export function connectionIsMetered(c: ConnectionInfo | null | undefined): boolean | null {
  if (!c) return null;
  if (c.saveData === true) return true;
  if (c.type === "cellular") return true;
  if (c.type === "wifi" || c.type === "ethernet") return false;
  return null;
}

export function effectiveDataSaver(mode: DataSaverMode, profileOn: boolean, metered: boolean | null): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  if (mode === "auto") return metered ?? profileOn;
  return profileOn;
}

/** How to say what is happening, for the menu: "On (mobile data)", "Off (Wi-Fi)", "On (your profile's setting)". */
export function describeDataSaver(mode: DataSaverMode, profileOn: boolean, metered: boolean | null): string {
  const on = effectiveDataSaver(mode, profileOn, metered);
  const state = on ? "On" : "Off";
  if (mode === "on" || mode === "off") return `${state} on this device`;
  if (mode === "auto" && metered !== null) return `${state} (${metered ? "mobile data" : "Wi-Fi"})`;
  return `${state} (profile setting)`;
}

/** The value to send the server with a request so it matches this device's choice; null when the profile's own setting should apply. */
export function dataSaverParam(mode: DataSaverMode, on: boolean): "1" | "0" | null {
  return mode === "profile" ? null : on ? "1" : "0";
}
