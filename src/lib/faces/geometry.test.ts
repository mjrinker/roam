import { describe, expect, it } from "vitest";
import { alignFace, decodeYunet, fromBytes, FACE_SIZE, FACE_TEMPLATE, nonMaxSuppression, normalize, similarity, similarityTransform, toBytes, type Detection, type Point } from "./geometry";

const apply = (t: { a: number; b: number; tx: number; ty: number }, p: Point): Point => [t.a * p[0] - t.b * p[1] + t.tx, t.b * p[0] + t.a * p[1] + t.ty];

describe("similarityTransform", () => {
  it("recovers a known turn, scale and shift exactly", () => {
    const known = { a: 1.2 * Math.cos(0.4), b: 1.2 * Math.sin(0.4), tx: 30, ty: -12 };
    const from = FACE_TEMPLATE;
    const to = from.map((p) => apply(known, p));
    const t = similarityTransform(from, to);
    expect(t.a).toBeCloseTo(known.a, 8);
    expect(t.b).toBeCloseTo(known.b, 8);
    expect(t.tx).toBeCloseTo(known.tx, 6);
    expect(t.ty).toBeCloseTo(known.ty, 6);
  });
  it("refuses landmarks that are all one point", () => {
    expect(() => similarityTransform([[1, 1], [1, 1]], [[0, 0], [5, 5]])).toThrow();
  });
});

describe("alignFace", () => {
  it("puts the face on the template: landmarks taken from an image land where the template says", () => {
    // A 200x200 picture whose red channel is the x position and green the y position, so any sample tells where it came from.
    const width = 200;
    const height = 200;
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x, y, 0], (y * width + x) * 3);
    // The face is the template scaled by 1.5 and moved by (40, 30): landmarks in the picture.
    const landmarks = FACE_TEMPLATE.map((p): Point => [p[0] * 1.5 + 40, p[1] * 1.5 + 30]);
    const out = alignFace({ data, width, height }, landmarks);
    const plane = FACE_SIZE * FACE_SIZE;
    // The output pixel at the template's nose came from the picture's nose.
    const [nx, ny] = FACE_TEMPLATE[2];
    const i = Math.round(ny) * FACE_SIZE + Math.round(nx);
    expect(out[i]).toBeCloseTo(landmarks[2][0], 0);
    expect(out[plane + i]).toBeCloseTo(landmarks[2][1], 0);
    expect(out.length).toBe(3 * plane);
  });
  it("is black where the face reaches past the picture", () => {
    const data = new Uint8Array(10 * 10 * 3).fill(255);
    const out = alignFace({ data, width: 10, height: 10 }, FACE_TEMPLATE.map((p): Point => [p[0] - 60, p[1] - 60]));
    expect(out[0]).toBe(0); // the corner maps to (-60, -60), outside a 10 pixel picture
  });
});

describe("decodeYunet", () => {
  // A 64x64 input: strides 8, 16, 32 give 8x8, 4x4 and 2x2 cells.
  const empty = () => {
    const o: Record<string, { data: Float32Array }> = {};
    for (const [stride, cells] of [[8, 64], [16, 16], [32, 4]] as const) {
      o[`cls_${stride}`] = { data: new Float32Array(cells) };
      o[`obj_${stride}`] = { data: new Float32Array(cells) };
      o[`bbox_${stride}`] = { data: new Float32Array(cells * 4) };
      o[`kps_${stride}`] = { data: new Float32Array(cells * 10) };
    }
    return o;
  };
  it("reads a box and landmarks from the cell they are centred on", () => {
    const o = empty();
    // Stride 16, row 1, column 2 (cell index 1*4+2 = 6): score sqrt(0.9*0.8), centre offset (0.5, 0.25) cells, size e^0 * 16 = 16.
    o.cls_16.data[6] = 0.9;
    o.obj_16.data[6] = 0.8;
    o.bbox_16.data.set([0.5, 0.25, 0, 0], 6 * 4);
    o.kps_16.data.set([-0.1, -0.1, 0.1, -0.1, 0, 0, -0.1, 0.1, 0.1, 0.1], 6 * 10);
    const found = decodeYunet(o, 64, 64, 0.5);
    expect(found).toHaveLength(1);
    const d = found[0];
    expect(d.score).toBeCloseTo(Math.sqrt(0.72), 6);
    expect((d.x1 + d.x2) / 2).toBeCloseTo((2 + 0.5) * 16, 6);
    expect((d.y1 + d.y2) / 2).toBeCloseTo((1 + 0.25) * 16, 6);
    expect(d.x2 - d.x1).toBeCloseTo(16, 6);
    expect(d.landmarks[0]).toEqual([(2 - 0.1) * 16, (1 - 0.1) * 16].map((v) => expect.closeTo(v, 5)));
    expect(d.landmarks[2][0]).toBeCloseTo(2 * 16, 6);
  });
  it("ignores cells under the threshold and clamps scores to 1", () => {
    const o = empty();
    o.cls_8.data[0] = 0.3;
    o.obj_8.data[0] = 0.3;
    o.cls_32.data[1] = 7;
    o.obj_32.data[1] = 3;
    const found = decodeYunet(o, 64, 64, 0.5);
    expect(found).toHaveLength(1);
    expect(found[0].score).toBe(1);
  });
});

describe("nonMaxSuppression", () => {
  const box = (x: number, score: number): Detection => ({ x1: x, y1: 0, x2: x + 10, y2: 10, score, landmarks: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]] });
  it("keeps the best of boxes that overlap and all the separate ones", () => {
    const kept = nonMaxSuppression([box(0, 0.8), box(1, 0.95), box(50, 0.7), box(2, 0.6)]);
    expect(kept.map((k) => k.score)).toEqual([0.95, 0.7]);
  });
});

describe("fingerprints", () => {
  it("normalises to length one, so identical ones score 1 and opposite ones -1", () => {
    const a = normalize([3, 4, 0]);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
    expect(similarity(a, a)).toBeCloseTo(1, 6);
    expect(similarity(a, normalize([-3, -4, 0]))).toBeCloseTo(-1, 6);
    expect(similarity(a, normalize([0, 0, 5]))).toBeCloseTo(0, 6);
    expect(Array.from(normalize([0, 0, 0]))).toEqual([0, 0, 0]);
  });
  it("survives being stored as bytes", () => {
    const v = normalize([1, 2, 3, 4]);
    expect(Array.from(fromBytes(toBytes(v)))).toEqual(Array.from(v));
    expect(toBytes(v).length).toBe(16);
  });
});
