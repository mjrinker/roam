import { describe, expect, it } from "vitest";
import { MAX_TAG_BYTES, probeMp3Tags } from "./id3-tags";

// ── ID3 builders (real bytes through the real parser) ────────────────────
const bytes = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be24 = (n: number) => [(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const sync = (n: number) => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
const latin1 = (s: string) => Array.from(s).map((c) => c.charCodeAt(0) & 0xff);
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
const utf16 = (s: string, endian: "le" | "be", bom: boolean) => {
  const units = Array.from(s).map((c) => c.charCodeAt(0));
  const body = units.flatMap((u) => (endian === "le" ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff]));
  return [...(bom ? (endian === "le" ? [0xff, 0xfe] : [0xfe, 0xff]) : []), ...body];
};

type Ver = 2 | 3 | 4;
/** One frame: v2.2 has 3-char ids, 3-byte sizes and no flags; 2.3 plain sizes; 2.4 sync-safe sizes (or plain, to imitate old writers). */
function frame(ver: Ver, id: string, body: number[], opts: { flags?: number; plainV24?: boolean } = {}): number[] {
  if (ver === 2) return [...bytes(id), ...be24(body.length), ...body];
  const size = ver === 4 && !opts.plainV24 ? sync(body.length) : be32(body.length);
  const flags = opts.flags ?? 0;
  return [...bytes(id), ...size, flags >> 8, flags & 0xff, ...body];
}
const text = (enc: number, payload: number[]) => [enc, ...payload];
const FRONT = 3;
/** APIC (v2.2 PIC): encoding, mime (v2.2: 3-char format), picture type, description, data. */
function pic(ver: Ver, o: { enc?: number; mime?: string; type?: number; desc?: number[]; data: number[] }): number[] {
  const enc = o.enc ?? 0;
  const term = enc === 1 || enc === 2 ? [0, 0] : [0];
  const mime = ver === 2 ? bytes((o.mime ?? "JPG").slice(0, 3)) : [...bytes(o.mime ?? "image/jpeg"), 0];
  return [enc, ...mime, o.type ?? FRONT, ...(o.desc ?? []), ...term, ...o.data];
}
function tag(ver: Ver, frames: number[][], o: { flags?: number; padding?: number; ext?: number[] } = {}): number[] {
  const body = [...(o.ext ?? []), ...frames.flat(), ...new Array(o.padding ?? 0).fill(0)];
  return [...bytes("ID3"), ver, 0, o.flags ?? 0, ...sync(body.length), ...body];
}
const AUDIO = new Array(500).fill(0xaa);
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7];

function fetcherFor(file: number[], log?: { ranges: number[] }) {
  return async (start: number, end: number): Promise<ArrayBuffer> => {
    const out = new Uint8Array(end - start + 1);
    for (let i = start; i <= Math.min(end, file.length - 1); i++) out[i - start] = file[i];
    log?.ranges.push(end - start + 1);
    return out.buffer;
  };
}
const probe = (file: number[], log?: { ranges: number[] }) => probeMp3Tags(fetcherFor(file, log), file.length);
const v1 = (o: { title?: string; artist?: string; album?: string; year?: string; genre?: number }) => {
  const pad = (s: string | undefined, n: number) => [...latin1((s ?? "").slice(0, n)), ...new Array(n - Math.min(n, (s ?? "").length)).fill(0)];
  return [...bytes("TAG"), ...pad(o.title, 30), ...pad(o.artist, 30), ...pad(o.album, 30), ...pad(o.year, 4), ...new Array(30).fill(0), o.genre ?? 255];
};

