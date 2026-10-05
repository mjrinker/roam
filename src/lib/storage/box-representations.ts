/**
 * Pure helpers for Box "representations" (generated previews, such as a 2048px JPEG of a photo or
 * HEIC): which entry of a file's representation list to use, which URL to fetch it from, and the safety
 * checks around handing Box credentials to a URL that came out of a Box response. No network here.
 */

export interface RepresentationEntryLike {
  content?: { urlTemplate?: string };
  info?: { url?: string };
  status?: { state?: string };
  properties?: { dimensions?: string };
}

/** Box and its content hosts. A credential is only ever sent to one of these, over https. */
export function isBoxHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return host === "box.com" || host.endsWith(".box.com") || host === "boxcloud.com" || host.endsWith(".boxcloud.com");
  } catch {
    return false;
  }
}

export type RepresentationPlan =
  /** Ready: fetch this URL. */
  | { action: "fetch"; url: string }
  /** Box makes it when asked: request `url` once to start generation, then check again. */
  | { action: "trigger"; url: string }
  /** Being generated: check again shortly. */
  | { action: "wait" }
  /** Not available (an error state, no entry, or a URL that isn't Box's). */
  | { action: "none" };

/** What to do next given the entry Box returned for the requested representation. */
export function planRepresentation(entry: RepresentationEntryLike | undefined): RepresentationPlan {
  if (!entry) return { action: "none" };
  const state = entry.status?.state;
  if (state === "success") {
    const template = entry.content?.urlTemplate;
    if (!template) return { action: "none" };
    // An unpaged representation (an image) takes an empty asset path.
    const url = template.replace("{+asset_path}", "");
    return isBoxHost(url) ? { action: "fetch", url } : { action: "none" };
  }
  if (state === "none") {
    const url = entry.info?.url;
    return url && isBoxHost(url) ? { action: "trigger", url } : { action: "none" };
  }
  if (state === "pending") return { action: "wait" };
  return { action: "none" };
}

/** True when the bytes start like a JPEG: the only thing a preview is allowed to be. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Reads a byte stream into memory, giving up (null) the moment it exceeds `maxBytes`, so a response
 * that is much bigger than a preview can ever be is never buffered whole.
 */
export async function readCapped(stream: AsyncIterable<unknown>, maxBytes: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as ArrayBuffer);
    total += buf.length;
    if (total > maxBytes) {
      (stream as { destroy?: () => void }).destroy?.();
      return null;
    }
    chunks.push(buf);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
