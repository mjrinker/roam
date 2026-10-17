/**
 * A small audio fingerprint for finding the stretch two episodes share (their opening titles, their closing credits). Mono audio at 8 kHz is
 * cut into overlapping frames; each frame's energy in 33 bands (300 Hz to 3.4 kHz, spaced like hearing) becomes 32 bits by whether the
 * difference between neighbouring bands grew or shrank since the frame before (Haitsma and Kalker's scheme). Volume, a voice laid over the
 * music, or a different encode change a few bits; the same music gives mostly the same bits, unrelated sound agrees about half the time.
 * Pure number crunching, so it is tested with made-up sound.
 */

export const SAMPLE_RATE = 8000;
/** FFT window and step: a frame is half a second, and a new one starts every quarter of a second. */
export const FRAME_SIZE = 4096;
export const HOP = 2048;
export const FRAME_SECONDS = HOP / SAMPLE_RATE;
const BANDS = 33;
const LOW_HZ = 300;
const HIGH_HZ = 3400;

/** In-place radix-2 FFT of `re`/`im` (length a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1;
      let cIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tRe = re[b] * cRe - im[b] * cIm;
        const tIm = re[b] * cIm + im[b] * cRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
}

/** The FFT bin where each band starts (BANDS + 1 edges), log-spaced between LOW_HZ and HIGH_HZ. */
function bandEdges(): number[] {
  const binHz = SAMPLE_RATE / FRAME_SIZE;
  const edges: number[] = [];
  for (let b = 0; b <= BANDS; b++) edges.push(Math.round((LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, b / BANDS)) / binHz));
  // Every band gets at least one bin.
  for (let b = 1; b < edges.length; b++) if (edges[b] <= edges[b - 1]) edges[b] = edges[b - 1] + 1;
  return edges;
}
const EDGES = bandEdges();
const HANN = Float64Array.from({ length: FRAME_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1)));

/** How many start positions, a fraction of a frame apart, an episode is fingerprinted at, so two copies of the same sound line up whatever their offset. */
export const PHASES = 4;

/** The samples from `n` on (a view, not a copy, for typed arrays). */
function offsetBy(samples: ArrayLike<number>, n: number): ArrayLike<number> {
  const typed = samples as { subarray?: (start: number) => ArrayLike<number> };
  return typed.subarray ? typed.subarray(n) : Array.prototype.slice.call(samples, n);
}

/** The fingerprint of the audio starting at each of PHASES evenly spaced points within one step (the first is the plain fingerprint). */
export function fingerprintPhases(samples: ArrayLike<number>, phases = PHASES): Uint32Array[] {
  const step = Math.floor(HOP / phases);
  return Array.from({ length: phases }, (_, p) => fingerprint(p === 0 ? samples : offsetBy(samples, p * step)));
}

/** One 32-bit value per quarter second of audio (`samples` mono at SAMPLE_RATE; any numeric array). */
export function fingerprint(samples: ArrayLike<number>): Uint32Array {
  const frames = samples.length < FRAME_SIZE ? 0 : Math.floor((samples.length - FRAME_SIZE) / HOP) + 1;
  const out = new Uint32Array(Math.max(0, frames - 1));
  const re = new Float64Array(FRAME_SIZE);
  const im = new Float64Array(FRAME_SIZE);
  let prev: Float64Array | null = null;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < FRAME_SIZE; i++) {
      re[i] = samples[f * HOP + i] * HANN[i];
      im[i] = 0;
    }
    fft(re, im);
    const energy = new Float64Array(BANDS);
    for (let b = 0; b < BANDS; b++) {
      let e = 0;
      for (let k = EDGES[b]; k < EDGES[b + 1]; k++) e += re[k] * re[k] + im[k] * im[k];
      energy[b] = e;
    }
    if (prev) {
      let bits = 0;
      for (let b = 0; b < 32; b++) {
        const now = energy[b] - energy[b + 1];
        const before = prev[b] - prev[b + 1];
        if (now - before > 0) bits |= 1 << b;
      }
      out[f - 1] = bits >>> 0;
    }
    prev = energy;
  }
  return out;
}

/** How many bits are set in a 32-bit value. */
export function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24) & 0xff;
}
