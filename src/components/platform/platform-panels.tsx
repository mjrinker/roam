import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { PlatformStats, ProviderUsage } from "@/lib/platform/stats";
import { providerName } from "@/lib/storage/provider-info";
import { cn } from "@/lib/utils";

export const fmt = (n: number) => n.toLocaleString("en-US");
export const when = (d: Date | null | undefined) => (d ? d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "never");

export function Panel({ title, note, children, action }: { title: string; note?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{title}</h2>
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl bg-white/[0.04] px-4 py-3 ring-1 ring-white/[0.08]">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const STATUS_STYLE = {
  none: { bar: "bg-primary", chip: "", text: "" },
  ok: { bar: "bg-emerald-400", chip: "bg-emerald-400/15 text-emerald-300", text: "Within the limit" },
  warn: { bar: "bg-amber-400", chip: "bg-amber-400/15 text-amber-300", text: "Getting close" },
  full: { bar: "bg-destructive", chip: "bg-destructive/20 text-red-300", text: "At the limit" },
} as const;

const CAP_ADVICE: Partial<Record<ProviderUsage["provider"], string>> = {
  dropbox: "A Dropbox app in development mode can link 50 accounts. Before it gets there, apply for production access in the Dropbox App Console (dropbox.com/developers/apps, then your app, then \"Apply for production\"). Dropbox's own count there is the final word.",
  gdrive: "A Google app that hasn't been through verification is capped at 100 users. Past that, it needs Google's verification (and for Drive's permission, a paid security assessment).",
};

export function ProviderLimits({ providers }: { providers: ProviderUsage[] }) {
  if (providers.length === 0) return <p className="text-sm text-muted-foreground">No outside accounts are linked yet.</p>;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {providers.map((p) => {
        const style = STATUS_STYLE[p.status];
        const pct = p.cap ? Math.min(100, Math.round((p.linked / p.cap) * 100)) : 0;
        return (
          <Card key={p.provider}>
            <CardContent className="flex flex-col gap-3 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{providerName(p.provider)}</p>
                {p.status !== "none" && <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", style.chip)}>{style.text}</span>}
              </div>
              <p className="text-3xl font-semibold tabular-nums">
                {fmt(p.linked)}
                {p.cap !== null && <span className="text-lg font-normal text-muted-foreground"> / {fmt(p.cap)} accounts</span>}
                {p.cap === null && <span className="text-lg font-normal text-muted-foreground"> accounts linked</span>}
              </p>
              {p.cap !== null && (
                <div role="progressbar" aria-valuenow={p.linked} aria-valuemin={0} aria-valuemax={p.cap} className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full rounded-full transition-all", style.bar)} style={{ width: `${pct}%` }} />
                </div>
              )}
              <p className="text-xs text-muted-foreground">{p.everLinked > p.linked ? `${fmt(p.everLinked)} ever linked; ${fmt(p.everLinked - p.linked)} since unlinked.` : "Every account ever linked is still linked."}</p>
              {p.status !== "ok" && p.status !== "none" && CAP_ADVICE[p.provider] && <p className="rounded-lg bg-white/[0.05] px-3 py-2 text-xs leading-relaxed text-foreground/85">{CAP_ADVICE[p.provider]}</p>}
              {p.accounts.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Accounts ({p.accounts.length})</summary>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {p.accounts.map((a) => (
                      <li key={a.label} className="min-w-0 text-xs">
                        <span className={cn("break-all", a.revoked && "text-muted-foreground line-through")}>{a.label}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {a.revoked ? "unlinked" : a.servers.length > 0 ? a.servers.join(", ") : "not connected to a server"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export function Problems({ health }: { health: PlatformStats["health"] }) {
  const none = health.needsReauth.length === 0 && health.scanErrors.length === 0 && health.neverScanned.length === 0 && health.probes.failed === 0;
  return (
    <div className="flex flex-col gap-3">
      {none && <p className="rounded-xl bg-emerald-400/10 px-4 py-3 text-sm text-emerald-300 ring-1 ring-emerald-400/20">Nothing needs attention.</p>}
      {health.needsReauth.length > 0 && (
        <Card>
          <CardContent className="py-4">
            <p className="text-sm font-medium text-destructive">Storage needing a sign-in again ({health.needsReauth.length})</p>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {health.needsReauth.map((c, i) => (
                <li key={i} className="break-words">
                  {c.label} <span className="text-muted-foreground">({providerName(c.provider)}) on {c.serverName}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {health.scanErrors.length > 0 && (
        <Card>
          <CardContent className="py-4">
            <p className="text-sm font-medium text-destructive">Libraries whose last scan had errors ({health.scanErrors.length})</p>
            <ul className="mt-2 flex flex-col gap-2 text-sm">
              {health.scanErrors.map((s, i) => (
                <li key={i} className="min-w-0">
                  <span className="break-words">
                    {s.libraryName} <span className="text-muted-foreground">on {s.serverName} · {s.errors} error{s.errors === 1 ? "" : "s"}</span>
                  </span>
                  <p className="text-xs break-words text-muted-foreground">{s.first}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {health.neverScanned.length > 0 && (
        <Card>
          <CardContent className="py-4">
            <p className="text-sm font-medium">Libraries that have never been scanned ({health.neverScanned.length})</p>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {health.neverScanned.map((l, i) => (
                <li key={i} className="break-words">
                  {l.libraryName} <span className="text-muted-foreground">on {l.serverName}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
