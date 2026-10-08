import { describe, expect, it } from "vitest";
import { parseXml, decodeEntities, findAll, textOf } from "./xml";
import { parseContainer, parseOpf, probeEpubTags, resolveInBook } from "./epub";
import { ZipError } from "./zip";
import { buildZip, rangeOfBytes } from "./test-zip";
import { TEST_JPEG } from "@/lib/scan/test-mp4";

describe("xml reader", () => {
  it("builds a tree, drops namespace prefixes, decodes standard and numeric entities, and reads CDATA literally", () => {
    const doc = parseXml('<?xml version="1.0"?><!-- c --><a:root xmlns:a="x"><dc:title id="t">Tom &amp; Jerry &#233; &#x263A;</dc:title><b><![CDATA[<raw> & text]]></b><e k=\'v\' opf:role="aut"/></a:root>');
    const title = findAll(doc, "title")[0];
    expect(textOf(title)).toBe("Tom & Jerry é ☺");
    expect(title.attrs.id).toBe("t");
    expect(textOf(findAll(doc, "b")[0])).toBe("<raw> & text");
    expect(findAll(doc, "e")[0].attrs).toEqual({ k: "v", role: "aut" });
  });
  it("never expands entities a document defines, and ignores unknown ones", () => {
    const doc = parseXml('<!DOCTYPE x [<!ENTITY boom "aaaaaaaaaa">]><x>&boom; &amp; &nope;</x>');
    expect(textOf(findAll(doc, "x")[0])).toBe("&boom; & &nope;");
    expect(decodeEntities("&#0; &#xD800; &#9999999;")).toBe("  ");
  });
  it("drops control characters, including a NUL, from text", () => {
    expect(textOf(findAll(parseXml("<t>a\u0000b\u0001c\td</t>"), "t")[0])).toBe("abc d");
  });
  it("survives junk, stray closers and enormous nesting without throwing", () => {
    expect(() => parseXml("<<<>>> </nope> <a <b")).not.toThrow();
    const deep = "<a>".repeat(5000) + "x" + "</a>".repeat(5000);
    expect(() => parseXml(deep)).not.toThrow();
    expect(() => parseXml("<a>".repeat(100_000))).not.toThrow();
  });
});

describe("hostile input", () => {
  const time = (fn: () => void) => {
    const t = Date.now();
    fn();
    return Date.now() - t;
  };
  it("reads adversarial documents of the maximum size in linear time (no construct is re-scanned)", () => {
    for (const piece of ["<!--", "<![CDATA[", "<?x ", "<a ", "</", "<a b='", "<a b=", "<a/", "<", "&amp;", "<a b='&amp;"]) {
      expect(time(() => parseXml(piece.repeat(Math.floor(2_000_000 / piece.length)))), piece).toBeLessThan(4000);
    }
  }, 60_000);
  it("keeps what came before an unterminated construct", () => {
    expect(textOf(findAll(parseXml("<a>kept<!-- never closed"), "a")[0])).toBe("kept");
    expect(textOf(findAll(parseXml("<a>x</a><b>y<![CDATA[ open"), "b")[0])).toBe("y");
  });
  it("reads a package whose description is a huge run of '<' without a '>' in linear time, and caps it", () => {
    const opf = `<package><metadata><dc:title>T</dc:title><dc:description>${"&lt;".repeat(500_000)}</dc:description></metadata></package>`;
    let meta!: ReturnType<typeof parseOpf>;
    expect(time(() => (meta = parseOpf(opf, "c.opf")))).toBeLessThan(4000);
    expect(meta.description!.length).toBeLessThanOrEqual(4000);
    expect(meta.title).toBe("T");
  });
  it("strips tags from a description without touching a lone '<'", () => {
    expect(parseOpf("<package><metadata><dc:description>a &lt;b&gt;bold&lt;/b&gt; c &lt; d</dc:description></metadata></package>", "c.opf").description).toBe("a bold c < d");
  });
  it("removes control characters from attribute values too, and caps title, author and series lengths", () => {
    const opf = `<package><metadata><dc:title>${"T".repeat(5000)}</dc:title><dc:creator>${"A".repeat(5000)}</dc:creator><meta name="calibre:series" content="Se\u0000ries\u0001"/></metadata></package>`;
    const meta = parseOpf(opf, "c.opf");
    expect(meta.series).toBe("Series");
    expect(meta.title).toHaveLength(500);
    expect(meta.authors[0]).toHaveLength(500);
  });
  it("keeps at most twenty authors", () => {
    const creators = Array.from({ length: 60 }, (_, i) => `<dc:creator>Person ${i}</dc:creator>`).join("");
    expect(parseOpf(`<package><metadata>${creators}</metadata></package>`, "c.opf").authors).toHaveLength(20);
  });
});

