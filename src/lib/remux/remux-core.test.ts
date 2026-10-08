import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFfmpegArgs,
  CHUNKED_UPLOAD_MIN_BYTES,
  conflictIdFrom,
  preflightUpload,
  uploadFile,
} from "./remux-core.mjs";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;
const getToken = vi.fn(async (force: boolean) => (force ? "fresh" : "stale"));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "remux-core-test-"));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  getToken.mockClear();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("buildFfmpegArgs", () => {
  it("copies video, re-encodes only the first audio track to stereo AAC, faststart", () => {
    const args = buildFfmpegArgs("in.mp4", "out.aac.mp4");
    expect(args).toEqual(expect.arrayContaining(["-c:v", "copy", "-c:a", "aac", "-ac", "2", "+faststart"]));
    expect(args.join(" ")).toContain("-map 0:v:0 -map 0:a:0");
    expect(args.slice(-1)).toEqual(["out.aac.mp4"]);
    expect(args[args.indexOf("-i") + 1]).toBe("in.mp4");
  });
});

describe("buildFfmpegArgs with channels", () => {
  it("keeps the channel layout and scales the bitrate instead of downmixing", () => {
    const args = buildFfmpegArgs("in.mp4", "out.aac.mp4", { channels: 6 });
    expect(args).not.toContain("-ac");
    expect(args[args.indexOf("-b:a") + 1]).toBe("384k");
  });

  it("still downmixes to stereo for a stereo/mono source or no hint", () => {
    expect(buildFfmpegArgs("i", "o", { channels: 2 })).toEqual(expect.arrayContaining(["-ac", "2"]));
    expect(buildFfmpegArgs("i", "o", {})).toEqual(expect.arrayContaining(["-ac", "2"]));
  });
});

describe("conflictIdFrom", () => {
  it("reads Box's conflict id, object or array shaped", () => {
    expect(conflictIdFrom({ context_info: { conflicts: { id: "9" } } })).toBe("9");
    expect(conflictIdFrom({ context_info: { conflicts: [{ id: "7" }] } })).toBe("7");
    expect(conflictIdFrom({})).toBeNull();
    expect(conflictIdFrom(null)).toBeNull();
  });
});

describe("preflightUpload", () => {
  const args = { getToken, folderId: "f1", name: "A.aac.mp4", size: 100 };

  it("returns no conflict on 200", async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await preflightUpload(args)).toEqual({ conflictId: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.box.com/2.0/files/content");
    expect(init.method).toBe("OPTIONS");
    expect(JSON.parse(init.body)).toEqual({ name: "A.aac.mp4", parent: { id: "f1" }, size: 100 });
  });

  it("surfaces an existing file on 409", async () => {
    fetchMock.mockResolvedValueOnce(json({ code: "item_name_in_use", context_info: { conflicts: { id: "42" } } }, 409));
    expect(await preflightUpload(args)).toEqual({ conflictId: "42" });
  });

  it("throws on other rejections (e.g. size cap)", async () => {
    fetchMock.mockResolvedValueOnce(json({ code: "file_size_limit_exceeded", message: "too big" }, 413));
    await expect(preflightUpload(args)).rejects.toThrow(/413/);
  });

  it("retries once with a refreshed token on 401", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({}));
    await preflightUpload(args);
    expect(getToken).toHaveBeenNthCalledWith(2, true);
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe("Bearer fresh");
  });
});

