import { describe, expect, it } from "vitest";
import { decide, sharedPositionNow, type LocalState, type SharedState } from "./sync";

const shared = (over: Partial<SharedState> = {}): SharedState => ({ playing: false, position: 100, rate: 1, seq: 1, at: 1_000_000, now: 1_000_000, ...over });
const look = (over: { previous?: LocalState | null; elapsedMs?: number; local: LocalState; shared?: SharedState; seenSeq?: number }) => decide({ previous: null, elapsedMs: 1500, shared: shared(), seenSeq: 1, ...over });

describe("where the shared video is", () => {
  it("stays put while paused and moves on while playing, at the room's speed", () => {
    expect(sharedPositionNow(shared())).toBe(100);
    expect(sharedPositionNow(shared({ playing: true, now: 1_010_000 }))).toBe(110);
    expect(sharedPositionNow(shared({ playing: true, rate: 2, now: 1_010_000 }))).toBe(120);
  });
});

describe("the viewer's own actions are pushed", () => {
  it("pushes pressing pause, pressing play, and a jump", () => {
    expect(look({ previous: { playing: true, time: 100 }, local: { playing: false, time: 101.4 }, shared: shared({ playing: true }) })).toEqual({ kind: "push", playing: false, position: 101.4 });
    expect(look({ previous: { playing: false, time: 100 }, local: { playing: true, time: 100 } })).toEqual({ kind: "push", playing: true, position: 100 });
    expect(look({ previous: { playing: true, time: 100 }, local: { playing: true, time: 500 }, shared: shared({ playing: true, now: 1_001_500 }) })).toEqual({ kind: "push", playing: true, position: 500 });
  });
  it("does not mistake playing along, or a small hiccup, for the viewer's action", () => {
    expect(look({ previous: { playing: true, time: 100 }, local: { playing: true, time: 101.5 }, shared: shared({ playing: true, position: 100, now: 1_001_500 }) })).toEqual({ kind: "none" });
  });
  it("does not push a change that only follows what the room already says", () => {
    // paused here, and the room paused at 105: this player just brought itself in line
    expect(look({ previous: { playing: true, time: 105 }, local: { playing: false, time: 105 }, shared: shared({ playing: false, position: 105, seq: 4 }), seenSeq: 3 })).toEqual({ kind: "follow", playing: false, position: 105, seq: 4 });
  });
});

describe("following the others", () => {
  it("follows a new change: play, pause and a jump, to where the room is now", () => {
    expect(look({ previous: { playing: false, time: 50 }, local: { playing: false, time: 50 }, shared: shared({ playing: true, position: 200, at: 1_000_000, now: 1_004_000, seq: 2 }), seenSeq: 1 })).toEqual({ kind: "follow", playing: true, position: 204, seq: 2 });
    expect(look({ previous: { playing: true, time: 60 }, local: { playing: true, time: 61.5 }, shared: shared({ playing: false, position: 61.5, seq: 3 }), seenSeq: 2 })).toEqual({ kind: "follow", playing: false, position: 61.5, seq: 3 });
  });
  it("joining a room starts from the room, not from where this player was", () => {
    expect(look({ previous: null, local: { playing: false, time: 0 }, shared: shared({ playing: true, position: 900, seq: 7, now: 1_000_000 }), seenSeq: 0 })).toEqual({ kind: "follow", playing: true, position: 900, seq: 7 });
  });
  it("notes a change it is already in line with without moving", () => {
    expect(look({ previous: { playing: true, time: 100 }, local: { playing: true, time: 101.5 }, shared: shared({ playing: true, position: 100, seq: 2, now: 1_001_500 }), seenSeq: 1 })).toEqual({ kind: "follow", playing: true, position: 101.5, seq: 2 });
  });
  it("pulls back when it has drifted well away while both play, and otherwise leaves things be", () => {
    expect(look({ previous: { playing: true, time: 100 }, local: { playing: true, time: 101.5 }, shared: shared({ playing: true, position: 110, at: 1_000_000, now: 1_001_500 }) })).toEqual({ kind: "follow", playing: true, position: 111.5, seq: 1 });
    expect(look({ previous: { playing: false, time: 100 }, local: { playing: false, time: 100 }, shared: shared() })).toEqual({ kind: "none" });
  });
});

// Two players and a room, looked at every 1.5 s: whatever one does, both end up in the same place, and nothing ping-pongs.
describe("two players converge", () => {
  class Room {
    playing = false;
    position = 0;
    at = 0;
    seq = 0;
    pushes = 0;
    state(now: number): SharedState {
      return { playing: this.playing, position: this.position, rate: 1, seq: this.seq, at: this.at, now };
    }
    set(playing: boolean, position: number, now: number) {
      this.playing = playing;
      this.position = position;
      this.at = now;
      this.seq++;
      this.pushes++;
    }
  }
  class Player {
    local: LocalState = { playing: false, time: 0 };
    previous: LocalState | null = null;
    seen = 0;
    lastAt = 0;
    constructor(readonly room: Room, start: number) {
      this.lastAt = start;
    }
    advance(ms: number) {
      if (this.local.playing) this.local = { ...this.local, time: this.local.time + ms / 1000 };
    }
    look(now: number) {
      const d = decide({ previous: this.previous, elapsedMs: now - this.lastAt, local: this.local, shared: this.room.state(now), seenSeq: this.seen });
      this.lastAt = now;
      if (d.kind === "push") {
        this.room.set(d.playing, d.position, now);
        this.seen = this.room.seq;
        this.previous = this.local;
      } else if (d.kind === "follow") {
        this.seen = d.seq;
        this.local = { playing: d.playing, time: d.position };
        this.previous = this.local;
      } else this.previous = this.local;
    }
  }
  function run(actions: Record<number, (a: Player, b: Player) => void>, ticks = 30) {
    const room = new Room();
    const a = new Player(room, 0);
    const b = new Player(room, 0);
    for (let i = 1; i <= ticks; i++) {
      const now = i * 1500;
      a.advance(1500);
      b.advance(1500);
      actions[i]?.(a, b);
      a.look(now);
      b.look(now + 200);
    }
    return { room, a, b };
  }

  it("follows play, pause and a jump made by either, and settles", () => {
    const { room, a, b } = run({
      2: (a) => (a.local = { playing: true, time: a.local.time }), // A presses play
      8: (_a, b) => (b.local = { playing: false, time: b.local.time }), // B pauses
      12: (a) => (a.local = { playing: false, time: 600 }), // A jumps while paused
      16: (_a, b) => (b.local = { playing: true, time: b.local.time }), // B plays
    });
    expect(a.local.playing).toBe(b.local.playing);
    expect(Math.abs(a.local.time - b.local.time)).toBeLessThan(3);
    expect(a.local.playing).toBe(true);
    expect(a.local.time).toBeGreaterThan(600);
    // Each of the four actions was pushed once: no echoing back and forth.
    expect(room.pushes).toBe(4);
  });

  it("brings a late joiner to where the room is, without disturbing it", () => {
    const room = new Room();
    room.set(true, 300, 0);
    const late = new Player(room, 0);
    late.look(6000);
    expect(late.local.playing).toBe(true);
    expect(late.local.time).toBeCloseTo(306, 0);
    expect(room.pushes).toBe(1);
  });
});
