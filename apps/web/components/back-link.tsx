import Link from "next/link";

export function BackLink({ href, destination }: { href: string; destination: string }) {
  return (
    <Link className="back-link" href={href}>
      <span className="back-link__icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" width="18" height="18">
          <path d="m11.75 4.75-5.25 5.25 5.25 5.25M6.75 10h7" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      </span>
      <span className="back-link__label"><span className="back-link__prefix">Back to </span>{destination}</span>
    </Link>
  );
}
