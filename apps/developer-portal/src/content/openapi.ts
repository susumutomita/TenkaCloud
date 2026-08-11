// The API reference renders this checked-in, browse-only OpenAPI artifact. A future
// CI step will generate and validate it from the platform API.
//
// The default server is the sandbox, never production. No API key or bearer token
// is embedded. Every operation
// carries exactly one `x-tenkacloud-capability` label so the renderer can gate
// what a reader's zone may exercise once interactive Try-It lands.

export type Capability = "browse-only" | "sandbox-safe" | "authenticated-write";

export interface OpenApiArtifact {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string; readonly description: string };
  readonly servers: ReadonlyArray<{ readonly url: string; readonly description: string }>;
  readonly paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface OpenApiOperation {
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly "x-tenkacloud-capability": Capability;
  readonly responses: Record<string, { readonly description: string }>;
}

// Sandbox is the only default target; production is intentionally absent.
export const SANDBOX_BASE_URL = "https://sandbox.api.tenkacloud.example/v1";

export const OPENAPI_ARTIFACT: OpenApiArtifact = {
  openapi: "3.1.0",
  info: {
    title: "TenkaCloud Platform API",
    version: "2026-06-29",
    description:
      "Browse-only reference for the TenkaCloud platform API. Interactive Try-It targets the sandbox; production write paths are never the default target.",
  },
  servers: [{ url: SANDBOX_BASE_URL, description: "Sandbox (default, isolated tenant)" }],
  paths: {
    "/packs": {
      get: {
        operationId: "listPacks",
        summary: "List problem packs",
        description: "Returns the catalog of published Battle and Challenge packs.",
        tags: ["Packs"],
        "x-tenkacloud-capability": "browse-only",
        responses: { "200": { description: "A list of problem packs." } },
      },
    },
    "/packs/{packId}": {
      get: {
        operationId: "getPack",
        summary: "Get a problem pack",
        description: "Returns one pack's metadata, scoring kind, and compatibility.",
        tags: ["Packs"],
        "x-tenkacloud-capability": "browse-only",
        responses: { "200": { description: "The requested pack." } },
      },
    },
    "/deployments": {
      post: {
        operationId: "createDeployment",
        summary: "Create a deployment",
        description:
          "Deploys a pack into a competitor account. Write operation — requires an authenticated sandbox session; never available to anonymous Try-It.",
        tags: ["Deployments"],
        "x-tenkacloud-capability": "authenticated-write",
        responses: { "202": { description: "Deployment accepted." } },
      },
    },
  },
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
