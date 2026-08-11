"use client";

import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import { OPENAPI_ARTIFACT } from "@/content/openapi";

// Scalar renders the API reference inside the shared app shell. The committed
// OpenAPI artifact is passed inline as content — there is NO runtime
// fetch of the spec from GitHub or anywhere else (a prohibition in #2101), and the
// only server is the sandbox base URL. The reference is browse-and-copy only;
// interactive Try-It stays hidden.
export function ApiReference() {
  return (
    <ApiReferenceReact
      configuration={{
        content: OPENAPI_ARTIFACT,
        // Hide client-side Try-It until sandbox authentication is available.
        // Browse + copy only.
        hideTestRequestButton: true,
      }}
    />
  );
}
