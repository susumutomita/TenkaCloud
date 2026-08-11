import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Developer hub" };

// From the developer hub at /developers, a visitor can reach "API Reference"
// via the developer nav without leaving the app shell.
export default function DevelopersHubPage() {
  return (
    <div className="page">
      <h1>Developer hub</h1>
      <p>Everything you need to build on, extend, and operate TenkaCloud.</p>
      <div className="card-grid">
        <div className="card">
          <h3>Docs</h3>
          <p>Guides and concepts for pack authors and operators.</p>
          <Link href="/developers/docs/getting-started/">Getting started →</Link>
        </div>
        <div className="card">
          <h3>API reference</h3>
          <p>The platform HTTP API, rendered from the OpenAPI source of truth.</p>
          <Link href="/developers/api/">Open the reference →</Link>
        </div>
        <div className="card">
          <h3>Examples</h3>
          <p>Copyable SDK, CLI, and HTTP snippets.</p>
          <Link href="/developers/examples/">Browse examples →</Link>
        </div>
        <div className="card">
          <h3>Changelog</h3>
          <p>Release history across the pack and SDK version axes.</p>
          <Link href="/developers/changelog/">See changes →</Link>
        </div>
      </div>
    </div>
  );
}
