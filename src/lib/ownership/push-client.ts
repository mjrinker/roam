/** Asking this browser for permission to send notifications, and telling the server where to send them. */

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Whether this browser is already set up to get notifications. */
export async function pushEnabled(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  return !!(await reg?.pushManager.getSubscription().catch(() => null));
}

export type EnableResult = "enabled" | "denied" | "unsupported" | "not-configured" | "failed";

/** Asks permission (the browser shows its own prompt), subscribes and tells the server. */
export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) return "unsupported";
  try {
    const key = ((await (await fetch("/api/push")).json()) as { publicKey: string | null }).publicKey;
    if (!key) return "not-configured";
    if ((await Notification.requestPermission()) !== "granted") return "denied";
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
    const j = sub.toJSON();
    if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth) return "failed";
    const res = await fetch("/api/push", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }) });
    return res.ok ? "enabled" : "failed";
  } catch {
    return "failed";
  }
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (!sub) return;
  await fetch("/api/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}
