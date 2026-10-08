/** A QR code as an inline SVG string, so a phone's camera can open a link without anyone typing on a TV remote. */
import QRCode from "qrcode";

export async function qrSvg(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
  // Sized by CSS (rem) so it scales with the page; the library's own width/height attributes would fix it in pixels.
  return svg.replace(/<svg /, '<svg class="qr" ').replace(/ (width|height)="\d+"/g, "");
}

/** The link the QR code opens on the phone: the sign-in page with the TV's code filled in. */
export const linkUrl = (origin: string, userCode: string): string => `${origin}/link?code=${encodeURIComponent(userCode)}`;
