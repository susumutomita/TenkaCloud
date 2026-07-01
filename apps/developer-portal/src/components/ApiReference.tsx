"use client";

import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import { OPENAPI_ARTIFACT } from "@/content/openapi";

// The API reference renderer (ADR-0003 §2: "Scalar owns the API reference ...
// embedded as a React component inside the same app and the same chrome"). The
// committed OpenAPI artifact is passed inline as content — there is NO runtime
// fetch of the spec from GitHub or anywhere else (a prohibition in #2101), and the
// only server is the sandbox base URL. Browse + copy only for now; interactive
// Try-It is deferred to the post-ADR-0004 sandbox PR.
export function ApiReference() {
  return (
    <ApiReferenceReact
      configuration={{
        content: OPENAPI_ARTIFACT,
        // Hide the client-side test "Try It" until the sandbox auth boundary lands
        // (ADR-0004). Browse + copy only.
        hideTestRequestButton: true,
      }}
    />
  );
}
