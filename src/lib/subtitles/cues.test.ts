import { describe, expect, it } from "vitest";
import { activeCues, cleanCueText, decodeSubtitleBytes, detectFormat, MAX_CUES, MAX_SUBTITLE_BYTES, parseSubtitleBytes, parseSubtitles, type Cue } from "./cues";

const bytes = (s: string) => new TextEncoder().encode(s);
const ok = (text: string) => {
  const r = parseSubtitles(text);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("SRT", () => {
  it("reads numbered cues with comma times, multi-line text and CRLF line ends", () => {
    const r = ok("1\r\n00:00:01,000 --> 00:00:03,500\r\nHello there.\r\nSecond line.\r\n\r\n2\r\n00:01:02,250 --> 00:01:04,000\r\nBye.\r\n");
    expect(r.format).toBe("srt");
    expect(r.cues).toEqual([[1, 3.5, "Hello there.\nSecond line."], [62.25, 64, "Bye."]]);
  });
  it("copes with a missing number, dots for commas, hours over 9, short millisecond fields and odd spacing", () => {
    const r = ok("00:00:01.5 --> 00:00:02.0\nNo number\n\n\n\n10:00:00,000   -->   10:00:01,000   X1:0 X2:0\nLate\n");
    expect(r.cues).toEqual([[1.5, 2, "No number"], [36000, 36001, "Late"]]);
  });
  it("sorts cues, mends an end before the start, and drops empty or unreadable blocks", () => {
    const r = ok("2\n00:00:09,000 --> 00:00:05,000\nBackwards\n\n1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n3\nnot a time\nJunk\n\n4\n00:00:20,000 --> 00:00:21,000\n   \n");
    expect(r.cues.map((c) => c[2])).toEqual(["First", "Backwards"]);
    expect(r.cues[1][1]).toBe(11); // an end that came before the start becomes start + 2 seconds
  });
  it("removes markup, ASS-style overrides and decodes entities; text is plain", () => {
    const r = ok("1\n00:00:01,000 --> 00:00:02,000\n<i>Italic</i> and <font color=\"#ff0000\">red</font> {\\an8}top &amp; &lt;b&gt; &nbsp;done\n");
    expect(r.cues[0][2]).toBe("Italic and red top & <b> done");
    expect(cleanCueText("<script>alert(1)</script>Hi")).toBe("alert(1)Hi"); // tags go; nothing is ever drawn as HTML anyway
  });
});

describe("WebVTT", () => {
  it("skips the header, notes, styles and regions, ignores cue ids and settings, allows times without hours", () => {
    const r = ok("WEBVTT - title\n\nNOTE a comment\nover two lines\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:03.000 line:90% align:center\n<v Bob>Hello</v>\n\n01:00:00.000 --> 01:00:01.000\nHour long\n");
    expect(r.format).toBe("vtt");
    expect(r.cues).toEqual([[1, 3, "Hello"], [3600, 3601, "Hour long"]]);
  });
  it("handles a byte-order mark at the start", () => {
    expect(ok("﻿WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n").cues).toHaveLength(1);
  });
});

describe("ASS / SSA", () => {
  const ass = "[Script Info]\nTitle: x\n\n[V4+ Styles]\nFormat: Name, Fontname\nStyle: Default,Arial\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
  it("reads dialogue lines, with commas in the text, line breaks, overrides and hard spaces", () => {
    const r = ok(ass + "Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}Hello, world\\NSecond\\hline\nDialogue: 0,0:01:02.25,0:01:04.00,Default,,0,0,0,,Bye\n");
    expect(r.format).toBe("ass");
    expect(r.cues).toEqual([[1, 3.5, "Hello, world\nSecond line"], [62.25, 64, "Bye"]]);
  });
  it("ignores comments, drawings and other sections, and honours a different column order", () => {
    const r = ok("[Events]\nFormat: Start, End, Text\nComment: 0:00:00.00,0:00:01.00,hidden\nDialogue: 0:00:02.00,0:00:03.00,{\\p1}m 0 0 l 10 10{\\p0}\nDialogue: 0:00:04.00,0:00:05.00,Real words\n");
    expect(r.cues).toEqual([[4, 5, "Real words"]]);
  });
});

describe("detecting and refusing", () => {
  it("tells the formats apart", () => {
    expect(detectFormat("WEBVTT\n")).toBe("vtt");
    expect(detectFormat("[Script Info]\n")).toBe("ass");
    expect(detectFormat("1\n00:00:01,000 --> 00:00:02,000\nx")).toBe("srt");
    expect(detectFormat("hello")).toBeNull();
  });
  it("refuses a file that isn't subtitles, or has nothing readable, with a clear message", () => {
    expect(parseSubtitles("just some text")).toEqual({ ok: false, error: expect.stringContaining("doesn't look like a subtitle") });
    expect(parseSubtitles("WEBVTT\n\nnothing here\n")).toEqual({ ok: false, error: expect.stringContaining("No subtitles could be read") });
    expect(parseSubtitleBytes(new Uint8Array())).toEqual({ ok: false, error: expect.stringContaining("empty") });
  });
  it("refuses a file over the size limit before reading it", () => {
    const big = new Uint8Array(MAX_SUBTITLE_BYTES + 1).fill(65);
    expect(parseSubtitleBytes(big)).toEqual({ ok: false, error: expect.stringContaining("too large") });
  });
});

describe("encodings", () => {
  it("reads UTF-8 (with or without a mark), UTF-16 in both orders, and falls back to Windows-1252", () => {
    const text = "1\n00:00:01,000 --> 00:00:02,000\nCafé ñandú 你好\n";
    expect(parseSubtitleBytes(bytes(text))).toMatchObject({ ok: true });
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(text)]);
    expect((parseSubtitleBytes(withBom) as { cues: Cue[] }).cues[0][2]).toBe("Café ñandú 你好");
    const le = new Uint8Array([0xff, 0xfe, ...[...text].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])]);
    expect((parseSubtitleBytes(le) as { cues: Cue[] }).cues[0][2]).toBe("Café ñandú 你好");
    const be = new Uint8Array([0xfe, 0xff, ...[...text].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255])]);
    expect((parseSubtitleBytes(be) as { cues: Cue[] }).cues[0][2]).toBe("Café ñandú 你好");
    // "Café" in Windows-1252: é is the single byte 0xE9, which is not valid UTF-8
    const latin = new Uint8Array([...bytes("1\n00:00:01,000 --> 00:00:02,000\nCaf"), 0xe9, ...bytes("\n")]);
    expect((parseSubtitleBytes(latin) as { cues: Cue[] }).cues[0][2]).toBe("Café");
    expect(decodeSubtitleBytes(latin)).toContain("Café");
  });
});

