import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  McpServer,
  type OAuthProtectedResourceMetadata,
  originValidationResponse,
  type ServerOptions,
} from "@modelcontextprotocol/server";
import {
  formatDiagnostics,
  SUPPORTED_RUNTIME_CAPABILITIES,
  validatePackManifest,
  validateProblemMetadata,
} from "@tenkacloud/problem-sdk";
import { z } from "zod/v4";
import { ControlStore } from "./store.js";
import type { OrganizerContext, TeamContext } from "./types.js";

const MCP_PROTOCOL_VERSION = "2026-07-28";
const PUBLIC_CACHE_TTL_MS = 5 * 60 * 1000;
const PRIVATE_CACHE_TTL_MS = 0;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const CONCEPT_TERMS = [
  "cloud",
  "database",
  "docker",
  "flag",
  "hint",
  "lite",
  "local-mode",
  "parameter",
  "saas",
] as const;

type ConceptTerm = (typeof CONCEPT_TERMS)[number];
type McpRole = "developer" | "organizer" | "participant" | "problem-author";

export type McpPrincipal =
  | { readonly role: "developer" }
  | { readonly role: "problem-author" }
  | { readonly role: "organizer"; readonly organizer: OrganizerContext }
  | { readonly role: "participant"; readonly team: TeamContext };

export const ORGANIZER_MCP_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/mcp/organizer";

interface ConceptExplanation {
  readonly term: ConceptTerm;
  readonly plainLanguage: string;
  readonly technicalMeaning: string;
  readonly nextStep: string;
}

const CONCEPTS: Readonly<Record<ConceptTerm, Omit<ConceptExplanation, "term">>> = {
  cloud: {
    plainLanguage:
      "自分のPCではなく、インターネット越しに借りるコンピューターや保存場所の総称です。",
    technicalMeaning: "TenkaCloudでは、競技環境を必要な時間だけ起動する実行先を指します。",
    nextStep: "まずlocal modeで操作を練習し、共有イベントが必要になったらLiteかSaaSを選びます。",
  },
  database: {
    plainLanguage: "イベント、チーム、得点などを表のように整理して保存する場所です。",
    technicalMeaning:
      "TenkaCloudのコントロールプレーンは、イベントと採点状態をデータベースに保存します。",
    nextStep: "切り替え前に対象環境、保存先、移行方法、戻し方を確認します。",
  },
  docker: {
    plainLanguage: "アプリと動作に必要なものを、同じ手順で起動できる箱にまとめる仕組みです。",
    technicalMeaning:
      "TenkaCloudのlocal modeでは、問題ごとに分離したコンテナをDockerで起動します。",
    nextStep: "Docker Desktopを起動してから、問題マニュアルにあるmakeコマンドを実行します。",
  },
  flag: {
    plainLanguage: "問題の中で見つけ、得点画面へ提出する答えの文字列です。",
    technicalMeaning: "採点対象のチェックポイントに対応する秘密値で、画面へ完全一致で入力します。",
    nextStep: "問題本文とヒントから探します。ソースコードや他チームの値は参照しません。",
  },
  hint: {
    plainLanguage: "詰まったときに、次に調べる場所や操作を段階的に示す手がかりです。",
    technicalMeaning: "答えそのものを公開せず、問題の学習経路を補助するコンテンツです。",
    nextStep: "まず本文を試し、進めないときだけ画面の「ヒントを開く」を使います。",
  },
  lite: {
    plainLanguage: "自分たちのAWSアカウントへ競技環境を作り、運用も自分たちで行う方式です。",
    technicalMeaning: "TenkaCloud LiteはリポジトリのパイプラインとIaCを使うセルフホスト構成です。",
    nextStep: "AWS権限、費用管理、監視、終了後の削除を自分たちで担当できる場合に選びます。",
  },
  "local-mode": {
    plainLanguage: "クラウドへ公開せず、自分のPCだけで問題を起動して練習する方法です。",
    technicalMeaning: "対応する問題ランタイムをDockerなどでローカル実行するリハーサル経路です。",
    nextStep: "問題一覧でlocal対応を確認し、記載されたmakeコマンドを使います。",
  },
  parameter: {
    plainLanguage: "イベント名や時間など、動かす前に決めて渡す設定値です。",
    technicalMeaning:
      "デプロイや実行時の入力値です。形式、長さ、既定値、変更時の影響が項目ごとに異なります。",
    nextStep: "マニュアルの入力形式と上限を確認し、説明できない任意項目は未設定にします。",
  },
  saas: {
    plainLanguage: "TenkaCloud側が用意したサービスへログインして競技を運営する方式です。",
    technicalMeaning: "インフラの構築や更新をサービス側へ委ねるマネージド構成です。",
    nextStep: "自前のクラウド運用を避け、ブラウザ中心で開催したい場合に選びます。",
  },
};

