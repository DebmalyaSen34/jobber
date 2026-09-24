import { ServiceStatus } from "@/components/service-status";
import { Brand } from "@/components/brand";
import Link from "next/link";

export default function Home() {
  return (
    <div className="site-shell">
      <header className="site-header">
        <Brand />
        <nav className="header-actions" aria-label="Account">
          <Link className="text-link" href="/login">Sign in</Link>
          <Link className="compact-button" href="/register">Create account</Link>
        </nav>
      </header>

      <main id="main" className="hero">
        <div className="hero__copy">
          <p className="eyebrow">Interview preparation, grounded in the role</p>
          <h1>Turn a job description into a plan you can practise.</h1>
          <p className="hero__lede">
            Jobber researches the company, extracts evidence-backed requirements, and builds a focused preparation kit around the time you have.
          </p>
          <div className="hero-actions">
            <Link className="primary-link" href="/register">Create your workspace</Link>
            <Link className="text-link" href="/login">I already have an account</Link>
          </div>
          <div className="foundation-note">
            <span aria-hidden="true">01</span>
            <p><strong>The durable foundation comes first.</strong> This early slice verifies the web app, API, and database boundary before user accounts and background generation arrive.</p>
          </div>
        </div>

        <ServiceStatus />
      </main>

      <footer className="site-footer">
        <span>Evidence-backed preparation</span>
        <span>Built for focused interview days</span>
      </footer>
    </div>
  );
}
