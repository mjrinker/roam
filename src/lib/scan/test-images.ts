/** Builds small but real image files (JPEG with EXIF, PNG, GIF, WebP, HEIC) for tests. Not used by app code. */
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const chars = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));

export interface TiffOptions {
  little?: boolean;
  orientation?: number;
  dateTimeOriginal?: string;
  dateTimeDigitized?: string;
  dateTime?: string;
  pixelX?: number;
  pixelY?: number;
  /** Entries to add to IFD0 as-is (hostile cases). */
  rawIfd0?: { tag: number; type: number; count: number; value: number }[];
}

type Entry = { tag: number; type: number; count: number; inline?: number[]; data?: number[] };

/** A TIFF block: header, IFD0 (orientation, DateTime, pointer to the Exif IFD), the Exif IFD (dates, pixel sizes), and the string data. */
export function buildTiff(o: TiffOptions = {}): number[] {
  const little = o.little ?? true;
  const w16 = little ? le16 : be16;
  const w32 = little ? le32 : be32;
  const asciiData = (s: string) => [...chars(s), 0];

  const exifEntries: Entry[] = [];
  if (o.dateTimeOriginal !== undefined) exifEntries.push({ tag: 0x9003, type: 2, count: o.dateTimeOriginal.length + 1, data: asciiData(o.dateTimeOriginal) });
  if (o.dateTimeDigitized !== undefined) exifEntries.push({ tag: 0x9004, type: 2, count: o.dateTimeDigitized.length + 1, data: asciiData(o.dateTimeDigitized) });
  if (o.pixelX !== undefined) exifEntries.push({ tag: 0xa002, type: 4, count: 1, inline: w32(o.pixelX) });
  if (o.pixelY !== undefined) exifEntries.push({ tag: 0xa003, type: 4, count: 1, inline: w32(o.pixelY) });

  const ifd0: Entry[] = [];
  if (o.orientation !== undefined) ifd0.push({ tag: 0x0112, type: 3, count: 1, inline: [...w16(o.orientation), 0, 0] });
  if (o.dateTime !== undefined) ifd0.push({ tag: 0x0132, type: 2, count: o.dateTime.length + 1, data: asciiData(o.dateTime) });
  for (const r of o.rawIfd0 ?? []) ifd0.push({ tag: r.tag, type: r.type, count: r.count, inline: w32(r.value) });
  const hasExif = exifEntries.length > 0;
  if (hasExif) ifd0.push({ tag: 0x8769, type: 4, count: 1, inline: [0, 0, 0, 0] }); // pointer patched below
  ifd0.sort((a, b) => a.tag - b.tag);

  const size = (n: number) => 2 + 12 * n + 4;
  const ifd0At = 8;
  const exifAt = ifd0At + size(ifd0.length);
  let dataAt = exifAt + (hasExif ? size(exifEntries.length) : 0);
  const data: number[] = [];
  const serialize = (entries: Entry[]) => {
    const out = [...w16(entries.length)];
    for (const e of entries) {
      out.push(...w16(e.tag), ...w16(e.type), ...w32(e.count));
      if (e.data) {
        if (e.data.length <= 4) out.push(...e.data, ...new Array(4 - e.data.length).fill(0));
        else {
          out.push(...w32(dataAt + data.length));
          data.push(...e.data);
        }
      } else out.push(...(e.inline ?? [0, 0, 0, 0]));
    }
    out.push(0, 0, 0, 0); // no next IFD
    return out;
  };
  for (const e of ifd0) if (e.tag === 0x8769) e.inline = w32(exifAt);
  const ifd0Bytes = serialize(ifd0);
  const exifBytes = hasExif ? serialize(exifEntries) : [];
  dataAt = exifAt + exifBytes.length; // (unchanged value; recomputed for clarity)
  return [...(little ? [0x49, 0x49, 42, 0] : [0x4d, 0x4d, 0, 42]), ...w32(ifd0At), ...ifd0Bytes, ...exifBytes, ...data];
}

const segment = (marker: number, body: number[]) => [0xff, marker, ...be16(body.length + 2), ...body];

export interface JpegOptions {
  width?: number;
  height?: number;
  /** TIFF bytes to wrap in an Exif APP1 (undefined = none). */
  tiff?: number[];
  /** Segments placed before the Exif one (an ICC profile, XMP...). */
  before?: number[][];
  progressive?: boolean;
}

