import type { Metadata } from "next";
import { ApiOperationTable } from "@/components/ApiOperationTable";
import { ApiReference } from "@/components/ApiReference";

export const metadata: Metadata = { title: "API reference" };

export default function ApiReferencePage() {
  return (
    <div className="page">
      <h1>API reference</h1>
      <p>
        Current local event lifecycle API. Run <code>make local</code>, then open
        <code> http://127.0.0.1:5174/api-docs</code> for host operations or
        <code> http://127.0.0.1:5175/api-docs</code> for participant operations. Each listener
        serves its own <code>/openapi.json</code>. This page is browse-only. Cloud Try It requires
        separate Cognito, CORS and API URL configuration and is not supported here.
      </p>
      <ApiOperationTable />
      <ApiReference />
    </div>
  );
}