describe("resolveInBook", () => {
  it("joins to the package's folder, decodes, drops fragments, and refuses to climb out of the book", () => {
    expect(resolveInBook("OEBPS/content.opf", "images/cover.jpg")).toBe("OEBPS/images/cover.jpg");
    expect(resolveInBook("content.opf", "a%20b.jpg#x")).toBe("a b.jpg");
    expect(resolveInBook("OEBPS/content.opf", "../cover.jpg")).toBe("cover.jpg");
    expect(resolveInBook("OEBPS/content.opf", "../../x.jpg")).toBeNull();
    expect(resolveInBook("OEBPS/content.opf", "http://evil/x.jpg")).toBeNull();
    expect(resolveInBook("OEBPS/content.opf", "")).toBeNull();
    expect(resolveInBook("OEBPS/content.opf", "/abs/c.jpg")).toBe("abs/c.jpg");
  });
});

const OPF2 = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
<dc:title>The Great Book</dc:title><dc:creator opf:role="aut">Jane Author</dc:creator><dc:creator opf:role="aut">Joe Co-Author</dc:creator><dc:creator opf:role="trl">Tina Translator</dc:creator><dc:creator opf:role="aut">Jane Author</dc:creator>
<dc:publisher>Pub House</dc:publisher><dc:language>en</dc:language><dc:date>2011-05-06T00:00:00+00:00</dc:date>
<dc:description>&lt;p&gt;A &lt;b&gt;grand&lt;/b&gt; story.&lt;/p&gt;</dc:description>
<meta name="calibre:series" content="The Saga"/><meta name="calibre:series_index" content="2.0"/><meta name="cover" content="cov"/></metadata>
<manifest><item id="cov" href="images/front.jpg" media-type="image/jpeg"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest></package>`;

const OPF3 = `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Modern Book</dc:title><dc:creator id="a1">Sam Writer</dc:creator><dc:date>1999</dc:date>
<meta property="belongs-to-collection" id="c01">The Third Series</meta><meta refines="#c01" property="collection-type">series</meta><meta refines="#c01" property="group-position">7</meta></metadata>
<manifest><item id="i" href="img/c.png" media-type="image/png" properties="cover-image"/></manifest></package>`;

describe("parseContainer / parseOpf", () => {
  it("finds the package file", () => {
    expect(parseContainer('<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')).toBe("OEBPS/content.opf");
    expect(parseContainer("<container/>")).toBeNull();
    expect(parseContainer('<rootfile full-path="../../x.opf"/>')).toBeNull();
  });
  it("reads an EPUB 2 package: title, authors (not translators, no repeats), year, series, description as text, cover from meta", () => {
    expect(parseOpf(OPF2, "OEBPS/content.opf")).toEqual({
      title: "The Great Book", authors: ["Jane Author", "Joe Co-Author"], publisher: "Pub House", language: "en", description: "A grand story.", year: 2011,
      series: "The Saga", seriesPosition: "2", coverPath: "OEBPS/images/front.jpg",
    });
  });
  it("reads an EPUB 3 package: collection series, group position, cover-image property", () => {
    expect(parseOpf(OPF3, "content.opf")).toMatchObject({ title: "Modern Book", authors: ["Sam Writer"], year: 1999, series: "The Third Series", seriesPosition: "7", coverPath: "img/c.png" });
  });
  it("ignores the date of a Project Gutenberg edition, which is when the EPUB was made, not when the book was written", () => {
    const opf = (publisher: string) => `<package><metadata><dc:title>T</dc:title><dc:publisher>${publisher}</dc:publisher><dc:date>1998-06-01</dc:date></metadata></package>`;
    expect(parseOpf(opf("Project Gutenberg"), "c.opf").year).toBeNull();
    expect(parseOpf(opf("Pub House"), "c.opf").year).toBe(1998);
  });
  it("copes with a package that says almost nothing", () => {
    expect(parseOpf("<package><metadata/></package>", "c.opf")).toEqual({ title: null, authors: [], publisher: null, language: null, description: null, year: null, series: null, seriesPosition: null, coverPath: null });
    expect(parseOpf("", "c.opf").title).toBeNull();
    const odd = parseOpf('<package><metadata><dc:title>T</dc:title><dc:date>nonsense</dc:date><meta name="calibre:series" content="S"/><meta name="calibre:series_index" content="abc"/></metadata></package>', "c.opf");
    expect([odd.year, odd.series, odd.seriesPosition]).toEqual([null, "S", null]);
  });
  it("only picks a cover that is an image, and falls back to an image called cover", () => {
    const opf = '<package><metadata><meta name="cover" content="c1"/></metadata><manifest><item id="c1" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="x" href="img/cover.jpeg" media-type="image/jpeg"/></manifest></package>';
    expect(parseOpf(opf, "c.opf").coverPath).toBe("img/cover.jpeg");
    expect(parseOpf('<package><manifest><item id="a" href="photo.jpg" media-type="image/jpeg"/></manifest></package>', "c.opf").coverPath).toBeNull();
  });
  it("trims a very long description", () => {
    expect(parseOpf(`<package><metadata><dc:description>${"word ".repeat(5000)}</dc:description></metadata></package>`, "c.opf").description).toHaveLength(4000);
  });
});

const epub = (opf = OPF2, extra: { name: string; data: string | Uint8Array }[] = [{ name: "OEBPS/images/front.jpg", data: Uint8Array.from(TEST_JPEG) }]) =>
  buildZip([
    { name: "mimetype", data: "application/epub+zip", method: 0 },
    { name: "META-INF/container.xml", data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: "OEBPS/content.opf", data: opf },
    ...extra,
  ]);

describe("probeEpubTags", () => {
  it("reads the metadata and cover of a whole EPUB", async () => {
    const book = epub();
    const tags = await probeEpubTags(rangeOfBytes(book), book.length);
    expect(tags).toMatchObject({ title: "The Great Book", authors: ["Jane Author", "Joe Co-Author"], series: "The Saga", seriesPosition: "2", year: 2011 });
    expect(tags.cover?.contentType).toBe("image/jpeg");
    expect(Array.from(tags.cover!.bytes)).toEqual(TEST_JPEG);
  });
  it("keeps the metadata when the cover is missing, not an image, or damaged", async () => {
    for (const extra of [[], [{ name: "OEBPS/images/front.jpg", data: "this is not an image" }]]) {
      const book = epub(OPF2, extra);
      const tags = await probeEpubTags(rangeOfBytes(book), book.length);
      expect(tags.title).toBe("The Great Book");
      expect(tags.cover).toBeNull();
    }
  });
  it("refuses files that are not EPUBs", async () => {
    const notEpub = buildZip([{ name: "a.txt", data: "x" }]);
    await expect(probeEpubTags(rangeOfBytes(notEpub), notEpub.length)).rejects.toThrow(ZipError);
    const noOpf = buildZip([{ name: "META-INF/container.xml", data: '<rootfile full-path="missing.opf"/>' }]);
    await expect(probeEpubTags(rangeOfBytes(noOpf), noOpf.length)).rejects.toThrow(/package file is missing/);
    await expect(probeEpubTags(rangeOfBytes(new Uint8Array(500)), 500)).rejects.toThrow(ZipError);
  });
});
