"use client";

import { DownloadsList as List } from "@/components/offline/downloads-list";

/** The downloads list on the server's own pages: playing opens the usual watch/listen page (which uses the saved copy). */
export function DownloadsList({ serverId }: { serverId: string }) {
  return <List playTo={(r) => `/s/${serverId}/watch/${r.ownerKind}/${r.ownerId}`} />;
}
