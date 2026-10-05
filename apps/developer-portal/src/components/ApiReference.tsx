"use client";

import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import { OPENAPI_ARTIFACT } from "@/content/openapi";

export function ApiReference() {
  return (
    <ApiReferenceReact
      configuration={{
        content: OPENAPI_ARTIFACT,
        // Hide client-side Try-It until sandbox authentication is available.
        // Browse + copy only.
        hideTestRequestButton: true,
        persistAuth: false,
        telemetry: false,
      }}
    />
  );
}
