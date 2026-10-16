import { describe, expect, it } from "vitest";
import { groupTiles } from "./group";

const card = (id: string) => ({ id, name: id, kind: "tmdb" as const, count: 2, posterUrl: null });
const index = { cards: { A: card("A"), B: card("B") }, byTitle: { a1: "A", a2: "A", b1: "B" } };
const items = (...ids: string[]) => ids.map((id) => ({ id }));
const shape = (tiles: ReturnType<typeof groupTiles<{ id: string }>>) => tiles.map((t) => (t.kind === "title" ? t.item.id : `[${t.card.id}@${t.firstId}]`));

describe("groupTiles", () => {
  it("puts a collection where its first title is and drops the rest, keeping everything else in order", () => {
    expect(shape(groupTiles(items("x", "a1", "y", "b1", "a2", "z"), index))).toEqual(["x", "[A@a1]", "y", "[B@b1]", "z"]);
  });
  it("follows the order given (a different sort puts the tile somewhere else)", () => {
    expect(shape(groupTiles(items("a2", "x", "a1"), index))).toEqual(["[A@a2]", "x"]);
  });
  it("leaves a title alone whose collection isn't one this profile sees, and passes everything through with no index", () => {
    expect(shape(groupTiles(items("a1", "c1"), { cards: {}, byTitle: { a1: "A" } }))).toEqual(["a1", "c1"]);
    expect(shape(groupTiles(items("a1", "a2"), { cards: {}, byTitle: {} }))).toEqual(["a1", "a2"]);
    expect(groupTiles([], index)).toEqual([]);
  });
});
