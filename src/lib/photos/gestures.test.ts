import { describe, expect, it } from "vitest";
import { clampPan, CLOSE_DISTANCE, dragAxis, isDoubleTap, isTap, maxPan, MAX_SCALE, panForZoom, pinchScale, settleScale, shouldClose } from "./gestures";

describe("pinch", () => {
  it("scales with the spread of the fingers, within limits", () => {
    expect(pinchScale(100, 200, 1)).toBe(2);
    expect(pinchScale(100, 150, 2)).toBe(3);
    expect(pinchScale(100, 10_000, 1)).toBe(MAX_SCALE);
    expect(pinchScale(100, 10, 1)).toBeCloseTo(0.8); // a little give below 1
    expect(pinchScale(0, 200, 1.7)).toBe(1.7); // a degenerate start changes nothing
    expect(pinchScale(100, NaN, 1.7)).toBe(1.7);
  });
  it("snaps back to exactly 1 near or below it, and keeps real zoom", () => {
    expect(settleScale(0.8)).toBe(1);
    expect(settleScale(1.04)).toBe(1);
    expect(settleScale(1.5)).toBe(1.5);
    expect(settleScale(9)).toBe(MAX_SCALE);
  });
});

describe("panning a zoomed picture", () => {
  const frame = { w: 400, h: 800 };
  it("allows no movement at 1x and half the extra size each way when zoomed", () => {
    expect(maxPan(1, frame)).toEqual({ x: 0, y: 0 });
    expect(maxPan(2, frame)).toEqual({ x: 200, y: 400 });
  });
  it("keeps the picture's edge from leaving the frame", () => {
    expect(clampPan({ x: 999, y: -999 }, 2, frame)).toEqual({ x: 200, y: -400 });
    expect(clampPan({ x: 50, y: 60 }, 2, frame)).toEqual({ x: 50, y: 60 });
    expect(clampPan({ x: 50, y: 60 }, 1, frame)).toEqual({ x: 0, y: 0 });
  });
  it("zooming on a point keeps that point still", () => {
    expect(panForZoom({ x: 0, y: 0 }, 1, 2, { x: 100, y: 0 })).toEqual({ x: -100, y: 0 });
    expect(panForZoom({ x: 0, y: 0 }, 1, 1, { x: 100, y: 50 })).toEqual({ x: 0, y: 0 });
  });
});

describe("drag direction and closing", () => {
  it("waits for a few pixels, then picks sideways or vertical", () => {
    expect(dragAxis(3, 4)).toBeNull();
    expect(dragAxis(30, 5)).toBe("x");
    expect(dragAxis(-30, 5)).toBe("x");
    expect(dragAxis(5, 30)).toBe("y");
    expect(dragAxis(20, 20)).toBe("y"); // a diagonal counts as vertical: it won't flip photos by accident
  });
  it("closes on a long downward drag or a short quick one, never upward", () => {
    expect(shouldClose(CLOSE_DISTANCE, 900)).toBe(true);
    expect(shouldClose(CLOSE_DISTANCE - 1, 900)).toBe(false);
    expect(shouldClose(60, 120)).toBe(true);
    expect(shouldClose(60, 600)).toBe(false);
    expect(shouldClose(20, 50)).toBe(false);
    expect(shouldClose(-400, 50)).toBe(false);
    expect(shouldClose(0, 10)).toBe(false);
  });
});

describe("taps", () => {
  it("a tap barely moves and is quick", () => {
    expect(isTap({ x: 10, y: 10, t: 0 }, { x: 12, y: 11, t: 120 })).toBe(true);
    expect(isTap({ x: 10, y: 10, t: 0 }, { x: 60, y: 10, t: 100 })).toBe(false);
    expect(isTap({ x: 10, y: 10, t: 0 }, { x: 10, y: 10, t: 900 })).toBe(false);
  });
  it("two quick taps close together are a double tap", () => {
    const a = { x: 100, y: 100, t: 1000 };
    expect(isDoubleTap(a, { x: 110, y: 105, t: 1200 })).toBe(true);
    expect(isDoubleTap(a, { x: 110, y: 105, t: 1400 })).toBe(false);
    expect(isDoubleTap(a, { x: 300, y: 100, t: 1100 })).toBe(false);
    expect(isDoubleTap(null, a)).toBe(false);
  });
});