describe("probeMp3Tags: ID3v2.3", () => {
  it("reads title, artist, album, year and a front cover", async () => {
    const file = [
      ...tag(3, [
        frame(3, "TIT2", text(0, latin1("Café Society"))),
        frame(3, "TPE1", text(0, latin1("The Band"))),
        frame(3, "TALB", text(0, latin1("First Album"))),
        frame(3, "TYER", text(0, latin1("1999"))),
        frame(3, "APIC", pic(3, { data: JPEG })),
      ]),
      ...AUDIO,
    ];
    const t = await probe(file);
    expect(t).toMatchObject({ title: "Café Society", artist: "The Band", album: "First Album", year: 1999 });
    expect(t.cover?.contentType).toBe("image/jpeg");
    expect(Array.from(t.cover!.bytes)).toEqual(JPEG);
  });

  it("reads genres: text, numbers, (number) references and several at once, in every version", async () => {
    const genres = async (ver: Ver, id: string, payload: number[]) => (await probe([...tag(ver, [frame(ver, id, text(0, payload))]), ...AUDIO])).genres;
    expect(await genres(3, "TCON", latin1("Jazz"))).toEqual(["Jazz"]);
    expect(await genres(3, "TCON", latin1("(17)"))).toEqual(["Rock"]);
    expect(await genres(3, "TCON", latin1("(17)Rock"))).toEqual(["Rock"]);
    expect(await genres(4, "TCON", [...latin1("Rock"), 0, ...latin1("Pop")])).toEqual(["Rock", "Pop"]);
    expect(await genres(2, "TCO", latin1("(13)"))).toEqual(["Pop"]);
    expect(await genres(3, "TCON", latin1("(RX)"))).toEqual([]);
  });

  it("uses an ID3v1 genre byte when the v2 tag names none, and the v2 genre when both do", async () => {
    expect((await probe([...AUDIO, ...v1({ title: "Old", genre: 17 })])).genres).toEqual(["Rock"]);
    expect((await probe([...AUDIO, ...v1({ title: "Old", genre: 255 })])).genres).toEqual([]);
    const both = [...tag(3, [frame(3, "TCON", text(0, latin1("Jazz")))]), ...AUDIO, ...v1({ title: "Old", genre: 17 })];
    expect((await probe(both)).genres).toEqual(["Jazz"]);
  });

  it("decodes every text encoding: Latin-1, UTF-16 with either BOM, UTF-16BE without one, UTF-8", async () => {
    const title = "Ünï ☃";
    const cases: [string, number[]][] = [
      ["utf-16 LE+BOM", text(1, utf16(title, "le", true))],
      ["utf-16 BE+BOM", text(1, utf16(title, "be", true))],
      ["utf-16BE no BOM", text(2, utf16(title, "be", false))],
      ["utf-8", text(3, utf8(title))],
    ];
    for (const [name, body] of cases) expect((await probe([...tag(4, [frame(4, "TIT2", body)]), ...AUDIO])).title, name).toBe(title);
    expect((await probe([...tag(3, [frame(3, "TIT2", text(0, latin1("Ünï")))]), ...AUDIO])).title).toBe("Ünï");
  });

  it("joins several artists (NUL-separated) and treats a trailing NUL as nothing", async () => {
    const f = [...tag(4, [frame(4, "TPE1", text(3, [...utf8("A"), 0, ...utf8("B"), 0]))]), ...AUDIO];
    expect((await probe(f)).artist).toBe("A, B");
  });
});

