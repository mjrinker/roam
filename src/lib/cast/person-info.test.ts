import { describe, expect, it } from "vitest";
import { buildPersonInfo, creditKeys, OFF_SERVER_LIMIT } from "./person-info";
import type { TmdbCombinedCredit, TmdbPerson } from "@/lib/tmdb/client";

const credit = (id: number, over: Partial<TmdbCombinedCredit> = {}): TmdbCombinedCredit => ({ id, media_type: "movie", title: `Movie ${id}`, release_date: "2010-05-01", poster_path: `/p${id}.jpg`, popularity: id, ...over });
const person = (over: Partial<TmdbPerson> = {}): TmdbPerson => ({ id: 1, name: "Pat", ...over });

describe("a person's bio and work not on the server", () => {
  it("passes on the bio and where and when they were born", () => {
    const info = buildPersonInfo(person({ biography: "  Pat is an actor.  ", birthday: "1956-07-09", place_of_birth: "Concord, California, USA" }), new Set());
    expect(info).toMatchObject({ bio: "Pat is an actor.", born: "Born July 9, 1956 in Concord, California, USA", died: null });
    expect(buildPersonInfo(person({ birthday: "1930-01-02", deathday: "2001-12-31" }), new Set())).toMatchObject({ born: "Born January 2, 1930", died: "Died December 31, 2001" });
    expect(buildPersonInfo(person({ biography: "", place_of_birth: "Paris" }), new Set())).toMatchObject({ bio: null, born: "Born in Paris" });
    expect(buildPersonInfo(person({ birthday: "not a date" }), new Set())).toMatchObject({ born: null });
  });
  it("lists their other work, skipping what is on the server (a movie and a show with the same id are different things)", () => {
    const info = buildPersonInfo(
      person({ combined_credits: { cast: [credit(10, { character: "Hero" }), credit(11), credit(12, { media_type: "tv", name: "A Show", first_air_date: "2005-01-01", release_date: undefined, title: undefined })], crew: [] } }),
      new Set(["movie:10", "tv:11"])
    );
    expect(info.offServer.map((o) => [o.key, o.title, o.year])).toEqual([["movie:11", "Movie 11", 2010], ["tv:12", "A Show", 2005]]);
    expect(info.offServer.find((o) => o.key === "tv:12")).toMatchObject({ href: "https://www.themoviedb.org/tv/12", posterUrl: expect.stringContaining("/p12.jpg") });
  });
  it("leaves out appearances as oneself, talk shows and news, entries with no poster, and crew work that isn't a key job", () => {
    const info = buildPersonInfo(
      person({
        combined_credits: {
          cast: [
            credit(1, { character: "Himself" }),
            credit(2, { character: "Self - Guest" }),
            credit(3, { media_type: "tv", name: "Late Show", genre_ids: [10767] }),
            credit(4, { poster_path: null }),
            credit(5, { character: "Real Role" }),
            credit(6, { media_type: "person" }),
          ],
          crew: [credit(7, { job: "Gaffer" }), credit(8, { job: "Director" })],
        },
      }),
      new Set()
    );
    expect(info.offServer.map((o) => o.key).sort()).toEqual(["movie:5", "movie:8"]);
  });
  it("shows all of a person's roles on one title, acting and crew", () => {
    const info = buildPersonInfo(person({ combined_credits: { cast: [credit(5, { character: "The Lead / Narrator" })], crew: [credit(5, { job: "Director" }), credit(5, { job: "Original Music Composer" })] } }), new Set());
    expect(info.offServer).toHaveLength(1);
    expect(info.offServer[0].roles).toEqual(["as The Lead", "Director", "Composer"]);
  });
  it("keeps the most popular up to the limit, shown newest first", () => {
    const cast = Array.from({ length: OFF_SERVER_LIMIT + 10 }, (_, i) => credit(100 + i, { popularity: i, release_date: `${1980 + (i % 40)}-01-01` }));
    const info = buildPersonInfo(person({ combined_credits: { cast, crew: [] } }), new Set());
    expect(info.offServer).toHaveLength(OFF_SERVER_LIMIT);
    expect(info.offServer.some((o) => o.key === "movie:100")).toBe(false); // the least popular were cut
    const years = info.offServer.map((o) => o.year!);
    expect(years).toEqual([...years].sort((a, b) => b - a));
  });
  it("lists every movie and show in the credits once, for asking which are on the server", () => {
    const keys = creditKeys(person({ combined_credits: { cast: [credit(1), credit(2, { media_type: "tv" }), credit(3, { media_type: "person" })], crew: [credit(1, { job: "Director" })] } }));
    expect(keys.sort()).toEqual(["movie:1", "tv:2"]);
  });
});
