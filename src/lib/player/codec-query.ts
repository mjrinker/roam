import { UNSUPPORTED_AUDIO_CODECS, VIDEO_CODEC_TESTS } from "@/lib/scan/codec-support";

let cached: string | null = null;

const isWebKit = (): boolean => /apple/i.test(navigator.vendor ?? "");

/**
 * Which of the known-problem audio and video codecs THIS browser can't decode, as the `unsupportedCodecs=ac-3,...` query parameter (empty when it
 * decodes them all). Tested per codec (Safari plays AC-3 but not DTS) and computed once; the server uses it to hand back a remuxed copy
 * of any file whose audio is one of them. Browser only.
 */
export function unsupportedCodecsParam(): string {
  if (cached === null) {
    const probe = document.createElement("video");
    const unsupported: string[] = UNSUPPORTED_AUDIO_CODECS.filter((codec) => !probe.canPlayType(`video/mp4; codecs="${codec}"`));
    for (const [token, full] of Object.entries(VIDEO_CODEC_TESTS)) {
      if (!probe.canPlayType(`video/mp4; codecs="${full}"`)) unsupported.push(token);
    }
    // Safari (every browser on iOS is Safari underneath) says it can play HEVC but won't start a file tagged hev1.
    if (isWebKit() && !unsupported.includes("hev1")) unsupported.push("hev1");
    cached = unsupported.length > 0 ? `unsupportedCodecs=${unsupported.join(",")}` : "";
  }
  return cached;
}
