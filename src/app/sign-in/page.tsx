import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

const ERROR_MESSAGES: Record<string, string> = {
  "auth-failed": "Sign-in failed. Please try again.",
};

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  const params = await searchParams;
  const errorParam = typeof params.error === "string" ? params.error : null;

  return (
    <AuthShell
      title="Welcome to Roam"
      description="Sign in to join a server you've been invited to, or start your own."
      notice={errorParam ? (ERROR_MESSAGES[errorParam] ?? "Something went wrong.") : undefined}
    >
      <AuthForm mode="sign-in" />
    </AuthShell>
  );
}
