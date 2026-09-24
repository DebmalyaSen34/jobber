import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const notice = params.reason === "session-expired"
    ? "Your session ended. Sign in again to continue."
    : params.reason === "logged-out"
      ? "You have been signed out."
      : undefined;

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Continue your preparation."
      description="Sign in to return to your saved roles, preparation kits, and practice history."
    >
      <AuthForm mode="login" notice={notice} />
    </AuthShell>
  );
}
