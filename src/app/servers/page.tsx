import Link from "next/link";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { requireProfile } from "@/lib/auth/guards";
import { listServerMemberships } from "@/lib/auth/servers";
import { CreateServerForm } from "@/components/servers/create-server-form";
import { BrandMark, BrandWordmark } from "@/components/shell/brand";
import { ServerTile } from "@/components/nav/server-switcher";
import { SignOutButton } from "@/components/nav/sign-out-button";

const INVITE_ERROR_MESSAGES: Record<string, string> = {
  "invite-not-found": "That invite link is invalid or has expired.",
  "invite-email-mismatch": "That invite was sent to a different email address.",
};

export default async function ServersPage({
  searchParams,
}: PageProps<"/servers">) {
  const profile = await requireProfile();
  const params = await searchParams;
  const errorParam = typeof params.error === "string" ? params.error : null;

  const memberships = await listServerMemberships(profile.id);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(55%_40%_at_50%_0%,oklch(0.79_0.16_78/0.14),transparent)]"
      />

      <header className="flex items-center justify-between px-5 py-5 sm:px-10">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <BrandWordmark />
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="hidden sm:inline">{profile.email}</span>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-5 pt-8 pb-20 sm:px-6">
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {memberships.length > 0 ? "Choose a server" : "Let's get you set up"}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {memberships.length > 0
              ? "Pick up where you left off, or start a new one."
              : "Create your own server below, or ask whoever invited you to send a link."}
          </p>
        </div>

        {errorParam && (
          <p className="rounded-xl bg-destructive/10 px-4 py-3 text-center text-sm text-destructive ring-1 ring-destructive/20">
            {INVITE_ERROR_MESSAGES[errorParam] ?? "Something went wrong."}
          </p>
        )}

        {memberships.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            {memberships.map((m) => (
              <Link
                key={m.serverId}
                href={`/s/${m.serverId}/library`}
                className="group flex items-center gap-4 rounded-2xl bg-card/70 p-4 ring-1 ring-white/[0.08] transition duration-200 hover:-translate-y-0.5 hover:bg-card hover:ring-primary/40 hover:shadow-[0_18px_40px_-16px_rgba(0,0,0,0.9)]"
              >
                <ServerTile name={m.serverName} className="size-14 rounded-xl text-2xl" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-semibold">{m.serverName}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="capitalize">{m.role}</span>
                    {m.boxAuthStatus === "needs_reauth" && (
                      <span className="flex items-center gap-1 text-destructive">
                        <TriangleAlert className="size-3" /> Box needs reconnecting
                      </span>
                    )}
                    {m.boxAuthStatus === "disconnected" && <span>Box not connected</span>}
                  </p>
                </div>
                <ArrowRight className="size-5 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
              </Link>
            ))}
          </div>
        )}

        <CreateServerForm />
      </main>
    </div>
  );
}
