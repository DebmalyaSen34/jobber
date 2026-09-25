import Link from "next/link";

function Mark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 36 36" width="36" height="36">
      <rect width="36" height="36" rx="11" fill="currentColor" />
      <path d="M11 11h14v9.2c0 4.2-3.1 7.3-7.2 7.3-3.7 0-6.5-2.2-7.1-5.6l4-.8c.3 1.6 1.3 2.5 3 2.5 1.8 0 3-1.3 3-3.5v-5.2H11V11Z" fill="#F6F8F1" />
    </svg>
  );
}

export function Brand({ href = "/", label = "Jobber home" }: { href?: string; label?: string }) {
  return (
    <Link className="brand" href={href} aria-label={label}>
      <Mark />
      <span>Jobber</span>
    </Link>
  );
}
