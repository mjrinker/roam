import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { audioFragment, audioInit, audioTrack, describeTracks, fetchMoov, fragmentRange, readSamples, readTracks, samplesOf, textCues, textTrack, type ByteRangeFetcher } from "./mp4-tracks";

const file = readFileSync("src/lib/media-tracks/fixtures/multi.mp4");
const fetchRange: ByteRangeFetcher = async (start, end) => {
  const part = file.subarray(start, end + 1);
  return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) as ArrayBuffer;
};

async function tracks() {
  return readTracks(await fetchMoov(fetchRange, file.length)).tracks;
}

describe("reading the tracks of an MP4", () => {
  it("lists audio tracks with language and name, and the text tracks", async () => {
    const d = describeTracks(await tracks());
    expect(d.audioTracks.map((a) => [a.index, a.language, a.label, a.codec, a.channels, a.default])).toEqual([
      [0, "eng", "English 5.1", "mp4a", 1, true],
      [1, "spa", "Spanish Stereo", "mp4a", 1, false],
      [2, "por", "Portuguese Stereo", "mp4a", 2, false],
    ]);
    expect(d.audioTracks.every((a) => a.mime?.startsWith("audio/mp4"))).toBe(true);
    expect(d.textTracks.map((t) => [t.index, t.language, t.label])).toEqual([[0, "eng", "English"], [1, "spa", "Spanish"]]);
  });

  it("finds every sample of an audio track and where it plays", async () => {
    const t = audioTrack(await tracks(), 2)!;
    const s = samplesOf(t);
    expect(s.count).toBeGreaterThan(900); // 20 s of 48 kHz in 1024-sample frames
    expect(s.time[0]).toBe(0);
    expect(s.time[1]).toBe(s.duration[0]);
    const last = s.count - 1;
    expect((s.time[last] + s.duration[last]) / t.timescale).toBeCloseTo(20, 0);
    // The samples are inside the file, in order, without overlap.
    for (let i = 1; i < s.count; i++) expect(s.offset[i]).toBeGreaterThanOrEqual(s.offset[i - 1] + s.size[i - 1]);
    expect(s.offset[last] + s.size[last]).toBeLessThanOrEqual(file.length);
  });

  it("cuts a fragment whose samples are the file's own bytes, and sums to the whole track", async () => {
    const t = audioTrack(await tracks(), 1)!;
    const s = samplesOf(t);
    let total = 0;
    for (let n = 0; n < 2; n++) {
      const [from, to] = fragmentRange(s, t.timescale, n);
      total += to - from;
      const data = await readSamples(fetchRange, s, from, to);
      expect(data.map((d) => d.length)).toEqual(Array.from(s.size.subarray(from, to)));
      const frag = audioFragment(s, from, to, data, n + 1);
      const view = new DataView(frag.buffer, frag.byteOffset, frag.byteLength);
      const moofSize = view.getUint32(0);
      expect(String.fromCharCode(...frag.subarray(4, 8))).toBe("moof");
      expect(String.fromCharCode(...frag.subarray(moofSize + 4, moofSize + 8))).toBe("mdat");
      expect(view.getUint32(moofSize)).toBe(frag.length - moofSize);
      // trun's data offset points at the first sample, just past the mdat header.
      const trunAt = frag.findIndex((_, i) => String.fromCharCode(...frag.subarray(i, i + 4)) === "trun");
      expect(view.getUint32(trunAt + 4 + 4 + 4)).toBe(moofSize + 8);
    }
    expect(total).toBe(s.count);
  });

  it("makes an init segment that is a movie with one audio track and no samples", async () => {
    const init = audioInit(audioTrack(await tracks(), 0)!);
    const text = Buffer.from(init).toString("latin1");
    for (const word of ["ftyp", "moov", "mvex", "trex", "stsd", "mp4a", "soun"]) expect(text).toContain(word);
    expect(text).not.toContain("avc1");
  });

  it("reads the subtitle words of each text track", async () => {
    const all = await tracks();
    expect(await textCues(fetchRange, textTrack(all, 0)!)).toEqual([
      [1, 3.5, "Hello there."],
      [5, 7, "Second line\nwith two rows"],
      [12.25, 14, "Tercero & last"],
    ]);
    expect((await textCues(fetchRange, textTrack(all, 1)!))[1][2]).toBe("Segunda línea\nen dos filas");
  });
});