function cacheHints(cacheScope: "public" | "private"): ServerOptions["cacheHints"] {
  const ttlMs = cacheScope === "public" ? PUBLIC_CACHE_TTL_MS : PRIVATE_CACHE_TTL_MS;
  return {
    "server/discover": { ttlMs, cacheScope },
    "tools/list": { ttlMs, cacheScope },
    "resources/list": { ttlMs, cacheScope },
    "resources/read": { ttlMs, cacheScope },
  };
}

function serverFor(role: McpRole, cacheScope: "public" | "private"): McpServer {
  return new McpServer(
    { name: `tenkacloud-${role}`, version: "0.1.0" },
    {
      instructions:
        "TenkaCloud MCP is read-only. It never returns flags, credentials, or another tenant/team's private data.",
      cacheHints: cacheHints(cacheScope),
    },
  );
}

function toolResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value),
      },
    ],
  };
}

function createDeveloperServer(): McpServer {
  const server = serverFor("developer", "public");
  server.registerResource(
    "role-guide",
    "tenkacloud://developer/roles",
    {
      title: "TenkaCloud role guide",
      description: "Choose the manual and MCP endpoint that match the work you are doing.",
      mimeType: "application/json",
      cacheHint: { ttlMs: PUBLIC_CACHE_TTL_MS, cacheScope: "public" },
    },
    (uri) =>
      jsonResource(uri, {
        roles: [
          { role: "developer", endpoint: "/mcp/developer" },
          { role: "organizer", endpoint: "/mcp/organizer", auth: "Auth0 organizer access token" },
          { role: "participant", endpoint: "/mcp/participant", auth: "team login key" },
          { role: "problem-author", endpoint: "/mcp/problem-author" },
        ],
      }),
  );
  server.registerTool(
    "explain_concept",
    {
      title: "Explain a TenkaCloud concept",
      description:
        "Explain Docker, cloud, local mode, Lite, SaaS, database, parameter, flag, or hint in plain language.",
      inputSchema: z.object({ term: z.enum(CONCEPT_TERMS) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ term }) => toolResult({ term, ...CONCEPTS[term] }),
  );
  server.registerTool(
    "list_runtime_capabilities",
    {
      title: "List problem runtime capabilities",
      description: "List the provider/engine pairs recognized by the problem-pack validator.",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    () => toolResult({ runtimes: SUPPORTED_RUNTIME_CAPABILITIES }),
  );
  return server;
}

function diagnosticsResult(diagnostics: ReturnType<typeof validatePackManifest>) {
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    formatted: formatDiagnostics(diagnostics),
  };
}

function createProblemAuthorServer(): McpServer {
  const server = serverFor("problem-author", "public");
  server.registerResource(
    "validation-guide",
    "tenkacloud://problem-author/validation",
    {
      title: "Problem-pack validation guide",
      description: "Pure validation entry points available without filesystem or cloud access.",
      mimeType: "application/json",
      cacheHint: { ttlMs: PUBLIC_CACHE_TTL_MS, cacheScope: "public" },
    },
    (uri) =>
      jsonResource(uri, {
        tools: ["validate_pack_manifest", "validate_problem_metadata"],
        scope: "JSON values only; no filesystem, network, credentials, or problem execution",
      }),
  );
  server.registerTool(
    "validate_pack_manifest",
    {
      title: "Validate a pack manifest",
      description: "Validate an already-parsed tenkacloud-pack.json value deterministically.",
      inputSchema: z.object({ manifest: z.unknown() }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ manifest }) => toolResult(diagnosticsResult(validatePackManifest(manifest))),
  );
  server.registerTool(
    "validate_problem_metadata",
    {
      title: "Validate problem metadata",
      description: "Validate an already-parsed metadata.json value deterministically.",
      inputSchema: z.object({ metadata: z.unknown() }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ metadata }) => toolResult(diagnosticsResult(validateProblemMetadata(metadata))),
  );
  return server;
}

function createOrganizerServer(db: D1Database, organizer: OrganizerContext): McpServer {
  const server = serverFor("organizer", "private");
  const store = new ControlStore(db);
  server.registerResource(
    "events",
    "tenkacloud://organizer/events",
    {
      title: "Authenticated tenant events",
      description: "Events visible to the authenticated organizer's tenant only.",
      mimeType: "application/json",
      cacheHint: { ttlMs: PRIVATE_CACHE_TTL_MS, cacheScope: "private" },
    },
    async (uri) => jsonResource(uri, { events: await store.listEvents(organizer.tenantId) }),
  );
  server.registerTool(
    "list_events",
    {
      title: "List my tenant's events",
      description: "List events owned by the authenticated organizer's tenant.",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => toolResult({ events: await store.listEvents(organizer.tenantId) }),
  );
  return server;
}

function createParticipantServer(db: D1Database, team: TeamContext): McpServer {
  const server = serverFor("participant", "private");
  const store = new ControlStore(db);
  server.registerResource(
    "me",
    "tenkacloud://participant/me",
    {
      title: "Authenticated participant identity",
      description: "The current team identity. It never includes the team login key.",
      mimeType: "application/json",
      cacheHint: { ttlMs: PRIVATE_CACHE_TTL_MS, cacheScope: "private" },
    },
    (uri) =>
      jsonResource(uri, {
        teamId: team.teamId,
        eventId: team.eventId,
        displayName: team.displayName,
      }),
  );
  server.registerTool(
    "get_my_score",
    {
      title: "Get my team's score",
      description:
        "Return only the authenticated team's aggregate score and solved-checkpoint count.",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const score = await store.participantScore(team.eventId, team.teamId);
      return toolResult(score ?? { found: false });
    },
  );
  return server;
}

function createRoleServer(db: D1Database, principal: McpPrincipal): McpServer {
  switch (principal.role) {
    case "developer":
      return createDeveloperServer();
    case "problem-author":
      return createProblemAuthorServer();
    case "organizer":
      return createOrganizerServer(db, principal.organizer);
    case "participant":
      return createParticipantServer(db, principal.team);
  }
}

function safeHeader(value: string | null): string | undefined {
  if (value === null) return undefined;
  return [...value]
    .filter((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint >= 0x20 && codePoint !== 0x7f;
    })
    .join("")
    .slice(0, 128);
}

function principalId(principal: McpPrincipal): string {
  if (principal.role === "organizer") return principal.organizer.subject;
  if (principal.role === "participant") return principal.team.teamId;
  return "public";
}

function transportRejection(request: Request): Response | undefined {
  const requestHostname = new URL(request.url).hostname;
  return (
    hostHeaderValidationResponse(request, [requestHostname]) ??
    originValidationResponse(request, [requestHostname])
  );
}

export function mcpRequestWithoutCredentials(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  return new Request(request, { headers });
}

function organizerMcpResourceUrl(request: Request): URL {
  return new URL("/mcp/organizer", request.url);
}

function authorizationServerUrl(issuer: string): string {
  const issuerUrl = new URL(issuer);
  const isLoopback =
    issuerUrl.hostname === "localhost" ||
    issuerUrl.hostname === "127.0.0.1" ||
    issuerUrl.hostname === "[::1]";
  const isAllowedProtocol =
    issuerUrl.protocol === "https:" || (issuerUrl.protocol === "http:" && isLoopback);
  if (
    !isAllowedProtocol ||
    issuerUrl.username.length > 0 ||
    issuerUrl.password.length > 0 ||
    issuerUrl.hash.length > 0 ||
    issuerUrl.search.length > 0
  ) {
    throw new Error(
      "AUTH0_ISSUER must be an HTTPS issuer URL without credentials, query, or fragment",
    );
  }
  return issuerUrl.href;
}

export function organizerMcpResourceMetadata(request: Request, issuer: string): Response {
  const metadata: OAuthProtectedResourceMetadata = {
    resource: organizerMcpResourceUrl(request).href,
    authorization_servers: [authorizationServerUrl(issuer)],
    resource_name: "TenkaCloud organizer MCP",
    resource_documentation: "https://www.tenkacloud.com/docs/manual/organizer/",
  };
  return Response.json(metadata, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}

export function organizerMcpAuthenticationChallenge(request: Request): string {
  return `Bearer realm="tenkacloud-organizer", resource_metadata="${getOAuthProtectedResourceMetadataUrl(
    organizerMcpResourceUrl(request),
  )}"`;
}

/**
 * Serve one strict MCP 2026-07-28 exchange.
 *
 * Authentication and role projection happen before this function. Each call
 * creates a fresh SDK handler/server and closes it after the JSON response, so
 * no protocol session or sticky worker instance can carry authorization state.
 */
export async function serveMcp(
  request: Request,
  db: D1Database,
  principal: McpPrincipal,
): Promise<Response> {
  const rejected = transportRejection(request);
  if (rejected) return rejected;

  const handler = createMcpHandler(() => createRoleServer(db, principal), {
    legacy: "reject",
    responseMode: "json",
    onerror: (error) => {
      console.error(
        JSON.stringify({
          event: "always-on.mcp.failed",
          role: principal.role,
          errorName: error.name,
        }),
      );
    },
  });

  let response: Response;
  try {
    // Authentication already projected a narrow principal. Do not pass the
    // raw bearer or cookies into the SDK factory/request context.
    response = await handler.fetch(mcpRequestWithoutCredentials(request));
  } finally {
    await handler.close();
  }
  console.info(
    JSON.stringify({
      event: "always-on.mcp.request",
      protocolVersion: MCP_PROTOCOL_VERSION,
      role: principal.role,
      principalId: principalId(principal),
      method: safeHeader(request.headers.get("Mcp-Method")),
      name: safeHeader(request.headers.get("Mcp-Name")),
      status: response.status,
    }),
  );
  return response;
}
