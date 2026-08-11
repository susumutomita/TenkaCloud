/**
 * [Issue #1410 #2743] azure/bicep runtime adapter (Deployment Stacks).
 *
 * Azure problem は Bicep テンプレートを **Deployment Stack** として展開する。 Deployment Stack は
 * CFn 相当で、配下リソースの lifecycle / teardown を Azure 側が所有する。platform は state file /
 * lock を持たない。`runtime.entry` が Bicep/precompiled-ARM-JSON 参照、
 * problem パラメータは stack parameters、 stack outputs を deploy output に読む。
 *
 * 認証は **Workload Identity Federation** trust-bridge の `azure-federated-credential`
 * adapter が短命 OAuth token を発行する (stored key 不要、 AWS AssumeRole 並みの isolation)。 本 adapter は
 * その token を受け取る credential resolver を注入される (= account-gated な exchange は handler 側)。
 *
 * [Issue #2743] `runtime.entry` は fail-open で ARM `templateLink.uri` へ直行しない — `deploy()` は
 * `ctx.materialize` (= `azure-template-materializer.ts` の `materializeAzureTemplate`) を必ず
 * `client.upsertStack` の前に await し、 inline ARM JSON を得てから spec を組む。 materialize が失敗すれば
 * ARM 呼び出しは一切走らない (fail closed)。 materialize 結果の `sourceSha256` は deploy trace に記録する
 * (non-secret な provenance)。
 *
 * orchestration は注入された `AzureDeploymentStackClient` / `getCredential` / `materialize` に対して
 * 書き unit test で pin する。 具体 ARM REST 実装 + WIF exchange は実 account で検証する別レイヤ
 * (#1419 / Sakura と同方針)。
 */

import type { InlineArmTemplate } from "../../../runtime-clients/azure-template-materializer.js";
import { logDeployTrace } from "../trace-log.js";
import {
  mergeCompositeParameters,
  type ProblemRuntime,
  type ProblemRuntimeAdapter,
  type RuntimeCollectOutputsInput,
  type RuntimeDeployInput,
  type RuntimeDeployResult,
  type RuntimeDestroyInput,
  type RuntimeDestroyResult,
  type RuntimeOutputs,
  type RuntimeStatus,
  type RuntimeStatusInput,
} from "./adapter.js";

/** WIF 交換で得た短命 OAuth token (trust-bridge azure-federated-credential 由来)。 */
export interface AzureCredential {
  readonly accessToken: string;
}

/**
 * [Issue #2743] Deployment Stack の ARM template 供給元。 型レベルで曖昧さを消す — 「repo-relative な
 * Bicep パス」と「到達可能な ARM JSON URL」を同じ `string` で表さない。 `AzureBicepRuntimeAdapter` は
 * 常に `materialize()` の結果を `inline` として送る。 `remote` は REST client 側の完全性 (+将来の
 * 非マテリアライズ経路) のために存在し、 今日のプラットフォームでは発行しない。
 */
export type AzureArmTemplateSource =
  | { readonly kind: "inline"; readonly document: Readonly<Record<string, unknown>> }
  | { readonly kind: "remote"; readonly uri: string };

/** Deployment Stack の展開仕様。 template = 材料化済み ARM template、 parameters = problem パラメータ。 */
export interface AzureDeploymentStackSpec {
  readonly name: string;
  readonly template: AzureArmTemplateSource;
  readonly parameters: Readonly<Record<string, string>>;
}

/** `runtime.entry` を materialize する場所の情報 (= 1 deployment 分、 adapter.deploy() が組む)。 */
export interface AzureArtifactLocation {
  readonly problemDir: string;
  readonly challengePayloadUrl?: string;
}

/** Deployment Stack の観測状態。 provisioningState は ARM 由来、 outputs は ready 後に埋まる。 */
export interface AzureDeploymentStackState {
  readonly provisioningState: string;
  readonly outputs?: Readonly<Record<string, string>>;
}

/** Azure Deployment Stack API の最小 client 契約 (= account-gated ARM REST 実装の注入点)。 */
export interface AzureDeploymentStackClient {
  upsertStack(spec: AzureDeploymentStackSpec): Promise<void>;
  getStack(name: string): Promise<AzureDeploymentStackState | undefined>;
  deleteStack(name: string): Promise<void>;
}

