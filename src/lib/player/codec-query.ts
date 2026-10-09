import { UNSUPPORTED_AUDIO_CODECS } from "@/lib/scan/codec-support";

let cached: string | null = null;

/**
 * Which of the known-problem audio codecs THIS browser can't decode, as the `unsupportedCodecs=ac-3,...` query parameter (empty when it
 * decodes them all). Tested per codec (Safari plays AC-3 but not DTS) and computed once; the server uses it to hand back a remuxed copy
 * of any file whose audio is one of them. Browser only.
 */
export function unsupportedCodecsParam(): string {
  if (cached === null) {
    const probe = document.createElement("video");
    const unsupported = UNSUPPORTED_AUDIO_CODECS.filter((codec) => !probe.canPlayType(`video/mp4; codecs="${codec}"`));
    cached = unsupported.length > 0 ? `unsupportedCodecs=${unsupported.join(",")}` : "";
  }
  return cached;
}
