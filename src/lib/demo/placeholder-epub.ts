/**
 * Builds a small, valid EPUB 3 whose metadata (title, author, series, year) is real but whose text is a stand-in, for the public
 * demo's books that cannot be shipped for real (they are still in copyright). The first page of every file says so plainly.
 */
import { writeZip } from "@/lib/ebooks/zip-writer";

export interface PlaceholderBook {
  title: string;
  author: string;
  /** Year the real book was first published. */
  year: number;
  series?: { name: string; position: number };
  /** A PNG. */
  cover: Uint8Array;
  /** The stand-in text, one paragraph per entry. */
  paragraphs: string[];
  /** Who wrote that text, shown on the first page. */
  textCredit: string;
  /** A stable identifier (a URN is built from it). */
  slug: string;
}

export const xmlEscape = (s: string): string =>
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const page = (title: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>${xmlEscape(title)}</title></head><body>${body}</body></html>`;

/** The notice on the first page of every placeholder book. */
export const placeholderNotice = (b: Pick<PlaceholderBook, "title" | "author" | "textCredit">) =>
  `This is a stand-in file. Roam's public demo lists ${b.author}'s books by their real titles, but the books are still in copyright and are not included. ` +
  `What follows instead is public-domain text (${b.textCredit}) so there is something to open and read. It is not "${b.title}".`;

export function buildPlaceholderEpub(b: PlaceholderBook): Uint8Array {
  const chapters: { id: string; title: string; body: string }[] = [{ id: "notice", title: "About this file", body: `<h1>About this file</h1><p>${xmlEscape(placeholderNotice(b))}</p>` }];
  const perChapter = 12;
  for (let i = 0, n = 1; i < b.paragraphs.length; i += perChapter, n++) {
    chapters.push({ id: `ch${n}`, title: `Chapter ${n}`, body: `<h1>Chapter ${n}</h1>` + b.paragraphs.slice(i, i + perChapter).map((p) => `<p>${xmlEscape(p)}</p>`).join("") });
  }
  const id = `urn:roam-demo:${b.slug}`;
  const series = b.series
    ? `<meta property="belongs-to-collection" id="series">${xmlEscape(b.series.name)}</meta><meta refines="#series" property="collection-type">series</meta><meta refines="#series" property="group-position">${b.series.position}</meta>` +
      `<meta name="calibre:series" content="${xmlEscape(b.series.name)}"/><meta name="calibre:series_index" content="${b.series.position}"/>`
    : "";
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${xmlEscape(id)}</dc:identifier><dc:title>${xmlEscape(b.title)}</dc:title><dc:creator>${xmlEscape(b.author)}</dc:creator><dc:language>en</dc:language>
<dc:publisher>Roam demo (placeholder file)</dc:publisher><dc:date>${b.year}</dc:date><dc:description>${xmlEscape(`Placeholder file for the Roam demo, not the book named. The real book was first published in ${b.year}.`)}</dc:description>
<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>${series}</metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>${chapters.map((c) => `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest>
<spine>${chapters.map((c) => `<itemref idref="${c.id}"/>`).join("")}</spine></package>`;
  const nav = page("Contents", `<nav epub:type="toc"><ol>${chapters.map((c) => `<li><a href="${c.id}.xhtml">${xmlEscape(c.title)}</a></li>`).join("")}</ol></nav>`);
  return writeZip([
    { name: "mimetype", data: "application/epub+zip", store: true },
    { name: "META-INF/container.xml", data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
    { name: "OEBPS/content.opf", data: opf },
    { name: "OEBPS/nav.xhtml", data: nav },
    { name: "OEBPS/cover.png", data: b.cover, store: true },
    ...chapters.map((c) => ({ name: `OEBPS/${c.id}.xhtml`, data: page(c.title, c.body) })),
  ]);
}
