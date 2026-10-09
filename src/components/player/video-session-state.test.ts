import { describe, expect, it } from "vitest";
import { needsFreshPlayer, NO_SESSION, progressPercent, sameVideo, videoSessionReducer, type VideoSessionInfo } from "./video-session-state";

const movie: VideoSessionInfo = { ownerKind: "title", ownerId: "m1", title: "Film", backHref: "/s/x/title/m1", watchHref: "/s/x/watch/title/m1" };
const episode: VideoSessionInfo = { ownerKind: "episode", ownerId: "e1", title: "Show", subtitle: "S1 · E1", backHref: "/s/x/show/s", nextHref: "/s/x/watch/episode/e2", watchHref: "/s/x/watch/episode/e1" };

describe("the video session", () => {
  it("opens full screen, shrinks to the bar when the viewer leaves, and comes back when they return", () => {
    let s = videoSessionReducer(NO_SESSION, { type: "open", session: movie });
    expect(s).toEqual({ session: movie, expanded: true });
    s = videoSessionReducer(s, { type: "minimize" });
    expect(s).toEqual({ session: movie, expanded: false });
    s = videoSessionReducer(s, { type: "open", session: movie });
    expect(s.expanded).toBe(true);
    expect(s.session).toBe(movie);
  });
  it("opening another video replaces the first, and closing forgets everything", () => {
    let s = videoSessionReducer(NO_SESSION, { type: "open", session: movie });
    s = videoSessionReducer(s, { type: "open", session: episode });
    expect(s.session).toBe(episode);
    expect(videoSessionReducer(s, { type: "close" })).toEqual(NO_SESSION);
  });
  it("minimizing or closing with nothing open changes nothing", () => {
    expect(videoSessionReducer(NO_SESSION, { type: "minimize" })).toBe(NO_SESSION);
    expect(videoSessionReducer(NO_SESSION, { type: "close" })).toEqual(NO_SESSION);
  });
  it("tells the same video from a different one", () => {
    expect(sameVideo(movie, { ...movie, title: "Renamed" })).toBe(true);
    expect(sameVideo(movie, episode)).toBe(false);
    expect(sameVideo(movie, { ...movie, ownerKind: "episode" })).toBe(false);
  });
});

describe("progressPercent", () => {
  it("is a fraction of the length, kept between 0 and 100, and 0 when the length is unknown", () => {
    expect(progressPercent(30, 120)).toBe(25);
    expect(progressPercent(500, 120)).toBe(100);
    expect(progressPercent(-5, 120)).toBe(0);
    expect(progressPercent(10, 0)).toBe(0);
  });
});

describe("needsFreshPlayer", () => {
  const live = { finished: false, error: null, ready: true };
  it("is yes for the same video again after it finished, or after it failed to load", () => {
    expect(needsFreshPlayer(movie, movie, { ...live, finished: true })).toBe(true);
    expect(needsFreshPlayer(movie, movie, { finished: false, error: "Playback failed", ready: false })).toBe(true);
  });
  it("is no while it is still playing, for another video, with nothing open, or with no news from the player yet", () => {
    expect(needsFreshPlayer(movie, movie, live)).toBe(false);
    expect(needsFreshPlayer(movie, episode, { ...live, finished: true })).toBe(false);
    expect(needsFreshPlayer(null, movie, { ...live, finished: true })).toBe(false);
    expect(needsFreshPlayer(movie, movie, null)).toBe(false);
    // an error after it had loaded (a reconnect blip) is not a reason to start over
    expect(needsFreshPlayer(movie, movie, { finished: false, error: "Reconnecting…", ready: true })).toBe(false);
  });
});
