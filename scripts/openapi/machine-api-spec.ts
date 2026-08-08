import {
  DeployRequestSchema,
  DeployResponseSchema,
} from "../../infrastructure/lib/problem-deploy/handlers/deploy-handler/types.ts";
import {
  capabilityScope,
  MACHINE_ACCESS_TOKEN_VALIDITY_MINUTES,
  MACHINE_ROUTE_SCOPES,
  type MachineCapability,
  type MachineRouteScope,
} from "../../infrastructure/lib/problem-deploy/handlers/shared/machine-scopes.ts";
import { type JsonSchema, zodToJsonSchema } from "./zod-json-schema.ts";

/**
 * Issue #2949: machine API surface の OpenAPI 3.1 spec を **source of truth から生成する**。
 *
 * 入力は 2 つだけである。
 *
 *  - `MACHINE_ROUTE_SCOPES` — route と必要 capability の正本 (#2948)。
 *  - handler の zod schema — request / response body の正本。
 *
 * 手書きの path や手書きの schema は 1 つも無い。route を足したり capability を変えたりすると
 * spec が自動で変わり、CI の drift 検査が「commit されている生成物」との差分を検出する。
 *
 * ## 意図的にしていないこと
 *
 *  - `servers` の既定を production にしない。既定は解決不能な `https://example.invalid` で、
 *    利用者が自分の `MachineApiUrl` を variable で差し替える。生成物をそのまま Try-It に載せて
 *    本番へ飛ばす事故を構造的に起こせなくする。
 *  - example に token / secret を一切置かない。`assertNoSecretMaterial` が生成物全体を走査する。
 */

const OPENAPI_VERSION = "3.1.0";
const SECURITY_SCHEME_NAME = "TenkaCloudMachineOAuth";

/** operation ごとの capability を機械可読にする拡張 (ADR-0004 の capability ラベルに倣う)。 */
export const CAPABILITY_EXTENSION = "x-tenkacloud-capability";

export interface OpenApiOperation {
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly parameters?: readonly {
    readonly name: string;
    readonly in: "path";
    readonly required: true;
    readonly schema: JsonSchema;
  }[];
  readonly requestBody?: {
    readonly required: true;
    readonly content: Record<string, { readonly schema: JsonSchema }>;
  };
  readonly responses: Record<string, { readonly description: string; readonly content?: unknown }>;
  readonly security: readonly Record<string, readonly string[]>[];
  readonly [CAPABILITY_EXTENSION]: MachineCapability;
}

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: Record<string, unknown>;
  readonly servers: readonly unknown[];
  readonly paths: Record<string, Record<string, OpenApiOperation>>;
  readonly components: Record<string, unknown>;
}

const PATH_PARAMETER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  jobId: "Deployment job id (ULID).",
  problemId: "Problem id from the catalog.",
  eventId: "Event id (ULID).",
};

const OPERATION_SUMMARIES: Readonly<Record<string, { summary: string; description: string }>> = {
  "GET /deployments": {
    summary: "List deployments for the calling tenant",
    description:
      "Returns the tenant's deployment jobs, newest first. The tenant is taken from the token's binding scope; there is no tenant parameter.",
  },
  "GET /deployments/{jobId}": {
    summary: "Get one deployment",
    description: "Returns a single deployment job owned by the calling tenant.",
  },
  "GET /deployments/{jobId}/stack-progress": {
    summary: "Get CloudFormation progress for a deployment",
    description:
      "Returns stack events and resources for the job. Separate from the job itself because the CloudFormation calls are slow and may throttle.",
  },
  "GET /problems/{problemId}/deployments": {
    summary: "List deployments of one problem",
    description: "Returns the tenant's deployment jobs for a single problem.",
  },
  "GET /events": {
    summary: "List events",
    description: "Returns the tenant's competition events.",
  },
  "GET /events/{eventId}": {
    summary: "Get one event",
    description:
      "Returns a single event. Team login keys are never included on this path for a machine principal.",
  },
  "POST /problems/{problemId}/deploy": {
    summary: "Start a deployment",
    description:
      "Starts a deployment of one problem for one team and returns the job id. This is the only mutating operation available to a machine principal.",
  },
};

function operationIdFor(route: MachineRouteScope): string {
  const segments = route.apigwPath
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith("{")
        ? `By${segment.slice(1, -1).replace(/^./, (c) => c.toUpperCase())}`
        : segment.replace(/-([a-z])/g, (_match, c: string) => c.toUpperCase()),
    );
  const verb = route.method === "GET" ? "get" : "post";
  return verb + segments.map((segment) => segment.replace(/^./, (c) => c.toUpperCase())).join("");
}

function pathParametersFor(route: MachineRouteScope): OpenApiOperation["parameters"] {
  // segment 単位で切り出す。API Gateway の path 表記では `{param}` が必ず 1 segment 全体なので、
  // 正規表現で `{...}` を掘る必要が無い (= backtracking の余地も作らない)。
  const names = route.apigwPath
    .split("/")
    .filter((segment) => segment.startsWith("{") && segment.endsWith("}"))
    .map((segment) => segment.slice(1, -1));
  if (names.length === 0) return undefined;
  return names.map((name) => ({
    name,
    in: "path" as const,
    required: true as const,
    schema: {
      type: "string",
      description: PATH_PARAMETER_DESCRIPTIONS[name] ?? `Path parameter ${name}.`,
    },
  }));
}

