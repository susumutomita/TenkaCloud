import { localOpenApi } from "../../../../scripts/local-host/openapi";
export type Capability = "browse-only" | "sandbox-safe" | "authenticated-write";

export interface OpenApiArtifact {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string; readonly description: string };
  readonly servers: ReadonlyArray<{ readonly url: string; readonly description: string }>;
  readonly components?: unknown;
  readonly paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface OpenApiOperation {
  readonly security?: unknown;
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly "x-tenkacloud-capability": Capability;
  readonly responses: Record<string, { readonly description: string }>;
}

// The public portal is browse-only. Interactive requests belong on each local listener.
export const LOCAL_API_BASE_URL = "/api";
export const OPENAPI_ARTIFACT: OpenApiArtifact = {
  openapi: "3.0.3",
  info: {
    title: "TenkaCloud local lifecycle API",
    version: "1.0.0",
    description:
      "Minimal lifecycle operations. Run make local and use each listener's /api-docs and /openapi.json. Cloud Try It is not supported.",
  },
  servers: [
    { url: LOCAL_API_BASE_URL, description: "Local listener only; public portal is browse-only" },
  ],
  components: {
    securitySchemes: {
      ...localOpenApi("admin").components.securitySchemes,
      ...localOpenApi("participant").components.securitySchemes,
    },
  },
  paths: Object.fromEntries(
    Object.entries({ ...localOpenApi("admin").paths, ...localOpenApi("participant").paths }).map(
      ([path, methods]) => [
        path,
        Object.fromEntries(
          Object.entries(methods)
            .filter(([, operation]) => operation !== undefined)
            .map(([method, operation]) => [
              method,
              {
                ...operation,
                security: operation.security ?? [
                  { [path.startsWith("/portal/") ? "teamKey" : "hostSession"]: [] },
                ],
                tags: [path.startsWith("/portal/") ? "Participant" : "Host"],
                "x-tenkacloud-capability": method === "get" ? "browse-only" : "authenticated-write",
                description: operation.description ?? "Local lifecycle operation.",
              },
            ]),
        ),
      ],
    ),
  ) as OpenApiArtifact["paths"],
};

export interface ApiOperationSummary {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly capability: Capability;
}

// The command palette indexes this operation list alongside MDX headings.
export function listApiOperations(
  artifact: OpenApiArtifact = OPENAPI_ARTIFACT,
): readonly ApiOperationSummary[] {
  const operations: ApiOperationSummary[] = [];
  for (const [path, methods] of Object.entries(artifact.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      operations.push({
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        summary: op.summary,
        capability: op["x-tenkacloud-capability"],
      });
    }
  }
  return operations;
}
