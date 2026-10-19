/**
 * Finds the faces in a picture and makes a fingerprint of each, on this computer, with two small open models run by onnxruntime:
 * YuNet (face detection) and SFace (face recognition), both from the OpenCV model zoo (MIT and Apache-2.0 licences). Used by
 * scripts/scan-faces.ts only: nothing in the web app loads a model or sees a picture's pixels. Download the two files into
 * ~/.cache/roam-faces (the script says how).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { alignFace, decodeYunet, FACE_SIZE, nonMaxSuppression, normalize, type RgbImage } from "@/lib/faces/geometry";

export const MODEL_DIR = join(homedir(), ".cache", "roam-faces");
export const DETECTOR_FILE = "face_detection_yunet_2023mar.onnx";
export const RECOGNIZER_FILE = "face_recognition_sface_2021dec.onnx";
export const DETECTOR_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx";
export const RECOGNIZER_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx";

/** The detector takes exactly this many pixels square: the picture is shrunk to fit and padded with black. */
const DETECT_SIDE = 640;
const MIN_SCORE = 0.8;
/** A face smaller than this many pixels across (in the picture as handed over) is too small to recognise. */
const MIN_FACE_PIXELS = 28;

export interface AnalyzedFace {
  /** The box as fractions of the picture's width and height, from the top left, in the picture as it is shown (turned upright). */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  /** 128 numbers, scaled to length one. */
  embedding: Float32Array;
  /** A small square JPEG of the face with some of its surroundings. */
  thumb: Buffer;
}

type Ort = typeof import("onnxruntime-node");
type Session = Awaited<ReturnType<Ort["InferenceSession"]["create"]>>;

export class FaceEngine {
  private constructor(
    private readonly ort: Ort,
    private readonly detector: Session,
    private readonly recognizer: Session
  ) {}

  static async create(dir = MODEL_DIR): Promise<FaceEngine> {
    const ort = await import("onnxruntime-node");
    const options = { logSeverityLevel: 3 as const };
    return new FaceEngine(ort, await ort.InferenceSession.create(join(dir, DETECTOR_FILE), options), await ort.InferenceSession.create(join(dir, RECOGNIZER_FILE), options));
  }

  /** Every face in a picture (JPEG, PNG, WebP...), best first. A file that can't be read throws. */
  async analyze(file: Buffer): Promise<AnalyzedFace[]> {
    const { default: sharp } = await import("sharp");
    const upright = () => sharp(file, { failOn: "none" }).rotate().removeAlpha().toColourspace("srgb");
    const full = await upright().raw().toBuffer({ resolveWithObject: true });
    const picture: RgbImage = { data: full.data, width: full.info.width, height: full.info.height };

    // What the detector sees: the picture scaled to fit DETECT_SIDE (smaller pictures are not blown up past it), padded on the right and bottom.
    const shrink = DETECT_SIDE / Math.max(picture.width, picture.height);
    const dw = Math.max(1, Math.round(picture.width * shrink));
    const dh = Math.max(1, Math.round(picture.height * shrink));
    const small = await upright().resize(dw, dh, { fit: "fill" }).raw().toBuffer();
    const iw = DETECT_SIDE;
    const ih = DETECT_SIDE;
    const input = new Float32Array(3 * iw * ih);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const s = (y * dw + x) * 3;
        // The detector wants blue, green, red.
        input[y * iw + x] = small[s + 2];
        input[iw * ih + y * iw + x] = small[s + 1];
        input[2 * iw * ih + y * iw + x] = small[s];
      }
    }
    const outputs = await this.detector.run({ input: new this.ort.Tensor("float32", input, [1, 3, ih, iw]) });
    const raw: Record<string, { data: Float32Array }> = {};
    for (const name of Object.keys(outputs)) raw[name] = { data: outputs[name].data as Float32Array };
    const boxes = nonMaxSuppression(decodeYunet(raw, iw, ih, MIN_SCORE));

    const faces: AnalyzedFace[] = [];
    for (const d of boxes) {
      const k = 1 / shrink; // back to the picture's own pixels
      const x1 = Math.max(0, d.x1 * k);
      const y1 = Math.max(0, d.y1 * k);
      const x2 = Math.min(picture.width, d.x2 * k);
      const y2 = Math.min(picture.height, d.y2 * k);
      if (x2 - x1 < MIN_FACE_PIXELS || y2 - y1 < MIN_FACE_PIXELS) continue;
      const aligned = alignFace(picture, d.landmarks.map(([x, y]) => [x * k, y * k] as [number, number]));
      const result = await this.recognizer.run({ data: new this.ort.Tensor("float32", aligned, [1, 3, FACE_SIZE, FACE_SIZE]) });
      const embedding = normalize(result.fc1.data as Float32Array);

      // A square around the face with a margin, kept inside the picture.
      const side = Math.min(Math.max(x2 - x1, y2 - y1) * 1.7, picture.width, picture.height);
      const left = Math.round(Math.min(Math.max((x1 + x2) / 2 - side / 2, 0), picture.width - side));
      const top = Math.round(Math.min(Math.max((y1 + y2) / 2 - side / 2, 0), picture.height - side));
      const size = Math.floor(side);
      const thumb = await upright().extract({ left, top, width: size, height: size }).resize(128, 128).jpeg({ quality: 82 }).toBuffer();
      faces.push({ x: x1 / picture.width, y: y1 / picture.height, w: (x2 - x1) / picture.width, h: (y2 - y1) / picture.height, score: d.score, embedding, thumb });
    }
    return faces.sort((a, b) => b.score - a.score);
  }
}
