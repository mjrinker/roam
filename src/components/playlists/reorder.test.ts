import { describe, expect, it } from "vitest";
import { moveTo } from "./reorder";

const list = ["a", "b", "c", "d"].map((id) => ({ id }));
const ids = (r: ReturnType<typeof moveTo>) => r?.items.map((i) => i.id).join("");

describe("moveTo", () => {
  it("moves down: lands after the item that ends up above it", () => {
    const r = moveTo(list, 0, 2);
    expect(ids(r)).toBe("bcad");
    expect(r?.afterId).toBe("c");
  });

  it("moves up: lands after the item that ends up above it", () => {
    const r = moveTo(list, 3, 1);
    expect(ids(r)).toBe("adbc");
    expect(r?.afterId).toBe("a");
  });

  it("moving to the top asks for 'after nothing'", () => {
    const r = moveTo(list, 2, 0);
    expect(ids(r)).toBe("cabd");
    expect(r?.afterId).toBeNull();
  });

  it("moving to the very end goes after the last item", () => {
    const r = moveTo(list, 0, 3);
    expect(ids(r)).toBe("bcda");
    expect(r?.afterId).toBe("d");
  });

  it("does nothing for a no-op or out-of-range move, and doesn't change the input", () => {
    expect(moveTo(list, 1, 1)).toBeNull();
    expect(moveTo(list, -1, 2)).toBeNull();
    expect(moveTo(list, 1, 4)).toBeNull();
    moveTo(list, 0, 3);
    expect(list.map((i) => i.id).join("")).toBe("abcd");
  });
});