describe("uploadFile", () => {
  it("does a simple multipart upload for small files", async () => {
    const filePath = join(dir, "out.mp4");
    await writeFile(filePath, Buffer.alloc(1024, 1));
    fetchMock.mockResolvedValueOnce(json({ entries: [{ id: "11", name: "out.mp4", size: 1024 }] }, 201));
    const result = await uploadFile({ getToken, folderId: "f1", name: "out.mp4", filePath });
    expect(result).toEqual({ id: "11", name: "out.mp4", size: 1024 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://upload.box.com/api/2.0/files/content");
  });

  it("stamps a new small file with the creation date it is given, and never a replacement version", async () => {
    const filePath = join(dir, "photo.jpg");
    await writeFile(filePath, Buffer.alloc(64, 1));
    fetchMock.mockResolvedValueOnce(json({ entries: [{ id: "12", name: "photo.jpg", size: 64 }] }, 201));
    await uploadFile({ getToken, folderId: "f1", name: "photo.jpg", filePath, contentCreatedAt: "2019-05-06T07:08:09.000Z" });
    const attrs = JSON.parse((fetchMock.mock.calls[0][1].body as FormData).get("attributes") as string);
    expect(attrs).toEqual({ name: "photo.jpg", parent: { id: "f1" }, content_created_at: "2019-05-06T07:08:09.000Z", content_modified_at: "2019-05-06T07:08:09.000Z" });
    fetchMock.mockResolvedValueOnce(json({ entries: [{ id: "12", name: "photo.jpg", size: 64 }] }, 201));
    await uploadFile({ getToken, folderId: "f1", name: "photo.jpg", filePath, replaceFileId: "12", contentCreatedAt: "2019-05-06T07:08:09.000Z" });
    expect(JSON.parse((fetchMock.mock.calls[1][1].body as FormData).get("attributes") as string)).toEqual({ name: "photo.jpg" });
  });

  it("uploads a new version of an existing file when replaceFileId is given", async () => {
    const filePath = join(dir, "out.mp4");
    await writeFile(filePath, Buffer.alloc(1024, 1));
    fetchMock.mockResolvedValueOnce(json({ entries: [{ id: "77", name: "out.mp4", size: 1024 }] }, 201));
    const result = await uploadFile({ getToken, folderId: "f1", name: "out.mp4", filePath, replaceFileId: "77" });
    expect(result).toEqual({ id: "77", name: "out.mp4", size: 1024 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://upload.box.com/api/2.0/files/77/content");
    const attributes = (init.body as FormData).get("attributes") as string;
    expect(JSON.parse(attributes)).toEqual({ name: "out.mp4" });
  });

  it("links the existing file when the name is already taken", async () => {
    const filePath = join(dir, "out.mp4");
    await writeFile(filePath, Buffer.alloc(16));
    fetchMock.mockResolvedValueOnce(json({ context_info: { conflicts: { id: "55" } } }, 409));
    expect(await uploadFile({ getToken, folderId: "f1", name: "out.mp4", filePath })).toEqual({ conflictId: "55" });
  });

  it("throws a descriptive error on failure", async () => {
    const filePath = join(dir, "out.mp4");
    await writeFile(filePath, Buffer.alloc(16));
    fetchMock.mockResolvedValueOnce(json({ code: "access_denied_insufficient_permissions", message: "nope" }, 403));
    await expect(uploadFile({ getToken, folderId: "f1", name: "out.mp4", filePath })).rejects.toThrow(/403/);
  });

  it("backs off and retries a 429", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
    const filePath = join(dir, "out.mp4");
    await writeFile(filePath, Buffer.alloc(16));
    fetchMock
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "1" }))
      .mockResolvedValueOnce(json({ entries: [{ id: "1", name: "out.mp4", size: 16 }] }, 201));
    expect(await uploadFile({ getToken, folderId: "f1", name: "out.mp4", filePath })).toEqual({ id: "1", name: "out.mp4", size: 16 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a chunked session for files at/above the threshold, with per-part digests and a commit", async () => {
    const size = CHUNKED_UPLOAD_MIN_BYTES + 5;
    const filePath = join(dir, "big.mp4");
    await writeFile(filePath, Buffer.alloc(size, 7));
    const partSize = CHUNKED_UPLOAD_MIN_BYTES;
    fetchMock
      .mockResolvedValueOnce(
        json(
          {
            part_size: partSize,
            session_endpoints: { upload_part: "https://u/part", commit: "https://u/commit" },
          },
          201
        )
      )
      .mockResolvedValueOnce(json({ part: { part_id: "P1", offset: 0, size: partSize } }))
      .mockResolvedValueOnce(json({ part: { part_id: "P2", offset: partSize, size: 5 } }))
      .mockResolvedValueOnce(json({ entries: [{ id: "99", name: "big.mp4", size }] }, 201));

    const result = await uploadFile({ getToken, folderId: "f1", name: "big.mp4", filePath });
    expect(result).toEqual({ id: "99", name: "big.mp4", size });

    const [session, part1, part2, commit] = fetchMock.mock.calls;
    expect(session[0]).toBe("https://upload.box.com/api/2.0/files/upload_sessions");
    expect(JSON.parse(session[1].body)).toEqual({ folder_id: "f1", file_size: size, file_name: "big.mp4" });
    expect(part1[1].headers["content-range"]).toBe(`bytes 0-${partSize - 1}/${size}`);
    expect(part1[1].headers.digest).toMatch(/^sha=/);
    expect(part2[1].headers["content-range"]).toBe(`bytes ${partSize}-${size - 1}/${size}`);
    expect(commit[0]).toBe("https://u/commit");
    expect(commit[1].headers.digest).toMatch(/^sha=/);
    expect(JSON.parse(commit[1].body).parts.map((p: { part_id: string }) => p.part_id)).toEqual(["P1", "P2"]);
  });
});
