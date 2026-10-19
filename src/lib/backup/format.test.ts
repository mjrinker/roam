import { describe, expect, it } from "vitest";
import { buildExport, emptyData, parseCsv, parseImport, type ProfileData } from "./format";

describe("CSV reading", () => {
  it("handles quotes, doubled quotes, commas and line breaks inside a field, and Windows line ends", () => {
    expect(parseCsv('a,b\r\n"x, y","He said ""hi"""\r\n"two\nlines",z\r\n')).toEqual([["a", "b"], ["x, y", 'He said "hi"'], ["two\nlines", "z"]]);
    expect(parseCsv("﻿Name\nA")).toEqual([["Name"], ["A"]]);
  });
});

describe("a Roam export", () => {
  it("round-trips, and drops entries it can't make sense of", () => {
    const data: ProfileData = {
      watched: [{ ref: { kind: "movie", title: "Heat", year: 1995, tmdbId: 949 }, finished: true, positionSeconds: 0, durationSeconds: null, at: "2026-01-02T03:04:05.000Z" }, { ref: { kind: "episode", title: "Lost", year: 2004, tmdbId: 4607, season: 1, number: 2 }, finished: false, positionSeconds: 300, durationSeconds: 2600, at: null }],
      ratings: [{ ref: { kind: "show", title: "Lost", year: 2004, tmdbId: 4607 }, halfStars: 9 }],
      labels: [{ name: "Date night", titles: [{ kind: "movie", title: "Heat", year: 1995, tmdbId: 949 }] }],
      watchlist: [{ kind: "show", title: "Dark", year: 2017, tmdbId: null }],
      photoFavorites: [{ library: "Photos", folder: "2019/Beach", filename: "IMG_0001.JPG" }],
    };
    const text = buildExport(data, { profileName: "Ann", serverName: "Home", now: new Date("2026-10-18T00:00:00Z") });
    const parsed = parseImport(text);
    expect(parsed).toEqual({ ok: true, source: "Roam", data });
    const broken = JSON.parse(text);
    broken.watched.push({ ref: { kind: "movie" } }, { ref: { kind: "episode", title: "X" } });
    broken.ratings.push({ ref: broken.watched[0].ref, halfStars: 99 });
    broken.photoFavorites.push({ library: "", filename: "x.jpg" }, "nope");
    const again = parseImport(JSON.stringify(broken));
    expect(again.ok && again.data.watched).toHaveLength(2);
    expect(again.ok && again.data.ratings).toHaveLength(1);
    expect(again.ok && again.data.photoFavorites).toHaveLength(1);
  });
  it("refuses JSON that isn't one, and text that isn't JSON", () => {
    expect(parseImport('{"format":"other"}')).toEqual({ ok: false, error: "That isn't a Roam export." });
    expect(parseImport("{nope").ok).toBe(false);
    expect(emptyData().watched).toEqual([]);
  });
});

describe("other services' files", () => {
  it("reads Letterboxd's watched.csv and ratings.csv", () => {
    const watched = parseImport("Date,Name,Year,Letterboxd URI\n2024-05-01,Heat,1995,https://boxd.it/x\n2024-05-02,\"Amélie, again\",2001,https://boxd.it/y\n");
    expect(watched.ok && watched.source).toBe("Letterboxd");
    expect(watched.ok && watched.data.watched.map((w) => [w.ref.title, w.ref.year, w.at?.slice(0, 10)])).toEqual([["Heat", 1995, "2024-05-01"], ["Amélie, again", 2001, "2024-05-02"]]);
    const ratings = parseImport("Date,Name,Year,Letterboxd URI,Rating\n2024-05-01,Heat,1995,https://boxd.it/x,4.5\n2024-05-02,Cats,2019,https://boxd.it/z,0.5\n");
    expect(ratings.ok && ratings.data.ratings.map((r) => r.halfStars)).toEqual([9, 1]);
    expect(ratings.ok && ratings.data.watched).toHaveLength(2); // a rated film was seen
  });
  it("reads a plain CSV with types, episodes, ratings and watched", () => {
    const r = parseImport("type,title,year,season,episode,rating,watched\nmovie,Heat,1995,,,5,yes\nepisode,Lost,2004,1,2,,2024-01-01\nmovie,Cats,2019,,,,no\n");
    expect(r.ok && r.source).toBe("CSV");
    expect(r.ok && r.data.watched.map((w) => w.ref)).toEqual([{ kind: "movie", title: "Heat", year: 1995, tmdbId: null }, { kind: "episode", title: "Lost", year: 2004, tmdbId: null, season: 1, number: 2 }]);
    expect(r.ok && r.data.ratings.map((x) => x.halfStars)).toEqual([10]);
  });
  it("says so when the file isn't recognisable or is empty", () => {
    expect(parseImport("foo,bar\n1,2\n").ok).toBe(false);
    expect(parseImport("Name\n").ok).toBe(false);
  });
});
