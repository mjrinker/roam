"use client";

import { createContext, useContext, type ReactNode } from "react";

const DataSaverContext = createContext(false);

/** Tells everything below whether this profile has data saver on (read from the profile on the server and handed down once). */
export function DataSaverProvider({ on, children }: { on: boolean; children: ReactNode }) {
  return <DataSaverContext.Provider value={on}>{children}</DataSaverContext.Provider>;
}

export const useDataSaver = (): boolean => useContext(DataSaverContext);
