import { NextResponse } from "next/server";
import { z } from "zod";
import { setOnWatchlist } from "@/lib/watchlist/service";
import { json, notFound, readJson, uuid } from "@/lib/ownership/http";

const body = z.object({ titleId: uuid, on: z.boolean() }).strict();

/** Puts a movie, show or audiobook on the signed-in profile's watch list (`on: true`) or takes it off. Only that profile sees its list. */
export async function PUT(request: Request) {
  const data = await readJson(request, body);
  if (data instanceof NextResponse) return data;
  const result = await setOnWatchlist(data);
  if (!result.ok) return result.status === 403 ? json({ error: "Forbidden" }, 403) : notFound();
  return json({ ok: true, on: data.on });
}
