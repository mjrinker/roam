/**
 * The picture maths behind finding and recognising faces, kept apart from the model files so it is tested without them: reading the detector's
 * raw output (YuNet), merging overlapping boxes, lining a face up the way the recognition model expects (SFace), and comparing fingerprints.
 */
export type Point = [number, number];

export interface Detection {
  /** Box corners in the detector's input pixels. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  /** Right eye, left eye, nose tip, right and left mouth corners, as seen in the picture (the subject's right eye is on the left). */
  landmarks: [Point, Point, Point, Point, Point];
}

export interface Raw {
  data: Float32Array | number[];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Turns YuNet's twelve outputs (class, objectness, box and five landmarks, at strides 8, 16 and 32) into boxes. `width` and `height` are the
 * model's input size (multiples of 32). Same arithmetic as OpenCV's FaceDetectorYN.
 */
export function decodeYunet(out: Record<string, Raw>, width: number, height: number, threshold: number): Detection[] {
  const found: Detection[] = [];
  for (const stride of [8, 16, 32]) {
    const cols = Math.floor(width / stride);
    const rows = Math.floor(height / stride);
    const cls = out[`cls_${stride}`].data;
    const obj = out[`obj_${stride}`].data;
    const bbox = out[`bbox_${stride}`].data;
    const kps = out[`kps_${stride}`].data;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
        if (score < threshold) continue;
        const cx = (c + bbox[i * 4]) * stride;
        const cy = (r + bbox[i * 4 + 1]) * stride;
        const w = Math.exp(bbox[i * 4 + 2]) * stride;
        const h = Math.exp(bbox[i * 4 + 3]) * stride;
        const landmarks = Array.from({ length: 5 }, (_, k): Point => [(kps[i * 10 + 2 * k] + c) * stride, (kps[i * 10 + 2 * k + 1] + r) * stride]);
        found.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, score, landmarks: landmarks as Detection["landmarks"] });
      }
    }
  }
  return found;
}

const area = (d: Detection) => Math.max(0, d.x2 - d.x1) * Math.max(0, d.y2 - d.y1);
function iou(a: Detection, b: Detection): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (area(a) + area(b) - inter);
}

/** Keeps the best box of each group of overlapping ones. */
export function nonMaxSuppression(boxes: Detection[], overlap = 0.3): Detection[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const box of sorted) if (kept.every((k) => iou(k, box) <= overlap)) kept.push(box);
  return kept;
}

/** Where the five landmarks sit in the 112 x 112 picture the recognition model is shown (the standard ArcFace layout). */
export const FACE_TEMPLATE: Point[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];
export const FACE_SIZE = 112;

/** A turn, scale and shift: x' = a*x - b*y + tx, y' = b*x + a*y + ty. */
export interface Similarity {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/** The turn, scale and shift that best carries `from` onto `to` (least squares; Umeyama's method in two dimensions). */
export function similarityTransform(from: Point[], to: Point[]): Similarity {
  const n = from.length;
  const mean = (pts: Point[]): Point => [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  const [fx, fy] = mean(from);
  const [tx, ty] = mean(to);
  let num1 = 0; // sum of dot products
  let num2 = 0; // sum of cross products
  let den = 0;
  for (let i = 0; i < n; i++) {
    const x = from[i][0] - fx;
    const y = from[i][1] - fy;
    const u = to[i][0] - tx;
    const v = to[i][1] - ty;
    num1 += x * u + y * v;
    num2 += x * v - y * u;
    den += x * x + y * y;
  }
  if (den === 0) throw new Error("The landmarks are all in one place.");
  const a = num1 / den;
  const b = num2 / den;
  return { a, b, tx: tx - (a * fx - b * fy), ty: ty - (b * fx + a * fy) };
}

export interface RgbImage {
  data: Uint8Array | Uint8ClampedArray | Buffer;
  width: number;
  height: number;
}

/**
 * The face cut out and lined up for the recognition model: the picture carried by the transform that puts its landmarks on the template, as
 * 112 x 112 RGB, laid out channel by channel (the model's input), values 0-255. Pixels outside the picture are black.
 */
export function alignFace(image: RgbImage, landmarks: Point[]): Float32Array {
  const t = similarityTransform(landmarks, FACE_TEMPLATE);
  const det = t.a * t.a + t.b * t.b;
  const out = new Float32Array(3 * FACE_SIZE * FACE_SIZE);
  const plane = FACE_SIZE * FACE_SIZE;
  const { data, width, height } = image;
  const at = (x: number, y: number, ch: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : data[(y * width + x) * 3 + ch]);
  for (let v = 0; v < FACE_SIZE; v++) {
    for (let u = 0; u < FACE_SIZE; u++) {
      // The picture position that lands on this output pixel (the transform run backwards).
      const dx = u - t.tx;
      const dy = v - t.ty;
      const sx = (t.a * dx + t.b * dy) / det;
      const sy = (-t.b * dx + t.a * dy) / det;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const top = at(x0, y0, ch) * (1 - fx) + at(x0 + 1, y0, ch) * fx;
        const bottom = at(x0, y0 + 1, ch) * (1 - fx) + at(x0 + 1, y0 + 1, ch) * fx;
        out[ch * plane + v * FACE_SIZE + u] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return out;
}

/** A fingerprint scaled to length one, so that comparing two is a plain dot product. */
export function normalize(v: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** How alike two fingerprints of length one are: 1 for the same, near 0 for strangers. */
export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export const toBytes = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export function fromBytes(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
