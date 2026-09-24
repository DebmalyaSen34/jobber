import type { ReactNode } from "react";
import { Brand } from "./brand";

export function AuthShell({ eyebrow, title, description, children }: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="auth-shell">
      <header className="auth-header"><Brand /></header>
      <main className="auth-main">
        <section className="auth-intro">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </section>
        <section className="auth-card" aria-label={title}>{children}</section>
      </main>
      <footer className="auth-footer">Your preparation data stays private to your account.</footer>
    </div>
  );
}