export function buildJpeg(o: JpegOptions = {}): Uint8Array {
  const out: number[] = [0xff, 0xd8, ...segment(0xe0, [...chars("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])];
  for (const s of o.before ?? []) out.push(...s);
  if (o.tiff) out.push(...segment(0xe1, [...chars("Exif"), 0, 0, ...o.tiff]));
  out.push(...segment(o.progressive ? 0xc2 : 0xc0, [8, ...be16(o.height ?? 30), ...be16(o.width ?? 40), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  out.push(...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]), 1, 2, 3, 4, 0xff, 0xd9);
  return Uint8Array.from(out);
}

export const buildPng = (width: number, height: number): Uint8Array =>
  Uint8Array.from([0x89, ...chars("PNG"), 13, 10, 26, 10, ...be32(13), ...chars("IHDR"), ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0, ...be32(0), ...chars("IEND")]);

export const buildGif = (width: number, height: number): Uint8Array => Uint8Array.from([...chars("GIF89a"), ...le16(width), ...le16(height), 0, 0, 0, 0, 0, 0]);

export function buildWebp(kind: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Uint8Array {
  let payload: number[];
  if (kind === "VP8 ") payload = [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0, 0, 0];
  else if (kind === "VP8L") payload = [0x2f, ...le32((width - 1) | ((height - 1) << 14)), 0, 0, 0, 0];
  else payload = [0, 0, 0, 0, (width - 1) & 255, ((width - 1) >> 8) & 255, ((width - 1) >> 16) & 255, (height - 1) & 255, ((height - 1) >> 8) & 255, ((height - 1) >> 16) & 255, 0, 0];
  return Uint8Array.from([...chars("RIFF"), ...le32(4 + 8 + payload.length), ...chars("WEBP"), ...chars(kind), ...le32(payload.length), ...payload]);
}

const box = (type: string, payload: number[]) => [...be32(8 + payload.length), ...chars(type), ...payload];
const fullBox = (type: string, version: number, flags: number, payload: number[]) => box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255, ...payload]);

export interface HeicOptions {
  width?: number;
  height?: number;
  /** 0-3 quarter turns (irot). */
  rotate?: number;
  /** TIFF bytes for an Exif item (undefined = no Exif item). */
  tiff?: number[];
  /** Bytes between the end of `meta` and the Exif item (so the Exif lies beyond a small first read). */
  gap?: number;
  /** Where the Exif item says its data is: 0 = in the file (normal), 1 = inside the meta box (an iloc version 1 construction method we don't follow). */
  constructionMethod?: number;
  /** Bytes the Exif item says to skip before the TIFF header (normally 6, the "Exif\0\0" marker). */
  exifSkip?: number;
  /** Extra ispe-bearing tile properties placed BEFORE the primary's, to prove the primary item's size is the one used. */
  decoyTile?: boolean;
}

export function buildHeic(o: HeicOptions = {}): Uint8Array {
  const width = o.width ?? 4032;
  const height = o.height ?? 3024;
  const ftyp = box("ftyp", [...chars("heic"), 0, 0, 0, 0, ...chars("mif1"), ...chars("heic")]);
  const skip = o.exifSkip ?? 6;
  const exifItem = o.tiff ? [...be32(skip), ...(skip === 6 ? [...chars("Exif"), 0, 0] : new Array(skip).fill(0)), ...o.tiff] : [];
  const infes = [fullBox("infe", 2, 0, [...be16(1), 0, 0, ...chars("hvc1"), 0]), ...(o.tiff ? [fullBox("infe", 2, 0, [...be16(2), 0, 0, ...chars("Exif"), 0])] : [])];
  const iinf = fullBox("iinf", 0, 0, [...be16(infes.length), ...infes.flat()]);
  const props: number[][] = [];
  if (o.decoyTile) props.push(fullBox("ispe", 0, 0, [...be32(512), ...be32(512)]));
  props.push(fullBox("ispe", 0, 0, [...be32(width), ...be32(height)]));
  if (o.rotate !== undefined) props.push(box("irot", [o.rotate]));
  const primaryProps = o.decoyTile ? [2, ...(o.rotate !== undefined ? [3] : [])] : [1, ...(o.rotate !== undefined ? [2] : [])];
  const ipco = box("ipco", props.flat());
  const ipma = fullBox("ipma", 0, 0, [...be32(1), ...be16(1), primaryProps.length, ...primaryProps]);
  const iprp = box("iprp", [...ipco, ...ipma]);
  const pitm = fullBox("pitm", 0, 0, be16(1));
  // iloc v0: sizes (offset 4, length 4, base 0), item count, then per item: id, data reference (0), extent count (1), offset, length.
  const ilocFor = (offset: number) =>
    o.constructionMethod !== undefined
      ? // version 1: each item also carries a construction method
        fullBox("iloc", 1, 0, [0x44, 0x00, ...be16(2), ...be16(1), 0, 0, 0, 0, 0, 1, ...be32(0), ...be32(10), ...be16(2), 0, o.constructionMethod, 0, 0, 0, 1, ...be32(offset), ...be32(exifItem.length)])
      : fullBox("iloc", 0, 0, [0x44, 0x00, ...be16(o.tiff ? 2 : 1), ...be16(1), 0, 0, 0, 1, ...be32(0), ...be32(10), ...(o.tiff ? [...be16(2), 0, 0, 0, 1, ...be32(offset), ...be32(exifItem.length)] : [])]);
  const metaFor = (offset: number) => fullBox("meta", 0, 0, [...pitm, ...iinf, ...ilocFor(offset), ...iprp]);
  const metaSize = metaFor(0).length;
  const free = o.gap ? box("free", new Array(Math.max(0, o.gap - 8)).fill(0)) : [];
  const exifOffset = ftyp.length + metaSize + free.length + 8; // after the mdat header
  const meta = metaFor(exifOffset);
  const mdat = box("mdat", exifItem);
  return Uint8Array.from([...ftyp, ...meta, ...free, ...mdat]);
}

export const rangeOfBytes = (bytes: Uint8Array) => async (start: number, end: number): Promise<ArrayBuffer> => {
  const slice = bytes.slice(start, Math.min(end + 1, bytes.length));
  return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer;
};
