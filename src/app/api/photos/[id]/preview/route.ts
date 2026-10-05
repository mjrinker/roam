import { planPreview } from "@/lib/photos/preview-plan";
import { authorizePhotoFile, imageResponse, notFound, redirectToOriginal, storageFailure } from "@/lib/photos/serve";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import { createBoxProviderForServer } from "@/lib/storage/box";

export const maxDuration = 30;

const PREVIEW_BUDGET_MS = 8_000;

/**
 * A photo shown large: the original when it is a small picture a browser can show, else Box's 2048px
 * (then 1024px) JPEG, else the original while it is a sensible size, else the small thumbnail. A HEIC
 * is never served as the original (most browsers can't show it). Same gate as every photo route.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/photos/[id]/preview">) {
  const { id } = await ctx.params;
  const auth = await authorizePhotoFile(id, ["photo"], { bucket: "photo_preview", max: 600 });
  if (!auth.ok) return auth.response;
  const { file } = auth;
  const plan = planPreview(file.container, file.sizeBytes);

  try {
    if (plan.direct) return await redirectToOriginal(file);

    const provider = createBoxProviderForServer(file.serverId);
    let preview = null;
    try {
      preview = (await provider.fetchPreview?.(file.fileId, { budgetMs: PREVIEW_BUDGET_MS })) ?? null;
    } catch (err) {
      // A connection that needs re-authorising is reported; anything else just means "no rendering", and we fall back.
      if (err instanceof BoxReauthRequiredError) throw err;
    }
    if (preview) return imageResponse(preview.bytes, "private, max-age=300", { "X-Preview-Size": String(preview.size) });

    if (plan.originalFallback) return await redirectToOriginal(file);

    const thumb = (await provider.fetchThumbnail?.(file.fileId)) ?? null;
    // Short-lived: the real preview should replace this as soon as Box has made it.
    if (thumb) return imageResponse(thumb.bytes, "private, max-age=30", { "X-Preview-Size": "320" });
    return notFound();
  } catch (err) {
    return storageFailure(err);
  }
}
