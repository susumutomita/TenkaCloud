import type { Maturity } from "@/lib/maturity";

// This typed registry feeds the docs sidebar, search, and route validation. Until
// the Fumadocs swap (tracked as a follow-up), it is
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
    description:
      "Local drills and Lite setup, plus a clearly marked unverified SaaS architecture path.",
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
    body: "Getting started with local container drills through make local, zero-install GitHub Codespaces, and the currently recommended Lite deployment pipeline: a CloudFormation launcher creates CodeBuild, which runs make deploy and exposes the Admin Console and Participant Portal. The DynamoDB versus Turso control-data backend switch uses CDK_PARAM_CONTROL_DATA_BACKEND. SaaS code and architecture exist, but no recent fresh-environment end-to-end verification is recorded, so SaaS is not presented as a current self-service procedure. はじめに。ローカルドリル、Codespaces、Lite導入パイプライン、Participant Portal、DynamoDBとTursoの切り替え。SaaSは最近の一連の実環境確認がないため、現在の導入手順としては案内しない。",
  },
  {
    slug: "manual",
    href: "/developers/docs/manual/",
    title: "Manuals by role",
    description:
      "Choose the developer, competition organizer, participant, or problem-author path.",
    maturity: "stable",
    section: "Role manuals",
    headings: [
      { id: "choose-your-role", text: "Choose your role" },
      { id: "how-the-roles-fit-together", text: "How the roles fit together" },
      { id: "if-you-are-unsure", text: "If you are unsure" },
    ],
    body: "Choose a TenkaCloud manual by the job you are doing today: developer, competition organizer, competition participant, or problem author. Each role starts with one concrete outcome and links to technical detail only when it becomes necessary. 役割別マニュアルの入口。開発者、競技開催者、競技参加者、問題作成者から選び、必要な情報だけを読む。",
  },
  {
    slug: "manual/developer",
    href: "/developers/docs/manual/developer/",
    title: "Developer manual",
    description: "Repository setup, code ownership, checks, and configuration boundaries.",
    maturity: "stable",
    section: "Role manuals",
    headings: [
      { id: "prepare-the-repository", text: "Prepare the repository" },
      { id: "find-the-owner-before-editing", text: "Find the owner before editing" },
      { id: "change-workflow", text: "Change workflow" },
      { id: "code-change-or-environment-setting", text: "Code change or environment setting" },
    ],
    body: "Developer manual for changing TenkaCloud platform code in apps, infrastructure, packages, and scripts. Repository setup, make doctor, make harness, make before-commit, architecture ownership, environment parameter boundaries, and honest verification. 開発者マニュアル。コード変更、担当module、検査、環境設定との境界。",
  },
  {
    slug: "manual/organizer",
    href: "/developers/docs/manual/organizer/",
    title: "Competition organizer manual",
    description:
      "Run an event, choose Lite or SaaS, and configure databases and deploy parameters safely.",
    maturity: "preview",
    section: "Role manuals",
    headings: [
      { id: "choose-lite-or-saas-by-use-case", text: "Choose Lite or SaaS by use case" },
      { id: "the-lite-deployment-pipeline", text: "The Lite deployment pipeline" },
      { id: "the-lite-event-flow", text: "The Lite event flow" },
      { id: "choose-where-control-data-is-stored", text: "Choose where control data is stored" },
      { id: "change-settings", text: "Change settings" },
      { id: "before-participants-arrive", text: "Before participants arrive" },
      { id: "saas-operating-status", text: "SaaS operating status" },
    ],
    body: "Competition organizer manual with an executable Lite procedure and a separate SaaS status section. Choose by use case; deploy Lite through the CloudFormation plus CodeBuild launcher or make deploy; rehearse start, scoring, reset, stop, and teardown. The linked Lite setting and message references define database parameters, format, range, default, invalid-input behavior, displayed text, cause, system action, and operator action. Control data can use DynamoDB or an explicitly unverified Turso path. SaaS code exists but has no recent recorded fresh-environment end-to-end verification and is not presented as a current organizer procedure. 競技開催者マニュアル。Liteの実行手順とSaaSの未検証状態を分離し、用途比較、導入パイプライン、データベース、パラメータ、設定値、エラー文言、採点と料金の警告条件を説明する。",
  },
  {
    slug: "manual/participant",
    href: "/developers/docs/manual/participant/",
    title: "Competition participant manual",
    description:
      "Start a real problem environment, investigate it, submit a flag, reset, and stop.",
    maturity: "stable",
    section: "Role manuals",
    headings: [
      { id: "your-goal", text: "Your goal" },
      { id: "solve-a-problem-in-five-steps", text: "Solve a problem in five steps" },
      { id: "practice-without-a-cloud-account", text: "Practice without a cloud account" },
      { id: "words-you-will-see", text: "Words you will see" },
      { id: "when-something-goes-wrong", text: "When something goes wrong" },
    ],
    body: "Competition participant manual for the real TenkaCloud flow: choose a problem, read the goal and first action, start an isolated environment, open its endpoint, investigate or repair it, submit the full TC flag, reset, and stop. Local practice uses the public make local and make local-down commands. Plain-language glossary for server, cloud, Docker, problem environment, endpoint, flag, hint, and reset. 競技参加者マニュアル。実問題の開始、接続、調査、flag提出、採点、リセット、停止、make localとmake local-down、サーバー・クラウド・Dockerのやさしい説明。",
  },
  {
    slug: "manual/problem-author",
    href: "/developers/docs/manual/problem-author/",
    title: "Problem author manual",
    description:
      "Write participant-friendly scenarios, runtime environments, metadata, scoring, and hints.",
    maturity: "stable",
    section: "Role manuals",
    headings: [
      { id: "create-and-validate-a-pack", text: "Create and validate a pack" },
      { id: "author-the-participant-experience", text: "Author the participant experience" },
      { id: "the-problem-contract", text: "The problem contract" },
      { id: "rehearse-the-real-interaction", text: "Rehearse the real interaction" },
      { id: "publish-safely", text: "Publish safely" },
    ],
    body: "Problem author manual with a visual publication decision flow: validate from a fresh checkout, rehearse start through flag submission when the local runtime is supported, record Not run when it is unsupported, and use an independent participant-role test before publication. Also covers participant-friendly scenarios, metadata.json, runtime entry, verifier, scoring, hints, reset, stop, immutable commit pins, and safe publishing. WordPress belongs only as an independent local problem, never onboarding content. 問題作成者マニュアル。fresh checkoutでの検証、対応runtimeの実演、未対応時のNot run、第三者の参加者役確認をフロー図で示す。",
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
    description:
      "The supported Lite launcher and the separate, currently unverified SaaS architecture.",
    maturity: "preview",
    section: "Operate",
    headings: [
      { id: "two-deploy-modes", text: "Two deploy modes" },
      { id: "how-a-new-tenant-is-provisioned", text: "How a new tenant is provisioned" },
      { id: "what-the-saas-pipeline-is-for", text: "What the SaaS pipeline is for" },
      { id: "how-a-problem-deploys", text: "How a problem deploys" },
    ],
    body: "Deploy modes and launch paths. The current Lite deployment pipeline is a CloudFormation launcher that creates CodeBuild and runs make deploy; despite its filename, it does not use AWS CodePipeline. A local checkout can run make deploy directly. SaaS code includes make deploy-saas, SBT tenant provisioning, and the tenkacloud-saas-pipeline CodePipeline for existing-tenant rollout, but this tenant rollout path has no recent recorded fresh-environment end-to-end verification and is architecture reference rather than current setup guidance. デプロイモードと起動経路。LiteはCloudFormationとCodeBuildの導入パイプライン。SaaSはコード構成の参考だが、最近の新規環境での一連の確認がなく現在の導入手順ではない。",
  },
  {
    slug: "operate/run-an-event",
    href: "/developers/docs/operate/run-an-event/",
    title: "Run an event end to end",
    description:
      "Run the current Lite event flow; SaaS tenant and multi-cloud sections are architecture reference.",
    maturity: "preview",
    section: "Operate",
    headings: [
      { id: "create-a-tenant", text: "Create a tenant" },
      { id: "connect-a-competitor-account", text: "Connect a competitor account" },
      { id: "deploy-a-problem", text: "Deploy a problem" },
      { id: "enable-multi-cloud", text: "Enable multi-cloud" },
    ],
    body: "Run an event end to end. For the current Lite path, sign in to the Application Admin Console, connect a test competitor account with competitor-bootstrap.yaml and the same 16-128 character ExternalId, create an event, start a problem, submit a real flag, reset, stop, and verify teardown. SaaS tenant creation and multi-cloud sections describe repository architecture only; they are not recently live-verified organizer procedures. イベント運営。現在のLite経路でテスト競技者アカウント接続、問題起動、flag提出、リセット、停止、削除まで確認する。SaaSテナントとマルチクラウドは構成参考であり最近のライブ検証済み手順ではない。",
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
    slug: "reference/onboarding-analytics",
    href: "/developers/docs/reference/onboarding-analytics/",
    title: "Onboarding A/B analytics",
    description: "GA4 event schema, A/B assignment, drop-off funnel setup, and privacy boundary.",
    maturity: "preview",
    section: "Reference",
    headings: [
      { id: "assignment", text: "Assignment" },
      { id: "events", text: "Events" },
      { id: "configure-ga4", text: "Configure GA4" },
      { id: "build-the-drop-off-funnel", text: "Build the drop-off funnel" },
      { id: "privacy-boundary", text: "Privacy boundary" },
    ],
    body: "Onboarding A/B analytics reference for the public browser demo. Defines the list and one-step variants, persistent 50/50 assignment, forced preview URLs, GA4 event names and parameters, custom dimensions, closed funnel steps, drop-off analysis, elapsed time, hint and wrong-submission guardrails, and the privacy boundary that excludes answers, flags, team keys, hint text, and production participant portals. オンボーディングA/BテストのGA4計測仕様、割り当て、離脱ファネル、プライバシー境界。",
  },
  {
    slug: "reference/lite-settings",
    href: "/developers/docs/reference/lite-settings/",
    title: "Lite setting reference",
    description:
      "Purpose, format, length or range, default, example, and invalid behavior for Lite settings.",
    maturity: "preview",
    section: "Reference",
    headings: [
      { id: "first-setup", text: "First setup" },
      { id: "control-data-storage", text: "Control-data storage" },
      { id: "dynamodb-and-logs", text: "DynamoDB and logs" },
      { id: "scoring-and-cost-warning-email", text: "Scoring and cost warning email" },
      {
        id: "problem-deployment-and-feature-switches",
        text: "Problem deployment and feature switches",
      },
    ],
    body: "Lite setting reference for every commonly changed value: purpose, accepted format, character or numeric range, default, example, and invalid-input behavior. ExternalId is empty only for a same-account trial or 16-128 ASCII letters, digits, and _ = , . @ : / -. Covers DynamoDB versus Turso, capacities, log retention, scoring and cost warning email, CIDRs, deployment switches, features, and audit records. Lite設定項目リファレンス。用途、形式、文字数・数値範囲、省略時、例、不正値の動作を定義する。",
  },
  {
    slug: "reference/lite-messages",
    href: "/developers/docs/reference/lite-messages/",
    title: "Lite settings message reference",
    description: "Exact displayed text with cause, system action, and operator action.",
    maturity: "preview",
    section: "Reference",
    headings: [
      { id: "before-deployment", text: "Before deployment" },
      { id: "database", text: "Database" },
      { id: "numbers-and-json", text: "Numbers and JSON" },
      { id: "network", text: "Network" },
      { id: "during-deployment", text: "During deployment" },
      { id: "settings-without-a-dedicated-error", text: "Settings without a dedicated error" },
    ],
    body: "Lite settings message reference. Each entry records the exact displayed text, cause, system action, and operator action. Includes env-init email, Region, and ExternalId errors; DynamoDB or Turso selection errors; number, JSON, CIDR, CloudFormation, and Cognito failures; and an explicit list of settings that have no dedicated validation message. Lite設定メッセージ一覧。文言、要因、システムの動作、運営者の処置と、専用エラーがない設定を明記する。",
  },
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
  const order: string[] = ["Role manuals", "Start here"];
  const grouped = new Map<string, DocPage[]>();
  for (const page of pages) {
    if (!grouped.has(page.section)) {
      grouped.set(page.section, []);
      if (!order.includes(page.section)) order.push(page.section);
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
