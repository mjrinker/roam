import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import { linkUrl, qrSvg } from "./qr";

/** Draws the SVG to pixels and reads it back with an independent QR decoder, the way a phone camera would. */
async function decode(svg: string): Promise<string | null> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(Buffer.from(svg.replace(/<svg class="qr" /, '<svg width="400" height="400" ')), { density: 96 }).resize(400, 400).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}

describe("QR codes for the TV sign-in screen", () => {
  it("scan back to the link with the TV's code filled in", async () => {
    const url = linkUrl("https://roam-three-gray.vercel.app", "ABCDE");
    expect(url).toBe("https://roam-three-gray.vercel.app/link?code=ABCDE");
    expect(await decode(await qrSvg(url))).toBe(url);
  });
  it("are drawn in black on white with a quiet border, sized by CSS", async () => {
    const svg = await qrSvg("https://x.example/link?code=ABCDE");
    expect(svg).toMatch(/^<svg class="qr" /);
    expect(svg).not.toMatch(/ (width|height)="\d+"/);
    expect(svg).toContain("#ffffff");
  });
  it("encodes a code with characters that need escaping", () => {
    expect(linkUrl("https://x.example", "A B&C")).toBe("https://x.example/link?code=A%20B%26C");
  });
});
