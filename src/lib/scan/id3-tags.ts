/**
 * Descriptive tags from an MP3: title, artist, album, year and cover image, from the ID3v2 tag at the
 * start of the file (versions 2.2, 2.3 and 2.4), falling back to an ID3v1 tag at the end for anything
 * v2 didn't give.
 *
 * Written for files nobody trusts: the tag is read as ONE bounded prefix (at most MAX_TAG_BYTES, in a
 * single small request in the normal case) and parsed in memory, every declared size is checked against
 * what is actually there, frames are capped, a frame that is compressed, encrypted or inconsistent is
 * skipped rather than believed, and a malformed frame never costs the fields read before it. Only a
 * failed Box read throws.
 */
import type { ByteRangeFetcher } from "@/lib/scan/range-reader";
import { RangeReader } from "@/lib/scan/range-reader";
import { cleanTagString } from "@/lib/scan/tag-text";

/** The most tag bytes ever looked at, however large the tag claims to be. */
export const MAX_TAG_BYTES = 1024 * 1024;
const FIRST_WINDOW = 64 * 1024;
const MAX_FRAMES = 2048;
const MAX_COVER_BYTES = 256 * 1024;
const MAX_TEXT = 300;

export interface AudioTags {
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  cover: { contentType: "image/jpeg" | "image/png"; bytes: Uint8Array } | null;
}

const empty = (): AudioTags => ({ title: null, artist: null, album: null, year: null, cover: null });

// ── helpers ──────────────────────────────────────────────────────────────

const syncsafe = (b: Uint8Array, at: number) => ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);
const isSyncsafe = (b: Uint8Array, at: number) => (b[at] | b[at + 1] | b[at + 2] | b[at + 3]) < 0x80;
const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const be24 = (b: Uint8Array, at: number) => (b[at] << 16) | (b[at + 1] << 8) | b[at + 2];
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** Undoes unsynchronisation: every 0xFF 0x00 pair was stored with a 0x00 inserted after the 0xFF. */
function deUnsync(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

const clean = (text: string, max = MAX_TEXT): string | null => cleanTagString(text, max);

/** Decodes an ID3 text field to its values (a field may hold several, separated by NUL). */
function decodeText(b: Uint8Array, encoding: number): string[] {
  let text: string;
  if (encoding === 1 || encoding === 2) {
    let bytes = b;
    let le = false;
    if (encoding === 1 && b.length >= 2) {
      if (b[0] === 0xff && b[1] === 0xfe) {
        le = true;
        bytes = b.subarray(2);
      } else if (b[0] === 0xfe && b[1] === 0xff) {
        bytes = b.subarray(2);
      } else {
        le = false; // no BOM: big-endian, as the spec says for UTF-16BE and the usual guess otherwise
      }
    }
    text = new TextDecoder(le ? "utf-16le" : "utf-16be").decode(bytes);
  } else if (encoding === 3) {
    text = new TextDecoder("utf-8").decode(b);
  } else {
    text = new TextDecoder("windows-1252").decode(b); // ISO-8859-1 as people really wrote it
  }
  return text.split("\u0000").map((s) => s.trim()).filter(Boolean);
}

/** Index just past the terminator of a string starting at `from` (1 byte for encodings 0/3, 2 for 1/2), or -1. */
function skipTerminated(b: Uint8Array, from: number, encoding: number): number {
  if (encoding === 1 || encoding === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2;
    return -1;
  }
  const i = b.indexOf(0, from);
  return i === -1 ? -1 : i + 1;
}

function imageType(bytes: Uint8Array): "image/jpeg" | "image/png" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length > 8 && png.every((v, i) => bytes[i] === v)) return "image/png";
  return null;
}

const yearOf = (text: string): number | null => {
  const y = Number(/(\d{4})/.exec(text)?.[1]);
  return y >= 1888 && y <= 2100 ? y : null;
};

// ── frames ───────────────────────────────────────────────────────────────

interface Pic {
  type: number;
  contentType: "image/jpeg" | "image/png";
  bytes: Uint8Array;
}