describe("probeMp3Tags: other versions and layouts", () => {
  it("reads ID3v2.4: sync-safe sizes, TDRC dates, UTF-8", async () => {
    const f = [...tag(4, [frame(4, "TIT2", text(3, utf8("T" + "x".repeat(200)))), frame(4, "TDRC", text(3, utf8("2019-05-06T10:00")))]), ...AUDIO];
    const t = await probe(f);
    expect(t.title).toBe("T" + "x".repeat(200));
    expect(t.year).toBe(2019);
  });

  it("copes with a 2.4 file whose writer used plain (not sync-safe) frame sizes", async () => {
    const long = "L".repeat(200); // 201 bytes: a plain size that isn't a valid sync-safe one
    const f = [...tag(4, [frame(4, "TIT2", text(3, utf8(long)), { plainV24: true }), frame(4, "TPE1", text(3, utf8("Artist")), { plainV24: true })]), ...AUDIO];
    const t = await probe(f);
    expect(t.title).toBe(long);
    expect(t.artist).toBe("Artist");
  });

  it("reads ID3v2.2: three-character frames, sizes and picture format", async () => {
    const f = [
      ...tag(2, [
        frame(2, "TT2", text(0, latin1("Old Song"))),
        frame(2, "TP1", text(0, latin1("Old Band"))),
        frame(2, "TAL", text(0, latin1("Old Album"))),
        frame(2, "TYE", text(0, latin1("1975"))),
        frame(2, "PIC", pic(2, { mime: "PNG", data: PNG })),
      ]),
      ...AUDIO,
    ];
    const t = await probe(f);
    expect(t).toMatchObject({ title: "Old Song", artist: "Old Band", album: "Old Album", year: 1975 });
    expect(t.cover?.contentType).toBe("image/png");
  });

  it("undoes whole-tag unsynchronisation (0xFF 0x00 pairs), including inside the cover", async () => {
    // Build the REAL tag body first, then insert a 0x00 after every 0xFF as an unsynchronised writer would.
    const cover = [0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 9, 9];
    const real = [...frame(3, "TIT2", text(0, latin1("Syncÿed"))), ...frame(3, "APIC", pic(3, { data: cover }))];
    const unsynced = real.flatMap((b) => (b === 0xff ? [0xff, 0x00] : [b]));
    const f = [...bytes("ID3"), 3, 0, 0x80, ...sync(unsynced.length), ...unsynced, ...AUDIO];
    const t = await probe(f);
    expect(t.title).toBe("Syncÿed");
    expect(Array.from(t.cover!.bytes)).toEqual(cover);
  });

  it("undoes ID3v2.4 tag-level unsynchronisation per frame (2.4 frame sizes count the stored bytes)", async () => {
    // Each frame BODY is unsynchronised and the size field counts the stored (longer) body.
    const unsync = (b: number[]) => b.flatMap((x) => (x === 0xff ? [0xff, 0x00] : [x]));
    const title = frame(4, "TIT2", unsync(text(0, latin1("Caf\u00ff\u00ffe"))));
    const cover = [0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 1, 2];
    const apic = frame(4, "APIC", unsync(pic(4, { data: cover })));
    const f = [...tag(4, [title, apic], { flags: 0x80 }), ...AUDIO];
    const t = await probe(f);
    expect(t.title).toBe("Caf\u00ff\u00ffe");
    expect(Array.from(t.cover!.bytes)).toEqual(cover);
  });

  it("skips an ID3v2.2 tag whose compression flag is set (that format is undefined)", async () => {
    const f = [...tag(2, [frame(2, "TT2", text(0, latin1("Compressed Tag")))], { flags: 0x40 }), ...AUDIO];
    expect((await probe(f)).title).toBeNull();
  });

  it("skips a v2.3 and a v2.4 extended header", async () => {
    const f3 = [...tag(3, [frame(3, "TIT2", text(0, latin1("Ext3")))], { flags: 0x40, ext: [...be32(6), 0, 0, 0, 0, 0, 0] }), ...AUDIO];
    expect((await probe(f3)).title).toBe("Ext3");
    const f4 = [...tag(4, [frame(4, "TIT2", text(3, utf8("Ext4")))], { flags: 0x40, ext: [...sync(6), 1, 0x00] }), ...AUDIO];
    expect((await probe(f4)).title).toBe("Ext4");
  });

  it("handles 2.4 frame flags: skips compressed/encrypted frames, strips grouping, length indicator and unsync", async () => {
    const f = [
      ...tag(4, [
        frame(4, "TIT2", text(3, utf8("Compressed")), { flags: 0x0008 }),
        frame(4, "TPE1", text(3, utf8("Encrypted")), { flags: 0x0004 }),
        frame(4, "TALB", [0x01, ...be32(20), ...text(3, utf8("With Length"))], { flags: 0x0001 }), // data length indicator
        frame(4, "TDRC", [0x07, ...text(3, utf8("2001"))], { flags: 0x0040 }), // grouping byte first
      ]),
      ...AUDIO,
    ];
    const t = await probe(f);
    expect(t.title).toBeNull();
    expect(t.artist).toBeNull();
    expect(t.album).toBe("With Length");
    expect(t.year).toBe(2001);
  });
});

