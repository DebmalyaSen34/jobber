import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";

export default function RegisterPage() {
  return (
    <AuthShell
      eyebrow="Create your workspace"
      title="Prepare with continuity."
      description="Create an account so every role, edit, and practice session can be safely resumed."
    >
      <AuthForm mode="register" />
    </AuthShell>
  );
}
