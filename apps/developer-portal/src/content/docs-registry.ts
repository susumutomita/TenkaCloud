import type { Maturity } from "@/lib/maturity";

// The docs page tree (ADR-0003 §6: "Sidebar / nav tree owned by the Fumadocs page
// tree"). Until the Fumadocs swap (tracked as a follow-up), this typed registry is
// the single source of truth that drives the docs sidebar, the search index, and
// the build-time link checker. Each entry maps a route slug to a real MDX file
// under src/app/developers/docs and carries searchable text.

export interface DocHeading {
  readonly id: string;
  readonly text: string;
}

export interface DocPage {
  readonly slug: string;
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly maturity: Maturity;
  readonly section: string;
  // Searchable body text (plain prose extracted from the MDX) plus headings.
  readonly headings: readonly DocHeading[];
  readonly body: string;
}

export interface DocSection {
  readonly title: string;
  readonly pages: readonly DocPage[];
}

export const DOC_PAGES: readonly DocPage[] = [
  {
    slug: "getting-started",
    href: "/developers/docs/getting-started/",
    title: "Getting started",
    description: "Step-by-step deploys for every mode: local drills, Codespaces, Lite, SaaS.",
    maturity: "stable",
    section: "Start here",
    headings: [
      { id: "local-drills", text: "Local drills — Docker, no AWS" },
      { id: "codespaces", text: "GitHub Codespaces — zero install" },
      { id: "lite-console-launcher", text: "Lite mode on AWS — console launcher" },
      { id: "lite-cli", text: "Lite mode on AWS — CLI" },
      { id: "control-data-backend", text: "Choosing the control-data backend: DynamoDB or Turso" },
      { id: "saas", text: "SaaS mode — multi-tenant" },
    ],
    body: "Step-by-step deployment guide for every TenkaCloud mode. Local container drills with Docker, instant scoring, and the participant portal, zero-install GitHub Codespaces, Lite mode on AWS via the CloudFormation console launcher or the CLI with make deploy, the DynamoDB versus Turso control-data backend switch (CDK_PARAM_CONTROL_DATA_BACKEND), and the full multi-tenant SaaS mode with make deploy-saas. 全モードのステップバイステップ・デプロイ手順。ローカルドリル (Docker)、Codespaces、Lite (コンソールランチャー / CLI)、DynamoDB と Turso の切り替え、マルチテナント SaaS。",
  },
  {
    slug: "concepts/problem-packs",
    href: "/developers/docs/concepts/problem-packs/",
    title: "Problem packs",
    description: "How Battle and Challenge packs are authored and scored.",
    maturity: "stable",
    section: "Concepts",
    headings: [
      { id: "what-is-a-pack", text: "What is a problem pack" },
      { id: "battle-vs-challenge", text: "Battle versus Challenge" },
      { id: "scoring-kinds", text: "Scoring kinds" },
    ],
    body: "A problem pack is the unit of competition content. Battle packs are real-time and head-to-head; Challenge packs are self-paced and evergreen. Each pack carries metadata, a CloudFormation template, and an optional portal plugin. Scoring uses one of six built-in kinds.",
  },
  {
    slug: "concepts/architecture",
    href: "/developers/docs/concepts/architecture/",
    title: "Platform architecture",
    description: "The four planes, the cross-plane EventBridge contracts, and the cost-zero rules.",
    maturity: "stable",
    section: "Concepts",
    headings: [
      { id: "the-four-planes", text: "The four planes" },
      { id: "cross-plane-contracts", text: "Cross-plane contracts" },
      { id: "cost-zero-principles", text: "Cost-zero principles" },
    ],
    body: "Platform architecture. The four planes: control plane (SBT ControlPlane, the tenant manager) and admin-console; pooled application plane shared by BASIC and ADVANCED; silo application plane for PLATINUM; problem-deploy backend and participant portal. Tenant isolation lives in the infrastructure layer, never in app code; the SPAs share one dist and differ only through runtime-config.json. Cross-plane contracts on the EventBridge bus: onboardingRequest, DeployCreateRequested, DeployDeleteRequested, each requiring the tenant ExternalId for cross-account AssumeRole. Cost-zero principles: SSM SecureString instead of Secrets Manager, DynamoDB forced PROVISIONED 1/1, polling instead of SSE or WebSocket. アーキテクチャ概観。4 プレーン (Control / App pooled / App silo / Problem deploy + Participant Portal) と責務境界、クロスプレーン契約 (EventBridge と runtime-config.json 注入)、コストゼロ原則 (SSM SecureString / DynamoDB 1/1 / polling)。",
  },
  {
    slug: "operate/deploy-paths",
    href: "/developers/docs/operate/deploy-paths/",
    title: "Deploy modes and launch paths",
    description: "Lite vs SaaS, how tenants are provisioned, and what the CodePipeline is for.",
    maturity: "preview",
    section: "Operate",
    headings: [
      { id: "two-deploy-modes", text: "Two deploy modes" },
      { id: "how-a-new-tenant-is-provisioned", text: "How a new tenant is provisioned" },
      { id: "what-the-saas-pipeline-is-for", text: "What the SaaS pipeline is for" },
      { id: "how-a-problem-deploys", text: "How a problem deploys" },
    ],
    body: "Deploy modes and launch paths. Lite mode (make deploy) deploys two stacks via tenkacloud-lite.ts with no CodePipeline; SaaS mode (make deploy-saas, three phases) stands up the SBT control plane. The platform is deployed by a manual CLI step; CI never deploys. A new tenant is provisioned by the SBT BashJobRunner running provision-tenant.sh on onboardingRequest (pooled by default, a silo stack for PLATINUM) — not by the pipeline. The tenkacloud-saas-pipeline CodePipeline rolls out tenant stacks across existing tenants from an S3 source.zip via a Step Functions WaveIterator and CodeBuild. A problem deploy goes console Deploy to Deploy API to EventBridge DeployCreateRequested to Step Functions CodeBuild to cross-account CloudFormation CreateStack with the ExternalId. デプロイモードと起動経路の地図。手動 CLI (Lite make deploy / SaaS make deploy-saas) と自動 (CodePipeline によるテナント rollout) を区別する。新規テナント払い出しは provision-tenant.sh、既存テナント rollout は tenkacloud-saas-pipeline、問題デプロイは DeployCreateRequested から CodeBuild とクロスアカウント CFn。",
  },
  {
    slug: "operate/run-an-event",
    href: "/developers/docs/operate/run-an-event/",
    title: "Run an event end to end",
    description:
      "Create a tenant, connect competitor accounts, deploy problems, and enable multi-cloud.",
    maturity: "preview",
    section: "Operate",
    headings: [
      { id: "create-a-tenant", text: "Create a tenant" },
      { id: "connect-a-competitor-account", text: "Connect a competitor account" },
      { id: "deploy-a-problem", text: "Deploy a problem" },
      { id: "enable-multi-cloud", text: "Enable multi-cloud" },
    ],
    body: "Run an event end to end, the operator walkthrough. Create a tenant from the admin-console (onboardingRequest; pooled or PLATINUM silo) and hand the application-admin-console URL to the tenant admin. Connect a competitor account by deploying competitor-bootstrap.yaml, a least-privilege IAM role pinned to the control-plane account id and the tenant ExternalId. Deploy a problem from the application-admin-console event create wizard: pick catalog problems, assign each team account and region, deploy via cross-account CloudFormation, poll status, and tear down. Enable multi-cloud by setting features.nonAwsRuntime in runtime-config.json, then register each team's Sakura, Azure, or GCP credentials in the Team Cloud Credentials panel, which writes them to SSM SecureString via the API so operators never touch SSM directly. イベントを通しで運営する手順。テナント作成、競技者アカウント接続 (competitor-bootstrap.yaml + ExternalId)、問題デプロイ (event 作成 → picker → デプロイ → status ポーリング → teardown)、マルチクラウド有効化 (nonAwsRuntime + Team Cloud Credentials パネル)。",
  },
  {
    slug: "operate/use-existing-pack",
    href: "/developers/docs/operate/use-existing-pack/",
    title: "Use an existing pack",
    description:
      "Install a pinned pack revision, activate it for a tenant, verify it, and use it in an event.",
    maturity: "preview",
    section: "Operate",
    headings: [
      { id: "prerequisites", text: "Prerequisites" },
      { id: "install-the-pinned-git-revision", text: "Install the pinned Git revision" },
      { id: "activate-it-for-the-tenant", text: "Activate it for the tenant" },
      { id: "verify-the-installed-revision", text: "Verify the installed revision" },
      { id: "create-the-event", text: "Create the event" },
    ],
    body: 'Use an existing pack, the five-minute organizer path. Start with an HTTPS Git URL and full immutable 40-hex commit SHA, or a local pack directory for rehearsal. Run the make pack-* wrappers from the repo root (the CLI default store ./.tenkacloud/pack-store resolves against the CWD): install the pinned revision with make pack-install ARGS="git <https-url> --commit <40-hex-commit-sha>", then activate it for one tenant with make pack-activate ARGS="<id@version> --tenant <tenant>". Verify the local lock with make pack-list. In the application-admin-console event picker, activated pack problems appear beside the official catalog, event creation pins the effective catalog snapshot, and deployments carry pack provenance from that pinned snapshot. The event-creation step is preview because the live browser flow is still pending batch verification.',
  },
  // [Issue #2103] Reference pages. The normative tables on these pages render the
  // GENERATED reference-data module (src/content/reference-data.ts), which the
  // generator derives from the real pack/problem schemas, runtime capability
  // declarations, the pack CLI usage strings, and the validator error-code
  // registry. The drift check fails the build when those sources change without a
  // regenerate.
  {
    slug: "reference/pack-manifest",
    href: "/developers/docs/reference/pack-manifest/",
    title: "Pack manifest reference",
    description: "Every tenkacloud-pack.json field, generated from the manifest schema.",
    maturity: "stable",
    section: "Reference",
    headings: [
      { id: "fields", text: "Fields" },
      { id: "example", text: "Example" },
    ],
    body: "Pack manifest reference. The tenkacloud-pack.json fields generated from the PackManifestSchema: schemaVersion, id, version, core, title, description, license, problemsRoot, requiredRuntimes, dependencies. The manifest is inert with no scripts or hooks.",
  },
  {
    slug: "reference/problem-metadata",
    href: "/developers/docs/reference/problem-metadata/",
    title: "Problem metadata reference",
    description: "Every metadata.json field, derived from the SDK validator.",
    maturity: "stable",
    section: "Reference",
    headings: [
      { id: "fields", text: "Fields" },
      { id: "runtime-declaration", text: "Runtime declaration" },
      { id: "example", text: "Example" },
    ],
    body: "Problem metadata reference. The metadata.json fields derived from the ProblemMetadata contract and validateProblemMetadata: id, runtime, cfnTemplate, scoring, endpoints, phases, disruptions. Runtime is a single descriptor or a composite of 2 to 8 targets.",
  },
  {
    slug: "reference/runtime-matrix",
    href: "/developers/docs/reference/runtime-matrix/",
    title: "Runtime capability matrix",
    description: "AWS, GCP, Azure, and Sakura runtime support, derived from the runtime package.",
    maturity: "preview",
    section: "Reference",
    headings: [
      { id: "matrix", text: "Matrix" },
      { id: "support-classes", text: "Support classes" },
    ],
    body: "Runtime capability matrix for AWS, GCP, Azure, and Sakura derived from problem-runtime. AWS cloudformation is executable and stable; sakura apprun, azure bicep, and gcp infra-manager are reserved roadmap targets; docker compose is a local container runtime.",
  },
  {
    slug: "reference/cli",
    href: "/developers/docs/reference/cli/",
    title: "CLI reference",
    description: "Every tenkacloud pack command, parsed from the CLI usage strings.",
    maturity: "stable",
    section: "Reference",
    headings: [
      { id: "commands", text: "Commands" },
      { id: "exit-codes", text: "Exit codes" },
      { id: "example", text: "Example" },
    ],
    body: "CLI reference for the tenkacloud pack tool. Commands parsed from the CLI usage strings: validate, init, install, list, inspect, remove, activate, deactivate. Exit codes 0 success, 1 refusal, 2 tool failure. No update command; a new version is a separate install.",
  },
  {
    slug: "reference/validation-errors",
    href: "/developers/docs/reference/validation-errors/",
    title: "Validation error reference",
    description: "Every validator diagnostic code with a user-facing explanation.",
    maturity: "stable",
    section: "Reference",
    headings: [
      { id: "codes", text: "Codes" },
      { id: "reading-a-diagnostic", text: "Reading a diagnostic" },
    ],
    body: "Validation error reference. Every namespaced ValidationDiagnosticCode from the SDK with a user-facing explanation: PACK_DIR_MISSING, PACK_MANIFEST_MISSING, PACK_MANIFEST_UNREADABLE, PACK_MANIFEST_INVALID, PACK_PROBLEMS_ROOT_MISSING, PACK_PROBLEMS_ROOT_TRAVERSAL, PACK_DUPLICATE_PROBLEM_ID, PACK_ARTIFACT_TRAVERSAL, PACK_ARTIFACT_MISSING, PROBLEM_METADATA_INVALID, RUNTIME_MISMATCH.",
  },
  {
    slug: "reference/security-provenance",
    href: "/developers/docs/reference/security-provenance/",
    title: "Security and provenance model",
    description: "Inert manifests, content digests, and pinned Git provenance.",
    maturity: "stable",
    section: "Reference",
    headings: [
      { id: "guarantees", text: "Guarantees" },
      { id: "how-provenance-is-recorded", text: "How provenance is recorded" },
      { id: "what-a-pack-cannot-do", text: "What a pack cannot do" },
    ],
    body: "Security and provenance model. Inert manifests with no scripts or hooks, immutable content-addressed SHA-256 snapshots, pinned Git provenance recording the HTTPS repository URL and immutable 40-hex commit, and no remote or mutable sources. Install performs no runtime code execution.",
  },
  {
    slug: "tutorials/first-pack",
    href: "/developers/docs/tutorials/first-pack/",
    title: "First pack tutorial",
    description:
      "Create, validate, pin, install, activate, and pin to an event — one minimal pack end to end.",
    maturity: "stable",
    section: "Tutorials",
    headings: [
      { id: "scaffold", text: "Scaffold a pack" },
      { id: "validate", text: "Validate a pack" },
      { id: "pin", text: "Pin an immutable Git revision" },
      { id: "install", text: "Install a pack" },
      { id: "activate", text: "Activate for a tenant" },
      { id: "common-failures", text: "Common failures and diagnostic codes" },
      { id: "teardown", text: "Teardown and remove" },
    ],
    body: "First pack tutorial: from an empty directory, scaffold a problem pack with pack init, validate it offline with pack validate, pin an immutable full 40-hex Git commit revision, install it with pack install, activate it for a tenant with pack activate, create an event that pins the catalog snapshot, verify it in the organizer console, and tear it down with pack deactivate and pack remove. Uses one minimal pack com.example.starter with the hello-world problem. Common validator failures map to exact diagnostic codes such as PACK_DIR_MISSING, MANIFEST_MISSING, MANIFEST_INVALID, DUPLICATE_PROBLEM_ID, ARTIFACT_MISSING, and RUNTIME_MISMATCH. Every command runs fully offline with no cloud credentials until the final platform deploy step. 最初のパックのチュートリアル。空のディレクトリからパックを作成 (pack init)、検証 (pack validate)、不変な Git リビジョンに固定して公開、インストール (pack install)、テナントへ有効化 (pack activate)、イベント作成でカタログスナップショットに固定、オーガナイザーコンソールで検証、撤去 (pack deactivate / pack remove) までを通して解説します。よくある失敗と診断コードの対応表を含みます。",
  },
];

export const DOC_SECTIONS: readonly DocSection[] = buildSections(DOC_PAGES);

function buildSections(pages: readonly DocPage[]): readonly DocSection[] {
  const order: string[] = [];
  const grouped = new Map<string, DocPage[]>();
  for (const page of pages) {
    if (!grouped.has(page.section)) {
      grouped.set(page.section, []);
      order.push(page.section);
    }
    grouped.get(page.section)?.push(page);
  }
  return order.map((title) => ({
    title,
    pages: grouped.get(title) ?? [],
  }));
}

export function findDocBySlug(slug: string): DocPage | undefined {
  return DOC_PAGES.find((page) => page.slug === slug);
}
