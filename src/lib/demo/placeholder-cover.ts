/** A plain generated cover (a coloured card with the title and author) for placeholder books, drawn with sharp. No artwork of any real book is used. */

const PALETTE = [
  ["#1f3b2d", "#0d1b14"],
  ["#3b2a1f", "#1b120d"],
  ["#1f2f3b", "#0d151b"],
  ["#3b1f2f", "#1b0d15"],
  ["#2f3b1f", "#151b0d"],
  ["#2d1f3b", "#140d1b"],
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Splits a title into lines of at most `max` characters, at spaces (a word longer than that stays whole). */
export function wrapTitle(title: string, max = 16): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of title.split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > max) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 6);
}

export function coverSvg(title: string, author: string, width = 600, height = 900): string {
  const hash = [...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const [top, bottom] = PALETTE[hash % PALETTE.length];
  const lines = wrapTitle(title);
  const size = lines.length > 4 ? 44 : 56;
  const start = 330 - ((lines.length - 1) * size * 1.2) / 2;
  const text = lines.map((l, i) => `<text x="${width / 2}" y="${start + i * size * 1.2}" text-anchor="middle" font-family="DejaVu Serif, serif" font-size="${size}" fill="#efe6cf">${esc(l)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
<rect width="${width}" height="${height}" fill="url(#g)"/><rect x="28" y="28" width="${width - 56}" height="${height - 56}" fill="none" stroke="#c9b27c" stroke-width="3"/>
${text}<text x="${width / 2}" y="${height - 150}" text-anchor="middle" font-family="DejaVu Serif, serif" font-size="30" fill="#c9b27c">${esc(author)}</text>
<text x="${width / 2}" y="${height - 70}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="20" letter-spacing="4" fill="#8a8a8a">PLACEHOLDER FILE</text></svg>`;
}

export async function renderCoverPng(title: string, author: string): Promise<Uint8Array> {
  const sharp = (await import("sharp")).default;
  return new Uint8Array(await sharp(Buffer.from(coverSvg(title, author))).png({ compressionLevel: 9 }).toBuffer());
}