/** A picture frame's payload: encoding, MIME (v2.2: 3-char format), picture type, description, then the image. */
function readPicture(body: Uint8Array, v22: boolean): Pic | null {
  if (body.length < 8) return null;
  const encoding = body[0];
  let at = 1;
  if (v22) at += 3;
  else {
    const end = body.indexOf(0, at);
    if (end === -1) return null;
    at = end + 1;
  }
  if (at >= body.length) return null;
  const type = body[at++];
  const after = skipTerminated(body, at, encoding);
  if (after === -1) return null;
  const bytes = body.subarray(after);
  if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) return null;
  // The declared MIME type is never trusted: only real JPEG/PNG bytes are accepted.
  const contentType = imageType(bytes);
  return contentType ? { type, contentType, bytes: bytes.slice() } : null;
}

const TEXT_IDS: Record<string, "title" | "artist" | "artist2" | "album" | "year"> = {
  TIT2: "title", TT2: "title",
  TPE1: "artist", TP1: "artist",
  TPE2: "artist2", TP2: "artist2",
  TALB: "album", TAL: "album",
  TDRC: "year", TYER: "year", TYE: "year",
};

function parseV2(
  tag: Uint8Array,
  version: number,
  out: AudioTags,
  scratch: { artist2: string | null; pic: Pic | null },
  /** 2.4 only: the tag header says every frame body was unsynchronised (2.2 and 2.3 de-unsynchronise the whole tag first). */
  allFramesUnsynced = false
) {
  const v22 = version === 2;
  const headerLen = v22 ? 6 : 10;
  let at = 0;
  for (let frames = 0; frames < MAX_FRAMES && at + headerLen <= tag.length; frames++) {
    if (tag[at] === 0) break; // padding: no more frames
    const id = ascii(tag, at, v22 ? 3 : 4);
    if (!/^[A-Z0-9]+$/.test(id)) break;

    let size: number;
    let flags = 0;
    if (v22) {
      size = be24(tag, at + 3);
    } else if (version === 4) {
      // 2.4 sizes are sync-safe, but some writers (old iTunes) used plain sizes: take the sync-safe reading
      // only if the frame after it starts where a frame should.
      const safe = isSyncsafe(tag, at + 4) ? syncsafe(tag, at + 4) : -1;
      const plain = be32(tag, at + 4);
      const startsFrame = (n: number) => {
        const next = at + 10 + n;
        return next + 4 <= tag.length && (tag[next] === 0 || /^[A-Z0-9]{4}$/.test(ascii(tag, next, 4)));
      };
      size = safe >= 0 && (startsFrame(safe) || !startsFrame(plain)) ? safe : plain;
      flags = (tag[at + 8] << 8) | tag[at + 9];
    } else {
      size = be32(tag, at + 4);
      flags = (tag[at + 8] << 8) | tag[at + 9];
    }
    const bodyStart = at + headerLen;
    if (size < 0 || bodyStart + size > tag.length) break; // claims more than is there: nothing after it can be trusted
    at = bodyStart + size;
    let body = tag.subarray(bodyStart, bodyStart + size);

    // Frames that are compressed or encrypted can't be read here; skip them (and, in 2.4, handle the
    // data-length-indicator and per-frame unsynchronisation flags).
    if (version === 3) {
      if (flags & 0x00c0) continue; // 2.3: compression 0x0080, encryption 0x0040
      if (flags & 0x0020) body = body.subarray(1); // grouping identity byte
    }
    if (version === 4) {
      if (flags & 0x000c) continue; // compression 0x0008, encryption 0x0004
      if (flags & 0x0040) body = body.subarray(1); // grouping identity byte
      if (flags & 0x0001) body = body.subarray(4); // data length indicator
      if (flags & 0x0002 || allFramesUnsynced) body = deUnsync(body);
    }

    const kind = TEXT_IDS[id];
    if (kind && body.length >= 2) {
      const values = decodeText(body.subarray(1), body[0]);
      if (values.length === 0) continue;
      if (kind === "year") {
        if (out.year === null) out.year = yearOf(values[0]);
      } else if (kind === "artist2") {
        scratch.artist2 ??= clean(values.join(", "));
      } else if (kind === "artist") {
        out.artist ??= clean(values.join(", "));
      } else {
        out[kind] ??= clean(values[0]);
      }
    } else if (id === "APIC" || id === "PIC") {
      const pic = readPicture(body, v22);
      // Prefer the front cover (type 3) over anything else; otherwise the first usable picture.
      if (pic && (scratch.pic === null || (pic.type === 3 && scratch.pic.type !== 3))) scratch.pic = pic;
    }
  }
}

