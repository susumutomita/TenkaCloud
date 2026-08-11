"use client";

import { useEffect } from "react";

// A static-export-friendly redirect. `output: export` does not emit Next's
// redirects(), so each legacy route renders a stub that points at its canonical
// destination via <meta http-equiv="refresh"> (works without JS) plus a client
// navigation (instant when JS runs). The destination comes from the REDIRECTS
// source of truth (legacy-route migration: old URLs redirect, no dead links).
export function LegacyRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);

  return (
    <div className="page">
      <p>
        This page has moved. Continue to <a href={to}>{to}</a>.
      </p>
    </div>
  );
}
