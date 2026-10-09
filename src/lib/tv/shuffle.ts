/**
 * A shuffle that comes out the same every time for the same seed, so the "next song" of a shuffled album is the same whether the
 * TV loads a page per song or plays them in one page: the seed rides along in the address.
 */

/** A small seeded random number generator (mulberry32): 0 <= value < 1. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A copy of `items` in the order this seed gives (Fisher-Yates). */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const next = generator(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A shuffle seed from the address, or null when it isn't one (a positive whole number below 2^31). */
export function parseSeed(raw: string | null | undefined): number | null {
  if (!raw || !/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && n < 2 ** 31 ? n : null;
}

/** A fresh seed for a new shuffle. */
export const newSeed = (): number => 1 + Math.floor(Math.random() * (2 ** 31 - 2));