describe("probeMp3Tags: artist, picture and fallbacks", () => {
  it("falls back to the album artist when there is no track artist", async () => {
    expect((await probe([...tag(3, [frame(3, "TPE2", text(0, latin1("Album Artist")))]), ...AUDIO])).artist).toBe("Album Artist");
    expect((await probe([...tag(3, [frame(3, "TPE2", text(0, latin1("Album Artist"))), frame(3, "TPE1", text(0, latin1("Track Artist")))]), ...AUDIO])).artist).toBe("Track Artist");
  });

  it("prefers the front cover to other pictures, and never trusts the declared MIME type", async () => {
    const small = [0xff, 0xd8, 0xff, 1, 2];
    const f = [
      ...tag(3, [
        frame(3, "APIC", pic(3, { type: 0, data: small })), // "other"
        frame(3, "APIC", pic(3, { type: FRONT, mime: "text/html", desc: utf16("front", "le", true), enc: 1, data: PNG })), // front, lying about its type
      ]),
      ...AUDIO,
    ];
    const t = await probe(f);
    expect(t.cover?.contentType).toBe("image/png"); // the front cover, identified by its bytes
    expect(Array.from(t.cover!.bytes)).toEqual(PNG);
  });

  it("ignores a picture that isn't a JPEG or PNG, or is over 256 KiB, but keeps the text", async () => {
    const huge = [0xff, 0xd8, 0xff, ...new Array(300 * 1024).fill(1)];
    const t1 = await probe([...tag(3, [frame(3, "TIT2", text(0, latin1("Keep"))), frame(3, "APIC", pic(3, { data: huge }))]), ...AUDIO]);
    expect(t1).toMatchObject({ title: "Keep", cover: null });
    const t2 = await probe([...tag(3, [frame(3, "TIT2", text(0, latin1("Keep"))), frame(3, "APIC", pic(3, { data: bytes("<html>not an image</html>") }))]), ...AUDIO]);
    expect(t2).toMatchObject({ title: "Keep", cover: null });
  });

  it("falls back to an ID3v1 tag at the end, which only fills what v2 left empty", async () => {
    const only1 = await probe([...AUDIO, ...v1({ title: "Plain Title", artist: "Plain Artist", album: "Plain Album", year: "1988" })]);
    expect(only1).toMatchObject({ title: "Plain Title", artist: "Plain Artist", album: "Plain Album", year: 1988 });
    const both = await probe([...tag(3, [frame(3, "TIT2", text(0, latin1("V2 Title")))]), ...AUDIO, ...v1({ title: "V1 Title", artist: "V1 Artist" })]);
    expect(both).toMatchObject({ title: "V2 Title", artist: "V1 Artist", album: null });
  });

  it("returns all nulls for a file with no tags, or one that isn't tagged like an MP3 at all", async () => {
    const none = { title: null, artist: null, album: null, year: null, genres: [], cover: null };
    expect(await probe(AUDIO)).toEqual(none);
    expect(await probe(bytes("RIFF....WAVEfmt "))).toEqual(none);
    expect(await probe([])).toEqual(none);
    expect(await probe([...bytes("ID3"), 9, 0, 0, ...sync(10), ...AUDIO])).toEqual(none); // an unknown version
  });

  it("cleans text: control characters, runs of whitespace, empty values, absurd years and over-long values", async () => {
    const f = [
      ...tag(3, [
        frame(3, "TIT2", text(0, latin1("  Line\u0001one\n\ntwo   three  "))),
        frame(3, "TYER", text(0, latin1("1066"))),
        frame(3, "TALB", text(0, latin1("x".repeat(1000)))),
        frame(3, "TPE1", text(0, latin1("   "))),
      ]),
      ...AUDIO,
    ];
    const t = await probe(f);
    expect(t.title).toBe("Line one two three");
    expect(t.year).toBeNull();
    expect(t.album).toHaveLength(300);
    expect(t.artist).toBeNull();
  });
});

