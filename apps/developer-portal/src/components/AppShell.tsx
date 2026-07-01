import type { ReactNode } from "react";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

// The shared app shell (ADR-0003 §2/§6): ONE header + footer + theme + search,
// wrapping marketing, docs, and the API reference. There is no second shell — every
// route renders inside this, which is the "feels like one product" guarantee.
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