describe("hostile input", () => {
  it("caps the number of cues", () => {
    const many = Array.from({ length: MAX_CUES + 500 }, (_, i) => `${i + 1}\n00:00:00,000 --> 00:00:01,000\nx${i}`).join("\n\n");
    const r = ok(many);
    expect(r.cues.length).toBeLessThanOrEqual(MAX_CUES);
  });
  it("is quick on pathological text: very long lines, unclosed tags and braces, a million arrows", () => {
    const started = Date.now();
    const cases = [
      "1\n00:00:01,000 --> 00:00:02,000\n" + "<".repeat(1_500_000),
      "1\n00:00:01,000 --> 00:00:02,000\n" + "{".repeat(1_500_000),
      "1\n00:00:01,000 --> 00:00:02,000\n" + "<i".repeat(700_000),
      "-->".repeat(500_000),
      "WEBVTT\n\n" + "a".repeat(1_900_000),
      "[Events]\nFormat: " + "a,".repeat(300_000) + "Text\nDialogue: " + ",".repeat(900_000),
    ];
    for (const c of cases) parseSubtitleBytes(bytes(c));
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it("truncates one enormous line of text rather than keeping it", () => {
    const r = ok("1\n00:00:01,000 --> 00:00:02,000\n" + "x".repeat(50_000));
    expect(r.cues[0][2].length).toBeLessThanOrEqual(1_000);
  });
  it("removes control characters from the words", () => {
    expect(ok("1\n00:00:01,000 --> 00:00:02,000\nA\u0007B\u0000C\n").cues[0][2]).toBe("ABC");
  });
});

describe("activeCues", () => {
  const cues: Cue[] = [[1, 3, "a"], [2, 4, "b"], [5, 6, "c"], [10, 11, "d"]];
  it("returns what is showing at a time, including overlaps, and nothing in the gaps", () => {
    expect(activeCues(cues, 0.5)).toEqual([]);
    expect(activeCues(cues, 2.5).map((c) => c[2])).toEqual(["a", "b"]);
    expect(activeCues(cues, 4.5)).toEqual([]);
    expect(activeCues(cues, 5)).toEqual([[5, 6, "c"]]);
    expect(activeCues(cues, 6)).toEqual([]); // the end is not included
    expect(activeCues(cues, 10.5).map((c) => c[2])).toEqual(["d"]);
    expect(activeCues([], 5)).toEqual([]);
  });
  it("shifts the whole track by an offset (positive comes later)", () => {
    expect(activeCues(cues, 2.5, 2).map((c) => c[2])).toEqual([]);
    expect(activeCues(cues, 3.5, 2).map((c) => c[2])).toEqual(["a"]); // 1.5 seconds into the track: only "a" has started
    expect(activeCues(cues, 4.5, 2).map((c) => c[2])).toEqual(["a", "b"]);
    expect(activeCues(cues, 1.5, -1).map((c) => c[2])).toEqual(["a", "b"]);
  });
});
