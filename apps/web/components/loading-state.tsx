export function InlineSpinner() {
  return <span className="inline-spinner" aria-hidden="true" />;
}

export function LoadingState({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite" aria-busy="true">
      <div className="loading-state__signal"><InlineSpinner /></div>
      <div>
        <strong>{label}</strong>
        {detail && <p>{detail}</p>}
      </div>
      <div className="loading-track" aria-hidden="true"><span /></div>
    </div>
  );
}

export function RouteLoading({ label }: { label: string }) {
  return (
    <main id="main" className="route-loading" aria-label={label} aria-busy="true">
      <LoadingState label={label} detail="Your saved work is safe while this page opens." />
      <div className="skeleton-grid" aria-hidden="true">
        <div className="skeleton-card skeleton-card--wide" />
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
    </main>
  );
}

export function TransitionOverlay({ title, detail, confirmed = false }: {
  title: string;
  detail: string;
  confirmed?: boolean;
}) {
  return (
    <div className="transition-overlay" role="status" aria-live="polite" aria-busy="true">
      <div className={`transition-signal${confirmed ? " transition-signal--confirmed" : ""}`} aria-hidden="true">
        {confirmed ? <span>✓</span> : <InlineSpinner />}
      </div>
      <p className="eyebrow">{confirmed ? "Success" : "Working"}</p>
      <h2>{title}</h2>
      <p>{detail}</p>
      <div className="loading-track" aria-hidden="true"><span /></div>
    </div>
  );
}
