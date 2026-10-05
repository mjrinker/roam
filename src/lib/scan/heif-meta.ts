/**
 * A bounded reader for the boxes of a HEIC/HEIF photo: how big the main picture is (after its stored
 * rotation) and where its EXIF data sits. Only the fixed path is followed (meta > pitm/iinf/iloc/iprp >
 * ipco/ipma), box and item counts are capped, every size is checked against the bytes actually read, and
 * a box that can't make progress ends the walk. Throws nothing: whatever can't be read safely is null.
 */
import { validDimension } from "@/lib/scan/exif";

export interface HeifInfo {
  width: number | null;
  height: number | null;
  /** Where the EXIF item's bytes are in the FILE (it usually lies beyond the part we read first). */
  exif: { offset: number; length: number } | null;
}

export const EXIF_ITEM_MAX = 256 * 1024;
const MAX_BOXES = 256;
const MAX_ITEMS = 8192;
const BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

class Short extends Error {}

class Reader {
  private dv: DataView;
  constructor(readonly buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(o: number, n: number) {
    if (!Number.isInteger(o) || o < 0 || o + n > this.buf.length) throw new Short();
  }
  u8(o: number) {
    this.need(o, 1);
    return this.buf[o];
  }
  u16(o: number) {
    this.need(o, 2);
    return this.dv.getUint16(o);
  }
  u32(o: number) {
    this.need(o, 4);
    return this.dv.getUint32(o);
  }
  /** An unsigned integer of 0, 4 or 8 bytes; one that doesn't fit exactly in a double is refused. */
  uN(o: number, n: number): number {
    if (n === 0) return 0;
    if (n === 4) return this.u32(o);
    if (n === 8) {
      this.need(o, 8);
      const v = this.dv.getBigUint64(o);
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Short();
      return Number(v);
    }
    throw new Short();
  }
  fourcc(o: number) {
    this.need(o, 4);
    return String.fromCharCode(this.buf[o], this.buf[o + 1], this.buf[o + 2], this.buf[o + 3]);
  }
}

interface Box {
  type: string;
  payload: number;
  end: number;
}

/** The boxes in [from, to): always makes progress, stops at a malformed header, clamps a truncated box to what we have. */
function* boxes(r: Reader, from: number, to: number): Generator<Box> {
  let off = from;
  for (let n = 0; n < MAX_BOXES && off + 8 <= to; n++) {
    let size = r.u32(off);
    const type = r.fourcc(off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > to) return;
      size = r.uN(off + 8, 8);
      header = 16;
    } else if (size === 0) {
      size = to - off;
    }
    if (size < header) return;
    yield { type, payload: off + header, end: Math.min(off + size, to) };
    off += size;
  }
}

export function parseHeif(buf: Uint8Array): HeifInfo {
  const none: HeifInfo = { width: null, height: null, exif: null };
  try {
    const r = new Reader(buf);
    const top = [...boxes(r, 0, buf.length)];
    const ftyp = top.find((b) => b.type === "ftyp");
    if (!ftyp) return none;
    const brands = [r.fourcc(ftyp.payload)];
    for (let o = ftyp.payload + 8; o + 4 <= ftyp.end && brands.length < 32; o += 4) brands.push(r.fourcc(o));
    if (!brands.some((b) => BRANDS.has(b))) return none;

    const meta = top.find((b) => b.type === "meta");
    if (!meta) return none;
    const kids = [...boxes(r, meta.payload + 4, meta.end)]; // meta is a "full" box: 4 bytes of version/flags first
    const kid = (type: string) => kids.find((b) => b.type === type);

    // The primary item, and which item is the EXIF block.
    const pitm = kid("pitm");
    const primary = pitm ? (r.u8(pitm.payload) === 0 ? r.u16(pitm.payload + 4) : r.u32(pitm.payload + 4)) : null;

    let exifItem: number | null = null;
    const iinf = kid("iinf");
    if (iinf) {
      const v = r.u8(iinf.payload);
      for (const b of boxes(r, iinf.payload + 4 + (v === 0 ? 2 : 4), iinf.end)) {
        if (b.type !== "infe") continue;
        const ver = r.u8(b.payload);
        if (ver < 2) continue;
        let p = b.payload + 4;
        const id = ver === 2 ? r.u16(p) : r.u32(p);
        p += ver === 2 ? 2 : 4;
        if (r.fourcc(p + 2) === "Exif") {
          exifItem = id;
          break;
        }
      }
    }

    let exif: HeifInfo["exif"] = null;
    const iloc = kid("iloc");
    if (iloc && exifItem !== null) exif = locate(r, iloc, exifItem);

    // The primary picture's size: its `ispe`, turned by its `irot`.
    let width: number | null = null;
    let height: number | null = null;
    const iprp = kid("iprp");
    if (iprp && primary !== null) {
      const inner = [...boxes(r, iprp.payload, iprp.end)];
      const ipco = inner.find((b) => b.type === "ipco");
      const ipma = inner.find((b) => b.type === "ipma");
      if (ipco && ipma) {
        const props = [...boxes(r, ipco.payload, ipco.end)];
        const indexes = associations(r, ipma, primary);
        let turns = 0;
        for (const index of indexes) {
          const p = props[index - 1];
          if (!p) continue;
          if (p.type === "ispe" && width === null) {
            const w = r.u32(p.payload + 4);
            const h = r.u32(p.payload + 8);
            if (validDimension(w) && validDimension(h)) {
              width = w;
              height = h;
            }
          } else if (p.type === "irot") {
            turns = r.u8(p.payload) & 3;
          }
        }
        if (turns % 2 === 1 && width !== null && height !== null) [width, height] = [height, width];
      }
    }
    return { width, height, exif };
  } catch {
    return none;
  }
}

