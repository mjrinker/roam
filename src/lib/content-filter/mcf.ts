/**
 * Movie Content Filter (.mcf) files: WebVTT with a "WEBVTT MovieContentFilter" header, where each cue's lines are
 * `category=severity[=channel][ # note]` (https://www.moviecontentfilter.com/specification). Read for the scenes to skip or mute.
 * The file is untrusted text: size and cue counts are capped, and anything that doesn't fit the format is left out.
 */
import { isFilterCategory, isFilterSeverity, type FilterCue } from "@/lib/content-filter/categories";
import { parseClock } from "@/lib/chapters/parse";

const MAX_CHARS = 512 * 1024;
export const MAX_CUES = 2000;
const MAX_NOTE = 160;

/** True for a file name that is a Movie Content Filter file. */
export const isMcfFile = (fileName: string) => /\.mcf$/i.test(fileName);
/** "Movie (2020).mcf" -> "Movie (2020)": the name of the video it belongs to; null if not an .mcf file. */
export const mcfFileVideoBase = (fileName: string) => (isMcfFile(fileName) ? fileName.replace(/\.mcf$/i, "") : null);

/** The cues in an .mcf file, sorted by start; empty when it isn't one. Several lines in a cue become several cues over the same span. */
export function parseMcf(text: string): FilterCue[] {
  const body = text.slice(0, MAX_CHARS).replace(/^﻿/, "");
  if (!/^WEBVTT\s+MovieContentFilter\b/i.test(body)) return [];
  const out: FilterCue[] = [];
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((l) => l.trim());
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0 || lines[0].startsWith("NOTE")) continue;
    const [from, to] = lines[at].split("-->").map((s) => s.trim().split(/\s+/)[0]);
    const start = parseClock(from);
    const end = parseClock(to);
    if (start === null || end === null || end <= start) continue;
    for (const line of lines.slice(at + 1)) {
      if (out.length >= MAX_CUES) break;
      const [spec, ...noteParts] = line.split("#");
      const [category, severity, channel] = spec.split("=").map((s) => s.trim().toLowerCase());
      if (!isFilterCategory(category) || !isFilterSeverity(severity)) continue;
      const note = noteParts.join("#").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);
      out.push({
        startSeconds: start,
        endSeconds: end,
        category,
        severity,
        // The file says video or audio; here they are the picture and the sound.
        channel: channel === "video" ? "picture" : channel === "audio" ? "sound" : "both",
        ...(note ? { note } : {}),
      });
    }
  }
  return out.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}
