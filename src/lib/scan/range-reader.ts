export type ByteRangeFetcher = (
  startByte: number,
  endByte: number
) => Promise<ArrayBuffer>;

/** Serves reads from the last fetched window, fetching a new (larger) window only on a miss. */
export class RangeReader {
  private buf: Uint8Array | null = null;
  private start = 0;

  constructor(
    private readonly fetchRange: ByteRangeFetcher,
    readonly size: number
  ) {}

  /** Returns up to `length` bytes at `offset` (fewer only at end of file). */
  async read(offset: number, length: number, prefetch = length): Promise<DataView> {
    const end = Math.min(offset + length, this.size);
    if (offset < 0 || end <= offset) return new DataView(new ArrayBuffer(0));

    if (this.buf && offset >= this.start && end <= this.start + this.buf.byteLength) {
      return new DataView(this.buf.buffer, this.buf.byteOffset + (offset - this.start), end - offset);
    }

    const fetchEnd = Math.min(offset + Math.max(length, prefetch), this.size);
    const ab = await this.fetchRange(offset, fetchEnd - 1);
    this.buf = new Uint8Array(ab);
    this.start = offset;
    return new DataView(this.buf.buffer, this.buf.byteOffset, Math.min(end - offset, this.buf.byteLength));
  }
}
