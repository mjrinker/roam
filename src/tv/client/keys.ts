/**
 * Remote-control keys across the TV browsers Roam's TV interface runs on: Samsung (Tizen), LG (webOS), Fire TV and plain
 * desktop browsers for testing. The codes are the ones those platforms document for their remotes.
 */

export type Direction = "left" | "up" | "right" | "down";
export type Action = "enter" | "back" | "play" | "pause" | "playpause" | "stop" | "forward" | "rewind";

const DIRECTIONS: Record<number, Direction> = { 37: "left", 38: "up", 39: "right", 40: "down" };

const ACTIONS: Record<number, Action> = {
  13: "enter",
  // Back: Backspace and Escape (desktop), 10009 (Tizen), 461 (webOS), 4 (Android key code some TV browsers pass through)
  8: "back",
  27: "back",
  10009: "back",
  461: "back",
  4: "back",
  // Media keys: webOS and Tizen use 415 play, 19 pause, 413 stop, 417 fast-forward, 412 rewind; Tizen's play/pause toggle is 10252
  415: "play",
  19: "pause",
  10252: "playpause",
  179: "playpause",
  32: "playpause",
  413: "stop",
  417: "forward",
  412: "rewind",
};

export const directionOf = (keyCode: number): Direction | null => DIRECTIONS[keyCode] ?? null;
export const actionOf = (keyCode: number): Action | null => ACTIONS[keyCode] ?? null;

/** The Tizen names of the remote keys the app must ask for before it is sent them (arrows and Back come for free). */
export const TIZEN_MEDIA_KEYS = ["MediaPlay", "MediaPause", "MediaPlayPause", "MediaStop", "MediaFastForward", "MediaRewind"] as const;
