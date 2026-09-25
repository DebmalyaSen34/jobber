import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jobber — Interview preparation",
  description: "Build an evidence-backed interview preparation kit from a job description.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body><a className="skip-link" href="#main">Skip to content</a>{children}</body>
    </html>
  );
}
