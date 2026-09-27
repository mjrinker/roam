import { redirect } from "next/navigation";
import { getCurrentViewer } from "@/lib/auth/viewer";
import { SignOutButton } from "@/components/nav/sign-out-button";
import { BrandLogo } from "@/components/shell/brand";
import { ProfilePicker } from "@/components/profiles/profile-picker";
import { MULTIPLE_VIEWERS_ENABLED } from "@/lib/viewers/config";

export default async function ProfilesPage({ searchParams }: PageProps<"/profiles">) {
  const resolved = await getCurrentViewer();
  if (!resolved) redirect("/sign-in");

  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : null;
  const manage = params.manage === "1";

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(55%_40%_at_50%_0%,oklch(0.853_0.163_169/0.14),transparent)]"
      />

      <header className="flex items-center justify-between px-5 py-5 sm:px-10">
        <BrandLogo variant="muted" className="h-5" />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="hidden sm:inline">{resolved.account.email}</span>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center gap-10 px-5 pt-4 pb-24 sm:px-6">
        <h1 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
          {manage ? "Manage profiles" : "Who’s watching?"}
        </h1>
        <ProfilePicker
          profiles={resolved.viewers.map((v) => ({
            id: v.id,
            name: v.name,
            avatarKey: v.avatarKey,
            role: v.role,
            locale: v.locale,
            maxAge: v.maxAge,
            allowUnrated: v.allowUnrated,
            visibleOnServer: v.visibleOnServer,
            hasPin: v.pinHash !== null,
          }))}
          actor={
            resolved.viewer
              ? { id: resolved.viewer.id, role: resolved.viewer.role, hasPin: resolved.viewer.pinHash !== null }
              : null
          }
          canAdd={MULTIPLE_VIEWERS_ENABLED}
          next={next}
          startInManage={manage}
        />
      </main>
    </div>
  );
}
