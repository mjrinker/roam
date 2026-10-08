import { describe, expect, it } from "vitest";
import { pickNext, type Box } from "./focus";

const box = (col: number, row: number, w = 100, h = 150, gapX = 20, gapY = 30): Box => ({ left: col * (w + gapX), top: row * (h + gapY), right: col * (w + gapX) + w, bottom: row * (h + gapY) + h });
const grid = (cols: number, rows: number) => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => box(c, r))).flat();
const at = (cols: number, c: number, r: number) => r * cols + c;

describe("pickNext", () => {
  const cols = 4;
  const cells = grid(cols, 3);
  const move = (c: number, r: number, dir: Parameters<typeof pickNext>[2]) => pickNext(cells[at(cols, c, r)], cells.filter((_, i) => i !== at(cols, c, r)), dir);
  const cellOf = (c: number, r: number, dir: Parameters<typeof pickNext>[2]) => {
    const others = cells.map((b, i) => [b, i] as const).filter(([, i]) => i !== at(cols, c, r));
    const pick = pickNext(cells[at(cols, c, r)], others.map(([b]) => b), dir);
    return pick < 0 ? null : [others[pick][1] % cols, Math.floor(others[pick][1] / cols)];
  };

  it("moves one cell along a grid in each direction", () => {
    expect(cellOf(1, 1, "right")).toEqual([2, 1]);
    expect(cellOf(1, 1, "left")).toEqual([0, 1]);
    expect(cellOf(1, 1, "down")).toEqual([1, 2]);
    expect(cellOf(1, 1, "up")).toEqual([1, 0]);
  });
  it("stops at the edges instead of wrapping", () => {
    expect(cellOf(0, 0, "left")).toBeNull();
    expect(cellOf(0, 0, "up")).toBeNull();
    expect(cellOf(3, 2, "right")).toBeNull();
    expect(cellOf(3, 2, "down")).toBeNull();
    expect(move(0, 0, "left")).toBe(-1);
  });
  it("prefers its own row or column over a nearer cell that is off to the side", () => {
    // a wide button under a row of tiles: down from the second tile goes to the button, and back up returns to the same column
    const tiles = [box(0, 0), box(1, 0), box(2, 0)];
    const button: Box = { left: 0, top: 200, right: 340, bottom: 260 };
    expect(pickNext(tiles[1], [tiles[0], tiles[2], button], "down")).toBe(2);
    expect(pickNext(button, tiles, "up")).toBeGreaterThanOrEqual(0);
  });
  it("jumps to the nearest row when a row is shorter", () => {
    const top = [box(0, 0), box(1, 0), box(2, 0), box(3, 0)];
    const bottom = [box(0, 1), box(1, 1)];
    expect(pickNext(top[3], bottom, "down")).toBe(1); // the right-most cell below
  });
  it("handles an empty list, a lone element and overlapping boxes", () => {
    expect(pickNext(box(0, 0), [], "right")).toBe(-1);
    expect(pickNext(box(0, 0), [box(0, 0)], "right")).toBe(-1);
    const a: Box = { left: 0, top: 0, right: 100, bottom: 100 };
    const b: Box = { left: 60, top: 0, right: 160, bottom: 100 };
    expect(pickNext(a, [b], "right")).toBe(0);
    expect(pickNext(a, [b], "left")).toBe(-1);
  });
  it("is deterministic when two candidates tie", () => {
    const from = box(1, 1);
    const l = box(0, 1);
    const r = box(2, 1);
    expect(pickNext(from, [l, r], "right")).toBe(1);
    expect(pickNext(from, [r, l], "right")).toBe(0);
  });
});
