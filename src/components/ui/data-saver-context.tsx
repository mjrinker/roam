"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  connectionIsMetered,
  dataSaverParam,
  DATA_SAVER_MODE_KEY,
  effectiveDataSaver,
  readDataSaverMode,
  writeDataSaverMode,
  type ConnectionInfo,
  type DataSaverMode,
} from "@/lib/player/data-saver-mode";

interface DataSaverState {
  /** Whether data saver is on right now, on this device. */
  on: boolean;
  mode: DataSaverMode;
  profileOn: boolean;
  /** Mobile data (true), Wi-Fi (false), or a browser that can't tell (null). */
  metered: boolean | null;
  setMode: (mode: DataSaverMode) => void;
  /** What to send the server with a request ("1" or "0"), or null to let the profile's own setting apply. */
  param: "1" | "0" | null;
}

const DataSaverContext = createContext<DataSaverState>({ on: false, mode: "profile", profileOn: false, metered: null, setMode: () => undefined, param: null });

const CHANGED = "roam-data-saver-changed";

const connection = (): (ConnectionInfo & EventTarget) | null => (typeof navigator === "undefined" ? null : ((navigator as { connection?: ConnectionInfo & EventTarget }).connection ?? null));

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGED, callback);
  const c = connection();
  c?.addEventListener("change", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGED, callback);
    c?.removeEventListener("change", callback);
  };
}

// A snapshot must be a stable value, so the connection is boiled down to one string.
const meteredSnapshot = (): string => String(connectionIsMetered(connection()));
const modeSnapshot = (): DataSaverMode => readDataSaverMode();

/**
 * Tells everything below whether data saver is on: the profile's setting (read on the server and handed down), unless this device has
 * been set to always/never or to follow the connection (see lib/player/data-saver-mode). The server render and the first paint use the
 * profile's setting; a device's own choice applies as soon as the page is running.
 */
export function DataSaverProvider({ on: profileOn, children }: { on: boolean; children: ReactNode }) {
  const mode = useSyncExternalStore(subscribe, modeSnapshot, () => "profile" as DataSaverMode);
  const meteredText = useSyncExternalStore(subscribe, meteredSnapshot, () => "null");
  const metered = meteredText === "null" ? null : meteredText === "true";
  const setMode = useCallback((next: DataSaverMode) => {
    writeDataSaverMode(next);
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  const value = useMemo<DataSaverState>(() => {
    const on = effectiveDataSaver(mode, profileOn, metered);
    return { on, mode, profileOn, metered, setMode, param: dataSaverParam(mode, on) };
  }, [mode, profileOn, metered, setMode]);
  return <DataSaverContext.Provider value={value}>{children}</DataSaverContext.Provider>;
}

export const useDataSaver = (): boolean => useContext(DataSaverContext).on;
export const useDataSaverState = (): DataSaverState => useContext(DataSaverContext);

export { DATA_SAVER_MODE_KEY };
