import { describe, expect, it } from "vitest";
import { probeEpubTags } from "@/lib/ebooks/epub";
import { readZipDirectory, readZipEntry } from "@/lib/ebooks/zip";
import { rangeOfBytes } from "@/lib/ebooks/test-zip";
import { buildPlaceholderEpub, placeholderNotice, xmlEscape } from "./placeholder-epub";
import { coverSvg, renderCoverPng, wrapTitle } from "./placeholder-cover";

const book = async (over: Partial<Parameters<typeof buildPlaceholderEpub>[0]> = {}) =>
  buildPlaceholderEpub({
    title: "The Two Towers", author: "J.R.R. Tolkien", year: 1954, series: { name: "The Lord of the Rings", position: 2 },
    cover: await renderCoverPng("The Two Towers", "J.R.R. Tolkien"), paragraphs: Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of the stand-in text.`),
    textCredit: "William Morris, The Wood Beyond the World, 1894", slug: "two-towers", ...over,
  });

describe("placeholder EPUBs", () => {
  it("read back through Roam's own EPUB reader with the real title, author, year, series and a cover", async () => {
    const epub = await book();
    const tags = await probeEpubTags(rangeOfBytes(epub), epub.length);
    expect(tags).toMatchObject({ title: "The Two Towers", authors: ["J.R.R. Tolkien"], year: 1954, series: "The Lord of the Rings", seriesPosition: "2", publisher: "Roam demo (placeholder file)" });
    expect(tags.description).toContain("not the book named");
    expect(tags.cover?.contentType).toBe("image/png");
  });
  it("opens with a notice that says the file is a stand-in, and has the contents the reader needs", async () => {
    const epub = await book();
    const dir = await readZipDirectory(rangeOfBytes(epub), epub.length);
    expect([...dir.keys()].slice(0, 2)).toEqual(["mimetype", "META-INF/container.xml"]); // mimetype first, as the format requires
    expect(dir.get("mimetype")!.method).toBe(0);
    const notice = new TextDecoder().decode(await readZipEntry(rangeOfBytes(epub), dir.get("OEBPS/notice.xhtml")!, epub.length));
    expect(notice).toContain("stand-in file");
    expect(notice).toContain("still in copyright");
    expect(notice).toContain("William Morris");
    expect(dir.has("OEBPS/ch1.xhtml") && dir.has("OEBPS/ch3.xhtml")).toBe(true); // 30 paragraphs, 12 to a chapter
    expect(dir.has("OEBPS/ch4.xhtml")).toBe(false);
  });
  it("makes a book without a series, and survives hostile text in every field", async () => {
    const evil = `<script>alert(1)</script> & "quotes" \u0000`;
    const epub = await book({ title: evil, author: evil, series: undefined, paragraphs: [evil] });
    const tags = await probeEpubTags(rangeOfBytes(epub), epub.length);
    expect(tags.title).toContain("<script>alert(1)</script>");
    expect(tags.series).toBeNull();
    const dir = await readZipDirectory(rangeOfBytes(epub), epub.length);
    const ch = new TextDecoder().decode(await readZipEntry(rangeOfBytes(epub), dir.get("OEBPS/ch1.xhtml")!, epub.length));
    expect(ch).not.toContain("<script>");
    expect(ch).not.toContain("\u0000");
  });
  it("escapes for XML and builds the notice from the book's own details", () => {
    expect(xmlEscape(`a<b>&"c\u0001`)).toBe("a&lt;b&gt;&amp;&quot;c");
    expect(placeholderNotice({ title: "T", author: "A", textCredit: "X" })).toContain('It is not "T".');
  });
});

describe("placeholder covers", () => {
  it("wraps titles at spaces into at most six lines", () => {
    expect(wrapTitle("The Fellowship of the Ring")).toEqual(["The Fellowship", "of the Ring"]);
    expect(wrapTitle("Supercalifragilisticexpialidocious")).toEqual(["Supercalifragilisticexpialidocious"]);
    expect(wrapTitle("a b c d e f g h i j k l m n o p q r s t u v w x y z".repeat(4), 4).length).toBeLessThanOrEqual(6);
    expect(wrapTitle("")).toEqual([]);
  });
  it("escapes text in the drawing and says it is a placeholder", () => {
    const svg = coverSvg(`A <b>&</b> "B"`, "C & D");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("PLACEHOLDER FILE");
  });
  it("renders a 600 x 900 PNG", async () => {
    const png = await renderCoverPng("The Hobbit", "J.R.R. Tolkien");
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const sharp = (await import("sharp")).default;
    const meta = await sharp(Buffer.from(png)).metadata();
    expect([meta.width, meta.height]).toEqual([600, 900]);
  });
});
