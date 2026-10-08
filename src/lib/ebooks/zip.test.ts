import { describe, expect, it } from "vitest";
import { MAX_ENTRY_BYTES, ZipError, readZipDirectory, readZipEntry } from "./zip";
import { buildZip, rangeOfBytes } from "./test-zip";

const read = async (zip: Uint8Array, name: string, max?: number) => {
  const dir = await readZipDirectory(rangeOfBytes(zip), zip.length);
  const entry = dir.get(name);
  if (!entry) throw new Error("missing " + name);
  return new TextDecoder().decode(await readZipEntry(rangeOfBytes(zip), entry, zip.length, max));
};

describe("readZipDirectory / readZipEntry", () => {
  it("reads stored and deflated entries by name, and lists the directory without reading any entry", async () => {
    const zip = buildZip([
      { name: "mimetype", data: "application/epub+zip", method: 0 },
      { name: "OEBPS/content.opf", data: "<package>" + "x".repeat(5000) + "</package>" },
      { name: "empty.txt", data: "" },
    ]);
    const dir = await readZipDirectory(rangeOfBytes(zip), zip.length);
    expect([...dir.keys()]).toEqual(["mimetype", "OEBPS/content.opf", "empty.txt"]);
    expect(await read(zip, "mimetype")).toBe("application/epub+zip");
    expect(await read(zip, "OEBPS/content.opf")).toBe("<package>" + "x".repeat(5000) + "</package>");
    expect(await read(zip, "empty.txt")).toBe("");
  });

  it("asks only for the end of the file, the directory and the entry wanted", async () => {
    const big = buildZip([{ name: "a.bin", data: new Uint8Array(200_000).map((_, i) => i % 251), method: 0 }, { name: "b.txt", data: "hello" }]);
    const calls: [number, number][] = [];
    const spy = async (s: number, e: number) => (calls.push([s, e]), rangeOfBytes(big)(s, e));
    const dir = await readZipDirectory(spy, big.length);
    await readZipEntry(spy, dir.get("b.txt")!, big.length);
    expect(calls.every(([s, e]) => e - s < 100_000)).toBe(true); // never the 200 KB entry
  });

  it("finds the directory when the archive has a trailing comment, and ignores a fake signature inside the comment", async () => {
    const fake = "PK\x05\x06" + "z".repeat(40);
    const zip = buildZip([{ name: "a.txt", data: "ok" }], fake);
    expect(await read(zip, "a.txt")).toBe("ok");
  });

  it("keeps the first of two entries with the same name", async () => {
    const zip = buildZip([{ name: "a.txt", data: "first" }, { name: "a.txt", data: "second" }]);
    expect(await read(zip, "a.txt")).toBe("first");
  });

  it("treats a name with .. as just a name, never as a path to anywhere", async () => {
    const zip = buildZip([{ name: "../../etc/passwd", data: "x" }]);
    const dir = await readZipDirectory(rangeOfBytes(zip), zip.length);
    expect([...dir.keys()]).toEqual(["../../etc/passwd"]);
  });

  it("refuses files that aren't ZIPs, are encrypted, or use methods it doesn't know", async () => {
    await expect(readZipDirectory(rangeOfBytes(new Uint8Array(100)), 100)).rejects.toThrow(ZipError);
    await expect(readZipDirectory(rangeOfBytes(new Uint8Array(5)), 5)).rejects.toThrow(/Not a ZIP/);
    await expect(readZipDirectory(rangeOfBytes(buildZip([{ name: "a", data: "x", flags: 1 }])), buildZip([{ name: "a", data: "x", flags: 1 }]).length)).rejects.toThrow(/Encrypted/);
    const odd = buildZip([{ name: "a", data: "x" }]);
    // patch the central directory's method field (offset 10 in its header) to 12 (bzip2)
    const at = odd.length - 22 - (46 + 1);
    odd[at + 10] = 12;
    await expect(readZipDirectory(rangeOfBytes(odd), odd.length)).rejects.toThrow(/compression method 12/);
  });

  it("refuses an entry that claims to be huge, and one that decompresses to more than it claims", async () => {
    const zip = buildZip([{ name: "a.txt", data: "a".repeat(1000) }]);
    const dir = await readZipDirectory(rangeOfBytes(zip), zip.length);
    const entry = dir.get("a.txt")!;
    await expect(readZipEntry(rangeOfBytes(zip), { ...entry, size: MAX_ENTRY_BYTES + 1 }, zip.length)).rejects.toThrow(/too large/);
    await expect(readZipEntry(rangeOfBytes(zip), entry, zip.length, 100)).rejects.toThrow(/too large/);
    // a stored entry whose declared size disagrees with its bytes
    const stored = buildZip([{ name: "s.txt", data: "hello", method: 0 }]);
    const sdir = await readZipDirectory(rangeOfBytes(stored), stored.length);
    await expect(readZipEntry(rangeOfBytes(stored), { ...sdir.get("s.txt")!, size: 3 }, stored.length)).rejects.toThrow(ZipError);
    // a lying size (a zip bomb in miniature): the data inflates to 1000 bytes but the entry says 10
    await expect(readZipEntry(rangeOfBytes(zip), { ...entry, size: 10 }, zip.length)).rejects.toThrow(ZipError);
  });

  it("refuses an entry whose compressed size is out of proportion, without fetching any of it", async () => {
    const zip = buildZip([{ name: "a.txt", data: "a".repeat(1000) }, { name: "s.txt", data: "hello", method: 0 }]);
    const dir = await readZipDirectory(rangeOfBytes(zip), zip.length);
    const calls: [number, number][] = [];
    const spy = async (s: number, e: number) => (calls.push([s, e]), rangeOfBytes(zip)(s, e));
    await expect(readZipEntry(spy, { ...dir.get("a.txt")!, size: 10, compressedSize: 3_000_000_000 }, 4_000_000_000)).rejects.toThrow(ZipError);
    await expect(readZipEntry(spy, { ...dir.get("s.txt")!, compressedSize: 4 }, zip.length)).rejects.toThrow(ZipError); // stored: must equal its size
    expect(calls).toEqual([]);
  });

  it("refuses a damaged directory, a bad local header, and offsets outside the file", async () => {
    const zip = buildZip([{ name: "a.txt", data: "hello" }]);
    const cut = zip.slice(0, zip.length - 30);
    await expect(readZipDirectory(rangeOfBytes(cut), cut.length)).rejects.toThrow(ZipError);
    const dir = await readZipDirectory(rangeOfBytes(zip), zip.length);
    const entry = dir.get("a.txt")!;
    await expect(readZipEntry(rangeOfBytes(zip), { ...entry, localHeaderOffset: 5 }, zip.length)).rejects.toThrow(ZipError);
    await expect(readZipEntry(rangeOfBytes(zip), { ...entry, compressedSize: 10_000 }, zip.length)).rejects.toThrow(ZipError);
  });
});
