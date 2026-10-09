/** Saves (or clears, with null) this profile's starting speed for a library. Returns an error message, or null when it worked. */
export async function saveDefaultSpeed(libraryId: string, speed: number | null): Promise<string | null> {
  try {
    const res = await fetch(`/api/libraries/${libraryId}/my-playback-speed`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speed }) });
    if (res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return typeof body.error === "string" ? body.error : "Couldn't save that.";
  } catch {
    return "Couldn't reach the server.";
  }
}
