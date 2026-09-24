import { AuthForm } from "@/components/auth/auth-form";

const ERROR_MESSAGES: Record<string, string> = {
  "not-invited": "That account hasn't been invited to this server.",
  "auth-failed": "Sign-in failed. Please try again.",
};

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  const params = await searchParams;
  const errorParam = typeof params.error === "string" ? params.error : null;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Roam</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign in to your family&apos;s media server.
        </p>
      </div>
      {errorParam && (
        <p className="text-sm text-destructive">
          {ERROR_MESSAGES[errorParam] ?? "Something went wrong."}
        </p>
      )}
      <AuthForm mode="sign-in" />
    </main>
  );
}
