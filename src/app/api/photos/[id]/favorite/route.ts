import { setFavorite } from "@/lib/photos/favorites";

/** Heart a photo or video for the current profile. */
export async function PUT(_request: Request, ctx: RouteContext<"/api/photos/[id]/favorite">) {
  return setFavorite((await ctx.params).id, true);
}

/** Remove the heart. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/photos/[id]/favorite">) {
  return setFavorite((await ctx.params).id, false);
}
