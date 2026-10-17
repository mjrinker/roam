/**
 * Telling which photos are the same picture. Each photo gets a 64-bit "difference hash" of how it looks (a 9 by 8 grey miniature; each bit says whether
 * a pixel is darker than the one to its right), so a copy that was resized, re-saved or lightly edited gets nearly the same hash. Two photos are alike
 * when few bits differ. Pure, so it is tested with made-up miniatures.
 */

export const HASH_WIDTH = 9;
export const HASH_HEIGHT = 8;

/** The difference hash of a 9x8 greyscale miniature (72 values, row by row), as 16 hex digits. */
export function dHash(pixels: ArrayLike<number>): string {
  if (pixels.length !== HASH_WIDTH * HASH_HEIGHT) throw new Error("A miniature is 9 by 8");
  let hi = 0;
  let lo = 0;
  let bit = 0;
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      const on = pixels[y * HASH_WIDTH + x] < pixels[y * HASH_WIDTH + x + 1] ? 1 : 0;
      if (bit < 32) hi = ((hi << 1) | on) >>> 0;
      else lo = ((lo << 1) | on) >>> 0;
      bit++;
    }
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

const HEX = /^[0-9a-f]{16}$/;
export const isHash = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24) & 0xff;
}

/** How many of the 64 bits differ between two hashes. */
export function distance(a: string, b: string): number {
  const ah = parseInt(a.slice(0, 8), 16);
  const al = parseInt(a.slice(8), 16);
  const bh = parseInt(b.slice(0, 8), 16);
  const bl = parseInt(b.slice(8), 16);
  return popcount((ah ^ bh) >>> 0) + popcount((al ^ bl) >>> 0);
}

export interface Hashed {
  id: string;
  hash: string;
}

/** The 64 bits cut into `bands` pieces: two hashes within `bands - 1` bits of each other always agree exactly on at least one piece. */
function bandsOf(hash: string, bands: number): string[] {
  const bits = BigInt(`0x${hash}`).toString(2).padStart(64, "0");
  const size = Math.ceil(64 / bands);
  return Array.from({ length: bands }, (_, i) => `${i}:${bits.slice(i * size, (i + 1) * size)}`);
}

/**
 * Groups photos that are alike: any two within `maxDistance` bits are in one group (and so, through a chain, are the others), and only groups of
 * two or more are returned, biggest first. Uses the pigeonhole principle to avoid comparing every pair.
 */
export function groupAlike<T extends Hashed>(items: readonly T[], maxDistance: number): T[][] {
  const max = Math.max(0, Math.min(16, Math.floor(maxDistance)));
  const bands = max + 1;
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const buckets = new Map<string, number[]>();
  items.forEach((it, i) => {
    for (const key of bandsOf(it.hash, bands)) {
      const list = buckets.get(key);
      if (list) list.push(i);
      else buckets.set(key, [i]);
    }
  });
  const compared = new Set<number>();
  for (const members of buckets.values()) {
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const i = members[a];
        const j = members[b];
        const pair = i * items.length + j;
        if (compared.has(pair)) continue;
        compared.add(pair);
        if (find(i) !== find(j) && distance(items[i].hash, items[j].hash) <= max) parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, T[]>();
  items.forEach((it, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), it]));
  return [...groups.values()].filter((g) => g.length > 1).sort((x, y) => y.length - x.length);
}

export interface Candidate {
  id: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  takenAt: Date | null;
  name: string;
}

/** Which photo of a group to suggest keeping: the most pixels, else the biggest file, else the earliest, else the shortest name. */
export function suggestKeep<T extends Candidate>(group: readonly T[]): T {
  const pixels = (c: T) => (c.width ?? 0) * (c.height ?? 0);
  return [...group].sort(
    (a, b) =>
      pixels(b) - pixels(a) ||
      (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) ||
      (a.takenAt?.getTime() ?? Infinity) - (b.takenAt?.getTime() ?? Infinity) ||
      a.name.length - b.name.length ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id)
  )[0];
}
