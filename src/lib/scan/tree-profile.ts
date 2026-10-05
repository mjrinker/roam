/**
 * What differs between the kinds of file-tree library (video, audio) while they share one scanning
 * engine: which files count, what a title is called in the database, what the admin is told, and which
 * extra passes apply. The video values are exactly what the engine hard-coded before audio existed.
 */
import type { TitleKind } from "@/lib/db/schema";
import type { FileTreeKind } from "@/lib/libraries/profile";
import { isAudioFile, isImageFile, isVideoFile } from "@/lib/scan/conventions";

export interface TreeProfile {
  libraryKind: FileTreeKind;
  /**
   * The kind of title a file becomes: a video file plays like a movie, an audio file like a one-part
   * audiobook, a picture is a photo. Per FILE, because a photo library holds pictures and videos.
   */
  titleKindFor(fileName: string): TitleKind;
  /** Every kind this profile can write (what pruning and cleanups select on). */
  titleKinds: readonly TitleKind[];
  /** Whether a file has a duration/codec to probe. A picture doesn't: its media row is born 'ok' so no prober ever opens it. */
  needsProbe(fileName: string): boolean;
  /** Read descriptive tags (and a cover) from the files. Photo libraries read an image's own metadata in a pass of their own. */
  readTags: boolean;
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
  /** A file's artist becomes its title's author, and its album the series (audio); video files have neither. */
  artistAsAuthor: boolean;
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
  titleKindFor: () => "movie",
  titleKinds: ["movie"],
  needsProbe: () => true,
  readTags: true,
  noun: { one: "video", many: "videos" },
  supportedHint: "Roam plays .mp4, .m4v and .mov",
  isMedia: isVideoFile,
  isUnsupported: (name) => hasExtension(UNSUPPORTED_VIDEO, name),
  linkVariants: true,
  probeCodecs: true,
  thumbnails: true,
  artistAsAuthor: false,
  chapters: false,
};

export const AUDIO_PROFILE: TreeProfile = {
  libraryKind: "audio",
  titleKindFor: () => "audiobook",
  titleKinds: ["audiobook"],
  needsProbe: () => true,
  readTags: true,
  noun: { one: "audio file", many: "audio files" },
  supportedHint: "Roam plays .mp3, .m4a and .m4b",
  isMedia: isAudioFile,
  isUnsupported: (name) => hasExtension(UNSUPPORTED_AUDIO, name),
  linkVariants: false,
  probeCodecs: false,
  thumbnails: false,
  artistAsAuthor: true,
  chapters: true,
};

/** RAW camera files, TIFF, BMP, AVIF: pictures Roam can't show (Box makes no usable preview for most of them). */
const UNSUPPORTED_IMAGE = new Set([".raw", ".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".tif", ".tiff", ".bmp", ".avif", ".psd"]);

export const PHOTOS_PROFILE: TreeProfile = {
  libraryKind: "photos",
  titleKindFor: (name) => (isImageFile(name) ? "photo" : "movie"),
  titleKinds: ["photo", "movie"],
  needsProbe: (name) => !isImageFile(name),
  readTags: false,
  noun: { one: "photo or video", many: "photos and videos" },
  supportedHint: "Roam shows .jpg, .png, .webp, .gif and .heic photos and plays .mp4, .m4v and .mov videos",
  isMedia: (name) => isImageFile(name) || isVideoFile(name),
  isUnsupported: (name) => hasExtension(UNSUPPORTED_IMAGE, name) || hasExtension(UNSUPPORTED_VIDEO, name),
  linkVariants: false,
  probeCodecs: false,
  // Thumbnails are fetched from Box on demand, never stored.
  thumbnails: false,
  artistAsAuthor: false,
  chapters: false,
};

function assertNever(value: never): never {
  throw new Error(`Unhandled library kind: ${String(value)}`);
}

export function treeProfileFor(kind: FileTreeKind): TreeProfile {
  switch (kind) {
    case "video":
      return VIDEO_PROFILE;
    case "audio":
      return AUDIO_PROFILE;
    case "photos":
      return PHOTOS_PROFILE;
    default:
      return assertNever(kind);
  }
}
