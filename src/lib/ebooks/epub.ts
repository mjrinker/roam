/**
 * What an EPUB says about itself: title, authors, series, description, year and cover, read from its package (OPF)
 * file. The book is a ZIP read by byte ranges (see zip.ts), so only the directory, container.xml, the package
 * file and the cover image are ever fetched. Every field is optional: a book that says nothing useful still
 * becomes a title (named from its file), and a damaged one is reported, never fatal to the scan.
 */
import { MAX_ENTRY_BYTES, ZipError, readZipDirectory, readZipEntry, type RangeFetcher } from "@/lib/ebooks/zip";
import { findAll, parseXml, textOf, type XmlNode } from "@/lib/ebooks/xml";

export interface EpubMetadata {
  title: string | null;
  authors: string[];
  publisher: string | null;
  language: string | null;
  description: string | null;
  year: number | null;
  series: string | null;
  seriesPosition: string | null;
  /** Zip path of the cover image, if one is declared. */
  coverPath: string | null;
}

export interface EpubTags extends Omit<EpubMetadata, "coverPath"> {
  cover: { contentType: "image/jpeg" | "image/png"; bytes: Uint8Array } | null;
}

const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 4000;

/** Joins a reference found inside the package file to the package's own folder; null if it climbs out of the book. */
export function resolveInBook(baseFile: string, href: string): string | null {
  let ref = href.split("#")[0].split("?")[0];
  try {
    ref = decodeURIComponent(ref);
  } catch {
    // keep as written
  }
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("/")) return ref.startsWith("/") ? normalize(ref.slice(1)) : null;
  const dir = baseFile.includes("/") ? baseFile.slice(0, baseFile.lastIndexOf("/") + 1) : "";
  return normalize(dir + ref);
}

function normalize(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.length ? out.join("/") : null;
}

export function parseContainer(xml: string): string | null {
  const roots = findAll(parseXml(xml), "rootfile");
  const pick = roots.find((r) => /oebps-package/i.test(r.attrs["media-type"] ?? "")) ?? roots[0];
  const path = pick?.attrs["full-path"];
  return path ? normalize(path) : null;
}

/** Text without tags, linear in the input however many "<" it has without a ">" (a regex here would rescan on every one). */
function plain(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) {
      out += html.slice(lt); // a lone "<" with no tag after it: kept as text
      break;
    }
    out += " ";
    i = gt + 1;
  }
  return out.replace(/\s+/g, " ").trim();
}

const MAX_FIELD = 500;
const MAX_RAW_DESCRIPTION = 40_000;
const capped = (s: string | null): string | null => (s ? s.slice(0, MAX_FIELD) : s);

