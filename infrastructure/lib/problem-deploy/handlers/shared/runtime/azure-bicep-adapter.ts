/**
 * [ADR-027 / Issue #1410] azure/bicep runtime adapter (Deployment Stacks).
 *
 * Azure problem は Bicep テンプレートを **Deployment Stack** として展開する。 Deployment Stack は
 * CFn 相当で、 配下リソースの lifecycle / teardown を Azure 側が所有する (= ADR-023 D3 を満たす。
 * platform は state file / lock を持たない)。 `runtime.entry` が Bicep テンプレート参照、 problem
 * パラメータは stack parameters、 stack outputs を deploy output に読む。
 *
 * 認証は **Workload Identity Federation** (ADR-027): trust-bridge の `azure-federated-credential`
 * adapter が短命 OAuth token を発行する (stored key 不要、 AWS AssumeRole 並みの isolation)。 本 adapter は
 * その token を受け取る credential resolver を注入される (= account-gated な exchange は handler 側)。
 *
 * orchestration は注入された `AzureDeploymentStackClient` / `getCredential` に対して書き unit test で pin
 * する。 具体 ARM REST 実装 + WIF exchange は実 account で検証する別レイヤ (#1419 / Sakura と同方針)。
 */

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

/** Deployment Stack の展開仕様。 templateRef = runtime.entry (Bicep)、 parameters = problem パラメータ。 */
export interface AzureDeploymentStackSpec {
  readonly name: string;
  readonly templateRef: string;
  readonly parameters: Readonly<Record<string, string>>;
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
    const client = await this.resolveClient();
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
      templateRef: this.runtime.entry, // ADR-027: runtime.entry = Bicep template reference
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