describe("probeMp3Tags: hostile files", () => {
  it("never reads more than the ceiling, however large the tag claims to be, and asks for few ranges", async () => {
    // A tag that claims ~200 MB. The file itself is far smaller; only a bounded prefix may be touched.
    const log = { ranges: [] as number[] };
    const file = [...bytes("ID3"), 3, 0, 0, ...sync(200_000_000), ...frame(3, "TIT2", text(0, latin1("Still found"))), ...new Array(2_000_000).fill(0x41)];
    const t = await probe(file, log);
    expect(t.title).toBe("Still found");
    expect(Math.max(...log.ranges)).toBeLessThanOrEqual(MAX_TAG_BYTES);
    expect(log.ranges.length).toBeLessThanOrEqual(4);
  });

  it("a small ordinary tag costs one request, and none for ID3v1 when v2 gave everything", async () => {
    const log = { ranges: [] as number[] };
    await probe(
      [
        ...tag(3, [frame(3, "TIT2", text(0, latin1("T"))), frame(3, "TPE1", text(0, latin1("A"))), frame(3, "TALB", text(0, latin1("B"))), frame(3, "TYER", text(0, latin1("2000")))]),
        ...new Array(1000).fill(1),
      ],
      log
    );
    expect(log.ranges).toHaveLength(1);
  });

  it("stops at a frame that claims more than the tag holds, keeping what came before it", async () => {
    const bad = [...bytes("TPE1"), ...be32(5_000_000), 0, 0, 1, 2, 3];
    const f = [...tag(3, [frame(3, "TIT2", text(0, latin1("Survivor"))), bad]), ...AUDIO];
    const t = await probe(f);
    expect(t.title).toBe("Survivor");
    expect(t.artist).toBeNull();
  });

  it("is bounded for a tag stuffed with thousands of tiny frames (no hang, no blow-up)", async () => {
    const many = Array.from({ length: 20_000 }, () => frame(3, "TXXX", [0, 65, 0, 66]));
    const file = [...tag(3, [...many, frame(3, "TIT2", text(0, latin1("Too Late"))), ]), ...AUDIO];
    const started = Date.now();
    const t = await probe(file);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(t.title).toBeNull(); // past the frame cap, so never reached
  });

  it("survives truncated and garbage tags without throwing", async () => {
    for (const file of [
      [...bytes("ID3"), 3, 0, 0],
      [...bytes("ID3"), 3, 0, 0, ...sync(100), 0x54, 0x49],
      [...bytes("ID3"), 4, 0, 0, ...sync(30), ...new Array(30).fill(0xff)],
      [...bytes("ID3"), 3, 0, 0x80, ...sync(20), ...new Array(20).fill(0xff)],
      [...bytes("ID3"), 3, 0, 0x40, ...sync(20), 0xff, 0xff, 0xff, 0xff, ...new Array(16).fill(0)],
    ]) {
      await expect(probe(file)).resolves.toBeDefined();
    }
  });

  it("keeps what the v2 tag gave if the ID3v1 read at the end fails, but still lets a lost connection through", async () => {
    // Bigger than the first 64 KB window, so the ID3v1 read at the tail really goes to the network.
    const file = [...tag(3, [frame(3, "TIT2", text(0, latin1("From V2")))]), ...new Array(200_000).fill(0xaa)];
    let calls = 0;
    const flaky = async (start: number, end: number) => {
      if (++calls > 1) throw new Error("Box: byte-range fetch failed (416)"); // the v1 read at the tail
      return fetcherFor(file)(start, end);
    };
    expect((await probeMp3Tags(flaky, file.length)).title).toBe("From V2");

    const reauth = async (start: number, end: number) => {
      if (start > 100) throw Object.assign(new Error("reconnect"), { name: "BoxReauthRequiredError" });
      return fetcherFor(file)(start, end);
    };
    await expect(probeMp3Tags(reauth, file.length)).rejects.toThrow("reconnect");
  });

  it("lets a failed Box read through (that is the caller's to handle)", async () => {
    const failing = async () => {
      throw new Error("Box: byte-range fetch failed for file x (503)");
    };
    await expect(probeMp3Tags(failing, 5000)).rejects.toThrow(/Box/);
  });
});
