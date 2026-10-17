/** Listening to part of an episode: ffmpeg reads just that stretch of the (remote) file and hands back mono 8 kHz sound. */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { SAMPLE_RATE } from "./fingerprint";

/** ffmpeg's arguments to write `seconds` of audio from `startSeconds` as raw 16-bit mono at SAMPLE_RATE to its standard output. */
export function pcmArgs(input: string, startSeconds: number, seconds: number): string[] {
  return ["-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, startSeconds)), "-t", String(seconds), "-i", input, "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1"];
}

/** Raw little-endian 16-bit sound as numbers from -1 to 1. */
export function pcmToFloat(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

type Spawn = (cmd: string, args: string[], opts: { stdio: ["ignore", "pipe", "pipe"] }) => Pick<ChildProcess, "stdout" | "stderr" | "on" | "kill">;

/** The sound of a stretch of a file, or null when ffmpeg could not read it (it is given a time to finish, then stopped). */
export function decodeAudio(ffmpeg: string, input: string, startSeconds: number, seconds: number, opts: { timeoutMs?: number; spawn?: Spawn } = {}): Promise<Float32Array | null> {
  const spawn = opts.spawn ?? (nodeSpawn as unknown as Spawn);
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, pcmArgs(input, startSeconds, seconds), { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (value: Float32Array | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, opts.timeoutMs ?? 180_000);
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.stderr?.on("data", () => undefined);
    child.on("error", () => finish(null));
    child.on("close", (code: number | null) => {
      const bytes = Buffer.concat(chunks);
      // A stretch past the end of a short file comes back short; that is fine, but nothing at all is a failure.
      finish(code === 0 && bytes.length >= SAMPLE_RATE * 2 ? pcmToFloat(bytes) : null);
    });
  });
}
