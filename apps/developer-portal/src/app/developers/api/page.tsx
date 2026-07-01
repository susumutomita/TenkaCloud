import type { Metadata } from "next";
import { ApiOperationTable } from "@/components/ApiOperationTable";
import { ApiReference } from "@/components/ApiReference";
import { SANDBOX_BASE_URL } from "@/content/openapi";

export const metadata: Metadata = { title: "API reference" };

// API reference (ADR-0003 §5: /developers/api/*). Browse + copy only for now; the
// interactive sandbox Try-It is deferred to the post-ADR-0004 PR. The default
// target is the sandbox base URL — production is never the default and no
// credentials are embedded.
export default function ApiReferencePage() {
  return (
    <div className="page">
      <h1>API reference</h1>
      <p>
        Browse the TenkaCloud platform API. The default interactive target is the sandbox base URL (
        <code>{SANDBOX_BASE_URL}</code>); production write paths are never the default and no API
        key is embedded here.
      </p>
      <ApiOperationTable />
      <ApiReference />
    </div>
  );
}
