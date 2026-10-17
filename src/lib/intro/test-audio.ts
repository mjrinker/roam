/** Made-up sound for testing intro detection: music from a seed (the same seed, the same tune), dialogue-like noise, and ways to alter them. */
import { SAMPLE_RATE } from "./fingerprint";

/** A repeatable source of numbers (mulberry32). */
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTES = [220, 261.6, 293.7, 329.6, 392, 440, 523.3, 587.3, 659.3, 784];

/** `seconds` of made-up music: a new note every half second, with overtones, from a seed (the same seed, the same tune). */
export function music(seed: number, seconds: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let start = 0; start < out.length; start += SAMPLE_RATE / 2) {
    const f = NOTES[Math.floor(r() * NOTES.length)] * (r() < 0.3 ? 2 : 1);
    const g = NOTES[Math.floor(r() * NOTES.length)];
    for (let i = start; i < Math.min(out.length, start + SAMPLE_RATE / 2); i++) {
      const t = i / SAMPLE_RATE;
      out[i] = 0.5 * Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * g * t) + 0.1 * Math.sin(6 * Math.PI * f * t);
    }
  }
  return out;
}

/** Dialogue-like stuff: bursts of filtered noise and quiet, from a seed. */
export function talk(seed: number, seconds: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let level = 0;
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    if (i % 2000 === 0) level = r() < 0.7 ? 0.2 + 0.6 * r() : 0.02;
    lp = 0.7 * lp + 0.3 * (r() * 2 - 1);
    out[i] = level * lp * 2;
  }
  return out;
}

export const concat = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
export const scaled = (x: Float32Array, gain: number): Float32Array => x.map((v) => v * gain);
export const withNoise = (x: Float32Array, level: number, seed: number): Float32Array => {
  const r = rng(seed);
  return x.map((v) => v + level * (r() * 2 - 1));
};

