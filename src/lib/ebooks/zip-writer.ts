/** Writes ZIP files (stored or deflated, with real CRC-32s) for the EPUBs the demo seeding script builds. Nothing here reads untrusted input. */
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipFileToWrite {
  name: string;
  data: string | Uint8Array;
  /** Stored files are not compressed (an EPUB's "mimetype" must be). Default: deflate. */
  store?: boolean;
}

const enc = new TextEncoder();
const u16 = (n: number) => [n & 255, (n >> 8) & 255];
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

export function writeZip(files: ZipFileToWrite[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: number[] = [];
  let length = 0;
  const push = (...chunks: (number[] | Uint8Array)[]) => {
    for (const c of chunks) {
      const u = Uint8Array.from(c);
      parts.push(u);
      length += u.length;
    }
  };
  for (const f of files) {
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const method = f.store ? 0 : 8;
    const body = f.store ? data : deflateRawSync(data);
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const offset = length;
    // bit 11 of the flags: the name is UTF-8
    push([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(method), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(body.length), ...u32(data.length), ...u16(name.length), ...u16(0)], name, body);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(method), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(body.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name);
  }
  const dirOffset = length;
  push(central, [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(central.length), ...u32(dirOffset), ...u16(0)]);
  return Buffer.concat(parts);
}