export interface AzureBicepAdapterContext {
  /** WIF 短命 token を解決 (trust-bridge 経由、 handler が束縛、 account-gated)。 */
  readonly getCredential: () => Promise<AzureCredential>;
  readonly client: (credential: AzureCredential) => AzureDeploymentStackClient;
  /**
   * [Issue #2743] `runtime.entry` を inline ARM template に materialize する。 `deploy()` は必ず
   * `client.upsertStack` の前にこれを await する — materialize が失敗すれば ARM 呼び出しは一切走らない。
   */
  readonly materialize: (
    entry: string,
    location: AzureArtifactLocation,
  ) => Promise<InlineArmTemplate>;
}

export const AZURE_PROVIDER = "azure";
export const AZURE_ENGINE = "bicep";

/** ARM provisioningState を platform の 6-state に射影。 不在=destroyed、 未知/進行中は安全側 deploying。 */
export function mapAzureProvisioningState(raw: string | undefined): RuntimeStatus {
  if (raw === undefined) return "destroyed";
  const s = raw.toLowerCase();
  if (s === "succeeded") return "ready";
  if (["failed", "canceled", "cancelled"].includes(s)) return "failed";
  if (["deleting"].includes(s)) return "destroying";
  if (["deleted"].includes(s)) return "destroyed";
  return "deploying";
}

export class AzureBicepRuntimeAdapter implements ProblemRuntimeAdapter {
  public readonly provider = AZURE_PROVIDER;
  public readonly engine = AZURE_ENGINE;

  constructor(
    private readonly ctx: AzureBicepAdapterContext,
    private readonly runtime: ProblemRuntime,
  ) {}

  private async resolveClient(): Promise<AzureDeploymentStackClient> {
    return this.ctx.client(await this.ctx.getCredential());
  }

  async deploy(input: RuntimeDeployInput): Promise<RuntimeDeployResult> {
    // [Issue #2743] Materialize BEFORE any Azure call (including the WIF token exchange) — a
    // failed materialization (missing artifact source, absent Bicep compiler, malformed ARM JSON,
    // path traversal) never reaches `getCredential`/`upsertStack`, so no credential is minted and
    // no Deployment Stack is ever created/updated from an un-inlined template.
    const template = await this.ctx.materialize(this.runtime.entry, {
      problemDir: input.problemDir,
      ...(input.challengePayloadUrl ? { challengePayloadUrl: input.challengePayloadUrl } : {}),
    });
    const client = await this.resolveClient();
    logDeployTrace("deploy.azure-bicep.materialize", {
      jobId: input.jobId,
      correlationId: input.correlationId,
      tenantId: input.tenantId,
      problemId: input.problemId,
      entry: this.runtime.entry,
      // Non-secret content-addressed provenance of exactly what was inlined.
      sourceSha256: template.sourceSha256,
      ...(template.diagnostics.length > 0 ? { diagnostics: template.diagnostics } : {}),
    });
    const platformParameters = {
      tenkacloudNamePrefix: input.namePrefix,
      tenkacloudProblemId: input.problemId,
      tenkacloudTeam: input.teamSlug,
      ...(input.challengePayloadUrl
        ? { tenkacloudChallengePayloadUrl: input.challengePayloadUrl }
        : {}),
    };
    await client.upsertStack({
      name: input.namePrefix,
      template: { kind: "inline", document: template.document },
      parameters: mergeCompositeParameters(platformParameters, input.parameters),
    });
    return { status: "deploying" };
  }

  async collectOutputs(input: RuntimeCollectOutputsInput): Promise<RuntimeOutputs> {
    const client = await this.resolveClient();
    const stack = await client.getStack(input.namePrefix);
    return stack?.outputs ?? {};
  }

  async getStatus(input: RuntimeStatusInput): Promise<RuntimeStatus> {
    const client = await this.resolveClient();
    const stack = await client.getStack(input.namePrefix);
    return mapAzureProvisioningState(stack?.provisioningState);
  }

  async destroy(input: RuntimeDestroyInput): Promise<RuntimeDestroyResult> {
    const client = await this.resolveClient();
    await client.deleteStack(input.namePrefix);
    return { status: "destroying" };
  }
}