function parseV1(tail: Uint8Array, out: AudioTags) {
  if (tail.length < 128 || ascii(tail, tail.length - 128, 3) !== "TAG") return;
  const base = tail.length - 128;
  const field = (from: number, n: number) => clean(new TextDecoder("windows-1252").decode(tail.subarray(base + from, base + from + n)).replace(/\u0000.*$/, ""));
  out.title ??= field(3, 30);
  out.artist ??= field(33, 30);
  out.album ??= field(63, 30);
  if (out.year === null) out.year = yearOf(field(93, 4) ?? "");
}

// ── entry point ──────────────────────────────────────────────────────────

/** Tags from an MP3's ID3v2 header (and ID3v1 trailer). Never throws for a malformed tag; only a failed read throws. */
export async function probeMp3Tags(fetchRange: ByteRangeFetcher, fileSizeBytes: number): Promise<AudioTags> {
  const r = new RangeReader(fetchRange, fileSizeBytes);
  const out = empty();
  const scratch: { artist2: string | null; pic: Pic | null } = { artist2: null, pic: null };

  const head = await r.read(0, 10, FIRST_WINDOW);
  const header = new Uint8Array(head.buffer, head.byteOffset, head.byteLength);
  if (header.length >= 10 && ascii(header, 0, 3) === "ID3" && (header[3] === 2 || header[3] === 3 || header[3] === 4) && isSyncsafe(header, 6)) {
    const version = header[3];
    const flags = header[5];
    const declared = syncsafe(header, 6);
    // Never read past what the tag claims, what the file has, or our own ceiling.
    const length = Math.min(declared, fileSizeBytes - 10, MAX_TAG_BYTES);
    if (length > 0) {
      // A failed Box read throws out of here (the caller's to handle); a malformed tag only ends what could be read.
      const view = await r.read(10, length, length);
      try {
        let tag = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
        // 2.2 and 2.3: the whole tag, frame headers included, is unsynchronised. 2.4: only the frame bodies
        // (frame sizes then count the stored bytes), handled per frame below.
        if (flags & 0x80 && version !== 4) tag = deUnsync(tag).slice();
        if (version === 2 && flags & 0x40) tag = new Uint8Array(0); // 2.2's compression flag: the format is undefined, skip the tag
        if (version !== 2 && flags & 0x40) {
          // Extended header: 2.3 stores its size plain (excluding itself), 2.4 sync-safe (including itself).
          const ext = version === 4 ? syncsafe(tag, 0) : be32(tag, 0) + 4;
          if (ext >= 4 && ext <= tag.length) tag = tag.subarray(ext);
        }
        parseV2(tag, version, out, scratch, version === 4 && (flags & 0x80) !== 0);
      } catch {
        // Malformed tag: keep whatever was read before the problem.
      }
    }
  }
  out.artist ??= scratch.artist2;
  if (scratch.pic) out.cover = { contentType: scratch.pic.contentType, bytes: scratch.pic.bytes };

  // ID3v1 fills in whatever the v2 tag didn't say.
  if (fileSizeBytes >= 128 && (out.title === null || out.artist === null || out.album === null || out.year === null)) {
    try {
      const tail = await r.read(fileSizeBytes - 128, 128, 128);
      parseV1(new Uint8Array(tail.buffer, tail.byteOffset, tail.byteLength), out);
    } catch (err) {
      // The v1 tag is only a fallback: failing to read it must not throw away what the v2 tag gave (a lost
      // Box connection still stops the scan, recognized by name so this module stays free of the database).
      if ((err as { name?: string } | null)?.name === "BoxReauthRequiredError") throw err;
    }
  }
  return out;
}
