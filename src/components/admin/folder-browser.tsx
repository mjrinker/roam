"use client";

import { useEffect, useState } from "react";
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

const ROOT: Crumb = { id: "0", name: "All Files" };

export function FolderBrowser({
  serverId,
  onSelect,
}: {
  serverId: string;
  onSelect: (folder: { id: string; name: string }) => void;
}) {
  const [trail, setTrail] = useState<Crumb[]>([ROOT]);
  const [folders, setFolders] = useState<BoxFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const current = trail[trail.length - 1];

  useEffect(() => {
    let cancelled = false;
    // Resetting loading/error at the start of each fetch (including on
    // re-runs when `current.id` changes, i.e. navigating folders) is the
    // intended behavior here, not incidental render-triggered state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetch(`/api/box/browse?serverId=${serverId}&folderId=${current.id}`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? "Couldn't load that folder.");
          setFolders([]);
          return;
        }
        setFolders(body.folders);
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
  }, [serverId, current.id]);

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
        onClick={() => onSelect(current)}
      >
        Use &quot;{current.name}&quot; as this library
      </Button>
    </div>
  );
}
