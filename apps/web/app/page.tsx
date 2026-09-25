import { Brand } from "@/components/brand";
import Link from "next/link";
import { cookies } from "next/headers";

export default async function Home() {
  const cookieStore = await cookies();
  const signedIn = cookieStore.has("__Host-jobber_session") || cookieStore.has("jobber_session");

  return (
    <div className="site-shell">
      <header className="site-header">
        <Brand href={signedIn ? "/dashboard" : "/"} label={signedIn ? "Jobber dashboard" : "Jobber home"} />
        <nav className="header-actions" aria-label="Account">
          {signedIn ? (
            <Link className="compact-button" href="/dashboard">Open dashboard</Link>
          ) : (
            <>
              <Link className="text-link" href="/login">Sign in</Link>
              <Link className="compact-button" href="/register">Create account</Link>
            </>
          )}
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
            <Link className="primary-link" href={signedIn ? "/dashboard" : "/register"}>{signedIn ? "Open your workspace" : "Create your workspace"}</Link>
            <Link className="text-link" href={signedIn ? "/create" : "/login"}>{signedIn ? "Prepare another role" : "I already have an account"}</Link>
          </div>
          <div className="trust-note">
            <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22">
              <path d="M12 3 5.5 5.7v5.6c0 4.2 2.7 7.8 6.5 9.7 3.8-1.9 6.5-5.5 6.5-9.7V5.7L12 3Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
              <path d="m9.2 12 1.8 1.8 3.9-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
            </svg>
            <p><strong>Private by default.</strong> Your saved kits, edits, and practice history stay tied to your account.</p>
          </div>
        </div>

        <section className="product-preview" aria-labelledby="preview-heading">
          <div className="product-preview__topline">
            <p className="eyebrow">Inside your kit</p>
            <span>Role-specific</span>
          </div>
          <h2 id="preview-heading">A clear path from role to readiness.</h2>
          <ol className="preview-list">
            <li><span>01</span><div><strong>Know what matters</strong><p>Turn the job description into prioritized, evidence-backed requirements.</p></div></li>
            <li><span>02</span><div><strong>Practise with purpose</strong><p>Work through tailored questions and flashcards instead of generic prompts.</p></div></li>
            <li><span>03</span><div><strong>Use the time you have</strong><p>Follow a focused day-by-day schedule, then return to practise again.</p></div></li>
          </ol>
          <div className="product-preview__footer"><span><i aria-hidden="true" />Built around your timeline</span><strong>1–60 days</strong></div>
        </section>
      </main>

      <footer className="site-footer">
        <span>Evidence-backed preparation</span>
        <span>Built for focused interview days</span>
      </footer>
    </div>
  );
}
