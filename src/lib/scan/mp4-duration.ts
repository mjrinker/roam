/**
 * Determines an MP4/MOV file's duration by walking its top-level box (atom)
 * structure and reading the `moov/mvhd` atom, using small byte-range fetches
 * instead of downloading the file. This is what lets the scanner compute a
 * segmented movie's exact global timeline (see media_files.duration_seconds
 * in the schema) cheaply, without ffmpeg.
 *
 * MP4 box layout: [size:u32][type:4cc]([largesize:u64] if size===1)[payload]
 * `moov` is a container box; `mvhd` is normally its first child and holds
 * the movie's overall timescale + duration.
 */

export type ByteRangeFetcher = (
  startByte: number,
  endByte: number
) => Promise<ArrayBuffer>;

const HEADER_PROBE_BYTES = 16; // enough for size(4)+type(4)+largesize(8)
const MVHD_SEARCH_WINDOW = 256 * 1024; // moov's mvhd child is always near its start
const MAX_BOXES_WALKED = 128; // guards against malformed/adversarial files

export class Mp4DurationError extends Error {}

export async function probeMp4DurationSeconds(
  fetchRange: ByteRangeFetcher,
  fileSizeBytes: number
): Promise<number> {
  let offset = 0;

  for (let i = 0; i < MAX_BOXES_WALKED && offset < fileSizeBytes; i++) {
    const headerEnd = Math.min(offset + HEADER_PROBE_BYTES - 1, fileSizeBytes - 1);
    const headerBuf = await fetchRange(offset, headerEnd);
    const view = new DataView(headerBuf);
    if (view.byteLength < 8) {
      throw new Mp4DurationError("Unexpected end of file while reading box header");
    }

    let boxSize = view.getUint32(0, false);
    const type = String.fromCharCode(
      view.getUint8(4),
      view.getUint8(5),
      view.getUint8(6),
      view.getUint8(7)
    );
    let headerLen = 8;

    if (boxSize === 1) {
      // 64-bit "largesize" follows the type when the 32-bit size is this sentinel.
      if (view.byteLength < 16) {
        throw new Mp4DurationError("Truncated 64-bit box size");
      }
      const hi = view.getUint32(8, false);
      const lo = view.getUint32(12, false);
      boxSize = hi * 2 ** 32 + lo;
      headerLen = 16;
    } else if (boxSize === 0) {
      // Box extends to EOF — only valid for the last box, nothing after it.
      boxSize = fileSizeBytes - offset;
    }

    if (type === "moov") {
      return readMvhdDuration(fetchRange, offset + headerLen, Math.min(boxSize - headerLen, MVHD_SEARCH_WINDOW));
    }

    if (boxSize <= 0) {
      throw new Mp4DurationError(`Invalid box size at offset ${offset}`);
    }
    offset += boxSize;
  }

  throw new Mp4DurationError("No moov atom found within the box-walk budget");
}

async function readMvhdDuration(
  fetchRange: ByteRangeFetcher,
  moovContentStart: number,
  searchBytes: number
): Promise<number> {
  const buf = await fetchRange(moovContentStart, moovContentStart + searchBytes - 1);
  const view = new DataView(buf);

  let offset = 0;
  while (offset + 8 <= view.byteLength) {
    const size = view.getUint32(offset, false);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7)
    );

    if (type === "mvhd") {
      const payloadStart = offset + 8;
      const version = view.getUint8(payloadStart);

      if (version === 1) {
        // version(1)+flags(3)+creation(8)+modification(8) = 20 bytes in, then timescale(4)
        const timescale = view.getUint32(payloadStart + 20, false);
        const durHi = view.getUint32(payloadStart + 24, false);
        const durLo = view.getUint32(payloadStart + 28, false);
        const duration = durHi * 2 ** 32 + durLo;
        if (!timescale) throw new Mp4DurationError("mvhd timescale is zero");
        return duration / timescale;
      } else {
        // version 0: version(1)+flags(3)+creation(4)+modification(4) = 12 bytes in, then timescale(4)
        const timescale = view.getUint32(payloadStart + 12, false);
        const duration = view.getUint32(payloadStart + 16, false);
        if (!timescale) throw new Mp4DurationError("mvhd timescale is zero");
        return duration / timescale;
      }
    }

    if (size < 8) break; // malformed child box, bail out of the search window
    offset += size;
  }

  throw new Mp4DurationError("mvhd atom not found within moov search window");
}
