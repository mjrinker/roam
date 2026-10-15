/** LRC, the format synced lyrics come in: "[01:23.45] words" lines. */
export interface LyricLine {
  /** Seconds into the song. */
  t: number;
  text: string;
}

const TIME = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** The lines of an LRC text in time order. A line may carry several times (a repeated chorus); tags like [ar:Artist] are ignored. */
export function parseLrc(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const times = [...raw.matchAll(TIME)];
    if (times.length === 0) continue;
    const words = raw.replace(TIME, "").trim();
    for (const m of times) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      out.push({ t: Number(m[1]) * 60 + Number(m[2]) + frac, text: words });
    }
  }
  return out.sort((a, b) => a.t - b.t).slice(0, 2000);
}

/** The index of the line being sung at `t` (the last one that has started), or -1 before the first. `offset` shifts the whole track. */
export function lineAt(lines: readonly LyricLine[], t: number, offset = 0): number {
  const time = t - offset;
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
