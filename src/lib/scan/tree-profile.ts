/**
 * What differs between the kinds of file-tree library (video, audio) while they share one scanning
 * engine: which files count, what a title is called in the database, what the admin is told, and which
 * extra passes apply. The video values are exactly what the engine hard-coded before audio existed.
 */
import type { FileTreeKind } from "@/lib/libraries/profile";
import { isAudioFile, isVideoFile } from "@/lib/scan/conventions";

export interface TreeProfile {
  libraryKind: FileTreeKind;
  /** The kind of title each file becomes: a video file plays like a movie, an audio file like a one-part audiobook. */
  titleKind: "movie" | "audiobook";
  /** Admin-facing nouns for scan notes. */
  noun: { one: string; many: string };
  /** Appended to the "skipped: unsupported format" note. */
  supportedHint: string;
  /** Files Roam can play and probe. */
  isMedia(fileName: string): boolean;
  /** Files of this family in formats Roam can't read or play: counted and reported, never listed. */
  isUnsupported(fileName: string): boolean;
  /** A remuxed `name.aac.mp4` copy is linked to its original (video only: for audio it is just a file name). */
  linkVariants: boolean;
  /** Read audio/video codecs (for the audio-fix remux; video only). */
  probeCodecs: boolean;
  /** Ask Box for a generated thumbnail when a file has no embedded cover (Box makes none for audio). */
  thumbnails: boolean;
  /** Carry a file's embedded chapters (m4b chapters, MP3 CHAP frames) onto its title, where the audio player reads them. */
  chapters: boolean;
}

const hasExtension = (set: ReadonlySet<string>, fileName: string) => {
  const dot = fileName.lastIndexOf(".");
  return dot !== -1 && set.has(fileName.slice(dot).toLowerCase());
};

const UNSUPPORTED_VIDEO = new Set([".mkv", ".avi", ".webm", ".wmv", ".flv", ".mpg", ".mpeg", ".ts", ".m2ts", ".3gp", ".ogv"]);
const UNSUPPORTED_AUDIO = new Set([".flac", ".ogg", ".oga", ".opus", ".wav", ".aac", ".wma", ".aiff", ".aif", ".alac", ".ape", ".mka"]);

export const VIDEO_PROFILE: TreeProfile = {
  libraryKind: "video",
  titleKind: "movie",
  noun: { one: "video", many: "videos" },
  supportedHint: "Roam plays .mp4, .m4v and .mov",
  isMedia: isVideoFile,
  isUnsupported: (name) => hasExtension(UNSUPPORTED_VIDEO, name),
  linkVariants: true,
  probeCodecs: true,
  thumbnails: true,
  chapters: false,
};

export const AUDIO_PROFILE: TreeProfile = {
  libraryKind: "audio",
  titleKind: "audiobook",
  noun: { one: "audio file", many: "audio files" },
  supportedHint: "Roam plays .mp3, .m4a and .m4b",
  isMedia: isAudioFile,
  isUnsupported: (name) => hasExtension(UNSUPPORTED_AUDIO, name),
  linkVariants: false,
  probeCodecs: false,
  thumbnails: false,
  chapters: true,
};

export function treeProfileFor(kind: FileTreeKind): TreeProfile {
  return kind === "audio" ? AUDIO_PROFILE : VIDEO_PROFILE;
}
