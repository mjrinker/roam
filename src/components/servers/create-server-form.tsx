"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function CreateServerForm() {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const res = await fetch("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(typeof body.error === "string" ? body.error : "Couldn't create that server.");
      setSubmitting(false);
      return;
    }
    const { server } = await res.json();
    // A real full-page navigation, not router.push() — this hits a Route
    // Handler that 302s onward to Box's own OAuth consent screen (an
    // external origin), not an internal Next.js page.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/api/box/connect?serverId=${server.id}`;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create a server</CardTitle>
        <CardDescription>
          You&apos;ll connect your own Box account next, then pick which folders
          to share.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex items-end gap-3">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="server-name">Server name</Label>
            <Input
              id="server-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="The Rinker Family Server"
              required
            />
          </div>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Creating…" : "Create & connect Box"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
