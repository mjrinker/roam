/** Builds small ZIP files for tests (store or deflate), plus helpers to serve them as byte ranges. */
import { deflateRawSync } from "node:zlib";

export interface TestZipFile {
  name: string;
  data: string | Uint8Array;
  method?: 0 | 8;
  flags?: number;
}

const enc = new TextEncoder();
const u16 = (n: number) => [n & 255, (n >> 8) & 255];
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

export function buildZip(files: TestZipFile[], comment = ""): Uint8Array {
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
    const method = f.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = enc.encode(f.name);
    const offset = length;
    push([...u32(0x04034b50), ...u16(20), ...u16(f.flags ?? 0), ...u16(method), ...u16(0), ...u16(0), ...u32(0), ...u32(body.length), ...u32(data.length), ...u16(name.length), ...u16(0)], name, body);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(f.flags ?? 0), ...u16(method), ...u16(0), ...u16(0), ...u32(0), ...u32(body.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name);
  }
  const dirOffset = length;
  const c = enc.encode(comment);
  push(central, [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(central.length), ...u32(dirOffset), ...u16(c.length)], c);
  return Buffer.concat(parts);
}

export const rangeOfBytes = (b: Uint8Array) => async (start: number, end: number) => b.slice(start, Math.min(end, b.length - 1) + 1);