/** The property indexes (1-based into `ipco`) associated with `item`. */
function associations(r: Reader, ipma: Box, item: number): number[] {
  const version = r.u8(ipma.payload);
  const wide = (r.u32(ipma.payload) & 1) === 1; // flags bit 0: 16-bit property indexes
  const count = r.u32(ipma.payload + 4);
  let p = ipma.payload + 8;
  for (let i = 0; i < Math.min(count, MAX_ITEMS); i++) {
    const id = version < 1 ? r.u16(p) : r.u32(p);
    p += version < 1 ? 2 : 4;
    const n = r.u8(p++);
    const found: number[] = [];
    for (let k = 0; k < n; k++) {
      const v = wide ? r.u16(p) : r.u8(p);
      p += wide ? 2 : 1;
      found.push(v & (wide ? 0x7fff : 0x7f));
    }
    if (id === item) return found;
  }
  return [];
}

/** Where `item`'s bytes are (file offset, single extent, stored in the file itself), or null. */
function locate(r: Reader, iloc: Box, item: number): { offset: number; length: number } | null {
  const version = r.u8(iloc.payload);
  if (version > 2) return null;
  let p = iloc.payload + 4;
  const sizes = r.u8(p);
  const sizes2 = r.u8(p + 1);
  p += 2;
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 15;
  const baseSize = sizes2 >> 4;
  const indexSize = version > 0 ? sizes2 & 15 : 0;
  if (![0, 4, 8].includes(offsetSize) || ![0, 4, 8].includes(lengthSize) || ![0, 4, 8].includes(baseSize) || ![0, 4, 8].includes(indexSize)) return null;
  const count = version < 2 ? r.u16(p) : r.u32(p);
  p += version < 2 ? 2 : 4;
  for (let i = 0; i < Math.min(count, MAX_ITEMS); i++) {
    const id = version < 2 ? r.u16(p) : r.u32(p);
    p += version < 2 ? 2 : 4;
    let method = 0;
    if (version > 0) {
      method = r.u16(p) & 15;
      p += 2;
    }
    p += 2; // data_reference_index
    const base = r.uN(p, baseSize);
    p += baseSize;
    const extents = r.u16(p);
    p += 2;
    let first: { offset: number; length: number } | null = null;
    for (let k = 0; k < Math.min(extents, 64); k++) {
      p += indexSize;
      const offset = r.uN(p, offsetSize);
      p += offsetSize;
      const length = r.uN(p, lengthSize);
      p += lengthSize;
      if (k === 0) first = { offset: base + offset, length };
    }
    if (id !== item) continue;
    if (method !== 0 || extents !== 1 || !first) return null;
    if (first.length < 8 || first.length > EXIF_ITEM_MAX || !Number.isSafeInteger(first.offset)) return null;
    return first;
  }
  return null;
}

/** The TIFF data inside an Exif item: a 4-byte count of bytes to skip (usually "Exif\0\0"), then the TIFF header. */
export function tiffOfExifItem(item: Uint8Array): Uint8Array | null {
  if (item.length < 12) return null;
  const skip = new DataView(item.buffer, item.byteOffset, item.byteLength).getUint32(0);
  if (skip > 1024 || 4 + skip + 8 > item.length) return null;
  return item.subarray(4 + skip);
}
