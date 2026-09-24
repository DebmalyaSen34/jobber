import { ServiceStatus } from "@/components/service-status";

function Mark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 36 36" width="36" height="36">
      <rect width="36" height="36" rx="11" fill="currentColor" />
      <path d="M11 11h14v9.2c0 4.2-3.1 7.3-7.2 7.3-3.7 0-6.5-2.2-7.1-5.6l4-.8c.3 1.6 1.3 2.5 3 2.5 1.8 0 3-1.3 3-3.5v-5.2H11V11Z" fill="#F6F8F1" />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="#main" aria-label="Jobber home">
          <Mark />
          <span>Jobber</span>
        </a>
        <span className="build-label">Foundation preview</span>
      </header>

      <main id="main" className="hero">
        <div className="hero__copy">
          <p className="eyebrow">Interview preparation, grounded in the role</p>
          <h1>Turn a job description into a plan you can practise.</h1>
          <p className="hero__lede">
            Jobber researches the company, extracts evidence-backed requirements, and builds a focused preparation kit around the time you have.
          </p>
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
