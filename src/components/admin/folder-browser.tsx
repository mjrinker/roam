"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BoxFolder {
  id: string;
  name: string;
}

interface Crumb {
  id: string;
  name: string;
}

// The top of a connection: its real id is learned from the first answer, so until then it is empty.
const ROOT: Crumb = { id: "", name: "All Files" };

export function FolderBrowser({
  serverId,
  connectionId,
  rootName,
  confirmLabel,
  onSelect,
}: {
  serverId: string;
  /** Which of the server's storage connections to browse (default: its original Box connection). */
  connectionId?: string;
  /** What to call the top of it. */
  rootName?: string;
  /** The button's words; {name} is the folder being looked at. */
  confirmLabel?: string;
  onSelect: (folder: { id: string; name: string }) => void;
}) {
  const [trail, setTrail] = useState<Crumb[]>([{ ...ROOT, name: rootName ?? ROOT.name }]);
  const [folders, setFolders] = useState<BoxFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const current = trail[trail.length - 1];
  // Learning the top folder's id changes `current.id`, but its list is the one just fetched: no second fetch for it.
  const learnedRoot = useRef<string | null>(null);

  useEffect(() => {
    if (learnedRoot.current !== null && learnedRoot.current === current.id) {
      learnedRoot.current = null;
      return;
    }
    let cancelled = false;
    // Resetting loading/error at the start of each fetch (including on
    // re-runs when `current.id` changes, i.e. navigating folders) is the
    // intended behavior here, not incidental render-triggered state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ serverId });
    if (connectionId) params.set("connectionId", connectionId);
    if (current.id) params.set("folderId", current.id);
    fetch(`/api/storage/browse?${params}`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? "Couldn't load that folder.");
          setFolders([]);
          return;
        }
        setFolders(body.folders);
        // Learn the top folder's real id, so choosing the top itself works.
        if (!current.id && typeof body.rootId === "string") {
          learnedRoot.current = body.rootId;
          setTrail((t) => (t.length === 1 && !t[0].id ? [{ ...t[0], id: body.rootId }] : t));
        }
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load that folder.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, connectionId, current.id]);

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {trail.map((crumb, i) => (
          <span key={crumb.id} className="flex items-center gap-1">
            <button
              type="button"
              className="hover:text-foreground hover:underline"
              disabled={i === trail.length - 1}
              onClick={() => setTrail(trail.slice(0, i + 1))}
            >
              {crumb.name}
            </button>
            {i < trail.length - 1 && <ChevronRight className="size-3" />}
          </span>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <div className="flex items-center justify-center py-6 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : (
        <div className="flex max-h-64 flex-col divide-y divide-border overflow-y-auto">
          {folders.length === 0 && !error && (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No subfolders here.
            </p>
          )}
          {folders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              className="flex items-center gap-2 py-2 text-left text-sm hover:text-foreground"
              onClick={() => setTrail([...trail, folder])}
            >
              <Folder className="size-4 text-muted-foreground" />
              {folder.name}
            </button>
          ))}
        </div>
      )}

      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={!current.id}
        onClick={() => onSelect(current)}
      >
        {(confirmLabel ?? "Use \"{name}\" as this library").replace("{name}", current.name)}
      </Button>
    </div>
  );
}