export function parseOpf(xml: string, opfPath: string): EpubMetadata {
  const doc = parseXml(xml);
  const metadata = findAll(doc, "metadata")[0];
  const first = (name: string) => textOf(metadata ? findAll(metadata, name)[0] : undefined) || null;

  const creators = (metadata ? findAll(metadata, "creator") : [])
    .filter((c) => !c.attrs.role || /^aut$/i.test(c.attrs.role))
    .map((c) => textOf(c).slice(0, MAX_FIELD))
    .filter(Boolean);
  const description = (() => {
    const raw = textOf(metadata ? findAll(metadata, "description")[0] : undefined).slice(0, MAX_RAW_DESCRIPTION);
    const text = plain(raw);
    return text ? text.slice(0, MAX_TEXT) : null;
  })();
  const dateYear = (() => {
    const m = /^(\d{4})/.exec(first("date") ?? "");
    const y = m ? Number(m[1]) : NaN;
    return y >= 1000 && y <= 2100 ? y : null;
  })();

  const metas = metadata ? findAll(metadata, "meta") : [];
  const metaContent = (name: string) => metas.find((m) => m.attrs.name === name)?.attrs.content?.trim() || null;
  let series = capped(metaContent("calibre:series"));
  let seriesPosition = metaContent("calibre:series_index");
  if (!series) {
    // EPUB 3: <meta property="belongs-to-collection" id="c1">Name</meta> refined by collection-type=series and group-position.
    const coll = metas.find((m) => m.attrs.property === "belongs-to-collection" && m.attrs.id);
    if (coll) {
      const refines = (prop: string) => metas.find((m) => m.attrs.refines === `#${coll.attrs.id}` && m.attrs.property === prop);
      const type = textOf(refines("collection-type"));
      if (!type || type === "series") {
        series = capped(textOf(coll) || null);
        seriesPosition = textOf(refines("group-position")) || seriesPosition;
      }
    }
  }
  if (seriesPosition !== null) {
    const n = Number(seriesPosition);
    seriesPosition = Number.isFinite(n) && n >= 0 && n < 10_000 ? String(n) : null;
  }

  // The cover: an EPUB 3 manifest item flagged cover-image, else the EPUB 2 <meta name="cover" content="id">, else an image item called "cover".
  const manifest = findAll(doc, "manifest")[0];
  const items = manifest ? findAll(manifest, "item") : [];
  const isImage = (i: XmlNode) => /^image\/(jpeg|png)$/i.test(i.attrs["media-type"] ?? "") || /\.(jpe?g|png)$/i.test(i.attrs.href ?? "");
  const coverItem =
    items.find((i) => (i.attrs.properties ?? "").split(/\s+/).includes("cover-image")) ??
    items.find((i) => i.attrs.id === metaContent("cover") && isImage(i)) ??
    items.find((i) => isImage(i) && /(^|[\W_])cover([\W_]|$)/i.test(`${i.attrs.id ?? ""} ${i.attrs.href ?? ""}`));
  const coverPath = coverItem?.attrs.href ? resolveInBook(opfPath, coverItem.attrs.href) : null;

  const publisher = capped(first("publisher"));
  // Project Gutenberg's dc:date is when its own EPUB was made (1998 for Pride and Prejudice), not when the book was written.
  const year = publisher && /project gutenberg/i.test(publisher) ? null : dateYear;

  return {
    title: capped(first("title")),
    authors: [...new Set(creators)].slice(0, 20),
    publisher,
    language: capped(first("language")),
    description,
    year,
    series,
    seriesPosition,
    coverPath,
  };
}

function imageType(b: Uint8Array): "image/jpeg" | "image/png" | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  return null;
}

/** Reads an EPUB's metadata and cover from Box (or any byte-range source). Throws ZipError for a file that isn't a readable EPUB. */
export async function probeEpubTags(fetchRange: RangeFetcher, fileSize: number): Promise<EpubTags> {
  const dir = await readZipDirectory(fetchRange, fileSize);
  const containerEntry = dir.get("META-INF/container.xml");
  if (!containerEntry) throw new ZipError("Not an EPUB (no META-INF/container.xml).");
  const opfPath = parseContainer(new TextDecoder().decode(await readZipEntry(fetchRange, containerEntry, fileSize, 64 * 1024)));
  const opfEntry = opfPath ? dir.get(opfPath) : undefined;
  if (!opfPath || !opfEntry) throw new ZipError("The EPUB's package file is missing.");
  const meta = parseOpf(new TextDecoder().decode(await readZipEntry(fetchRange, opfEntry, fileSize, MAX_ENTRY_BYTES)), opfPath);

  let cover: EpubTags["cover"] = null;
  const coverEntry = meta.coverPath ? dir.get(meta.coverPath) : undefined;
  if (coverEntry && coverEntry.size <= MAX_COVER_BYTES) {
    try {
      const bytes = await readZipEntry(fetchRange, coverEntry, fileSize, MAX_COVER_BYTES);
      const type = imageType(bytes);
      if (type) cover = { contentType: type, bytes };
    } catch {
      // a damaged cover must not lose the rest of the metadata
    }
  }
  const { coverPath: _path, ...rest } = meta;
  void _path;
  return { ...rest, cover };
}
