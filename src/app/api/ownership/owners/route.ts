import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { assignOwners, removeOwner, unitsOfTitles } from "@/lib/ownership/owners";
import { announceFreed } from "@/lib/ownership/sessions";
import { json, notFound, readJson, uuid } from "@/lib/ownership/http";

const body = z
  .object({
    serverId: uuid,
    accountId: uuid,
    action: z.enum(["assign", "remove"]),
    // Whole titles (a show stands for all its seasons), or exact units (a season on its own).
    titleIds: z.array(uuid).max(3000).default([]),
    units: z.array(z.object({ titleId: uuid, seasonId: uuid.nullable() })).max(3000).default([]),
  })
  .strict();

/** The server's admin makes an account the owner of titles (or of single seasons), or takes that away. */
export async function PUT(request: Request) {
  const data = await readJson(request, body);
  if (data instanceof NextResponse) return data;
  if (!(await getCurrentServerAdmin(data.serverId))) return notFound();
  const units = [...(await unitsOfTitles(db, data.titleIds)), ...data.units];
  if (data.action === "assign") {
    const added = await assignOwners(db, { serverId: data.serverId, units, accountId: data.accountId, via: "assigned" });
    return json({ added: added.length });
  }
  // Only units that belong to this server can be touched.
  const valid = await assignableUnits(data.serverId, units);
  for (const u of valid) {
    await removeOwner(db, u, data.accountId);
    await announceFreed(db, u);
  }
  return json({ removed: valid.length });
}

import { and, eq, inArray } from "drizzle-orm";
import { libraries, titles } from "@/lib/db/schema";
async function assignableUnits(serverId: string, units: { titleId: string; seasonId: string | null }[]) {
  if (units.length === 0) return [];
  const ok = await db.select({ id: titles.id }).from(titles).innerJoin(libraries, eq(titles.libraryId, libraries.id)).where(and(eq(libraries.serverId, serverId), inArray(titles.id, [...new Set(units.map((u) => u.titleId))])));
  const set = new Set(ok.map((r) => r.id));
  return units.filter((u) => set.has(u.titleId));
}
