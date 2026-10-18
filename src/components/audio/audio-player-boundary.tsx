"use client";

import type { ReactNode } from "react";
import { AudioPlayerProvider } from "@/components/audio/audio-player-provider";
import { useDataSaver } from "@/components/ui/data-saver-context";

/** The audio player, told whether data saver is on for this device right now (it follows the device's choice and the connection). */
export function AudioPlayerBoundary({ children }: { children: ReactNode }) {
  return <AudioPlayerProvider dataSaver={useDataSaver()}>{children}</AudioPlayerProvider>;
}