function buildOperation(route: MachineRouteScope): OpenApiOperation {
  const key = `${route.method} ${route.apigwPath}`;
  const copy = OPERATION_SUMMARIES[key];
  if (!copy) {
    // route を足して copy を足し忘れたら生成を止める。ラベルの無い operation を公開しない。
    throw new Error(`OpenAPI summary が未定義の route です: ${key}`);
  }
  const parameters = pathParametersFor(route);
  const isDeploy = route.capability === "deploy";
  return {
    operationId: operationIdFor(route),
    summary: copy.summary,
    description: copy.description,
    tags: [route.apigwPath.startsWith("/events") ? "events" : "deployments"],
    ...(parameters ? { parameters } : {}),
    ...(isDeploy
      ? {
          requestBody: {
            required: true as const,
            content: {
              "application/json": { schema: zodToJsonSchema(DeployRequestSchema) },
            },
          },
        }
      : {}),
    responses: {
      "200": { description: "OK" },
      ...(isDeploy
        ? {
            "202": {
              description: "Deployment accepted",
              content: {
                "application/json": { schema: zodToJsonSchema(DeployResponseSchema) },
              },
            },
          }
        : {}),
      "401": { description: "The token is missing, expired, or lacks the required scope." },
      "403": {
        description:
          "The machine credential is not allowed to call this route (`forbidden_machine_route`) or its role is rejected (`forbidden_role`).",
      },
      "404": { description: "Not found within the calling tenant." },
    },
    security: [{ [SECURITY_SCHEME_NAME]: [capabilityScope(route.capability)] }],
    [CAPABILITY_EXTENSION]: route.capability,
  };
}

export function buildMachineApiSpec(): OpenApiDocument {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  for (const route of MACHINE_ROUTE_SCOPES) {
    const method = route.method.toLowerCase();
    const existing = paths[route.apigwPath] ?? {};
    existing[method] = buildOperation(route);
    paths[route.apigwPath] = existing;
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "TenkaCloud Machine API",
      version: "1.0.0",
      description:
        "Machine-to-machine surface of the TenkaCloud Tenant API (ADR-0005 Phase 1). " +
        "A machine principal holds the role `TenantMachine`, which no destructive route accepts, " +
        "so the operations below are the complete surface reachable with a machine credential. " +
        "This reference is generated from the platform's own route table and validation schemas.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [
      {
        // 既定は解決不能な host。利用者は tenant stack の CfnOutput `MachineApiUrl` を入れる。
        url: "{machineApiBaseUrl}",
        description:
          "Per-tenant machine API base URL. Take it from the tenant stack output `MachineApiUrl`. There is no shared production host.",
        variables: {
          machineApiBaseUrl: {
            default: "https://example.invalid/prod",
            description: "Replace with your tenant's MachineApiUrl output.",
          },
        },
      },
    ],
    paths,
    components: {
      securitySchemes: {
        [SECURITY_SCHEME_NAME]: {
          type: "oauth2",
          description:
            `Cognito client credentials. The access token lives for ${MACHINE_ACCESS_TOKEN_VALIDITY_MINUTES} minutes. ` +
            "Every token must also carry the tenant binding scope `tc-tenant-<tenantId>/bind`; a token without exactly one binding scope is rejected.",
          flows: {
            clientCredentials: {
              tokenUrl: "{cognitoDomain}/oauth2/token",
              scopes: {
                [capabilityScope("read")]: "Read deployments and events.",
                [capabilityScope("deploy")]: "Start a deployment.",
              },
            },
          },
        },
      },
    },
  };
}

/**
 * 生成物に credential material が紛れていないことを検査する。
 *
 * spec は公開リファレンスになる。example に本物の token を貼ってしまう事故は 1 度で致命的
 * なので、生成時と CI の両方で走らせる。見つかったら生成を失敗させる。
 */
export function findSecretMaterial(serialized: string): string[] {
  const patterns: readonly { readonly label: string; readonly re: RegExp }[] = [
    { label: "bearer token", re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
    { label: "JWT", re: /\beyJ[A-Za-z0-9._-]{20,}/ },
    { label: "client secret assignment", re: /"?client_?secret"?\s*[:=]\s*"[^"]{8,}"/i },
    { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
    { label: "AWS secret access key assignment", re: /aws_secret_access_key\s*[:=]/i },
  ];
  return patterns.filter(({ re }) => re.test(serialized)).map(({ label }) => label);
}

export function serializeSpec(spec: OpenApiDocument): string {
  const serialized = `${JSON.stringify(spec, null, 2)}\n`;
  const leaks = findSecretMaterial(serialized);
  if (leaks.length > 0) {
    throw new Error(
      `生成した OpenAPI spec に credential material が含まれています: ${leaks.join(", ")}`,
    );
  }
  return serialized;
}
