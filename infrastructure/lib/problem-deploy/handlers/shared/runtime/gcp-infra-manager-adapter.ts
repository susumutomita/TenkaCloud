/**
 * [ADR-027 / Issue #1411] gcp/infra-manager runtime adapter (Infrastructure Manager).
 *
 * GCP problem は Infrastructure Manager (= GCP が state/lock を所有する managed Terraform) で
 * deployment を作る。 GCP が state を持つので ADR-023 D3/D5 を満たす (platform は backend を持たない)。
 * `runtime.entry` が Terraform config 参照 (blueprint/gcs path)、 problem パラメータは TF input vars、
 * deployment outputs を deploy output に読む。 Deployment Manager は 2026-03 EOL なので不採用 (ADR-027)。
 *
 * 認証は **Workload Identity Federation** (ADR-027): trust-bridge の `gcp-workload-identity` adapter が
 * 短命 access token を発行する (service-account key 不要)。 本 adapter はその token を受け取る resolver を
 * 注入される (= account-gated な WIF exchange は handler 側)。
 *
 * orchestration は注入された `GcpInfraManagerClient` / `getCredential` に対して書き unit test で pin する。
 * 具体 Infra Manager REST 実装 + WIF exchange は実 account で検証する別レイヤ (#1419 / Sakura / Azure と同方針)。
 */

import type {
  ProblemRuntime,
  ProblemRuntimeAdapter,
  RuntimeCollectOutputsInput,
  RuntimeDeployInput,
  RuntimeDeployResult,
  RuntimeDestroyInput,
  RuntimeDestroyResult,
  RuntimeOutputs,
  RuntimeStatus,
  RuntimeStatusInput,
} from "./adapter.js";

/** WIF 交換で得た短命 access token (trust-bridge gcp-workload-identity 由来)。 */
export interface GcpCredential {
  readonly accessToken: string;
}

/** Infra Manager deployment の仕様。 blueprintRef = runtime.entry (TF config)、 inputs = problem パラメータ。 */
export interface GcpDeploymentSpec {
  readonly name: string;
  readonly blueprintRef: string;
  readonly inputs: Readonly<Record<string, string>>;
}

/** Infra Manager deployment の観測状態。 state は GCP 由来、 outputs は ACTIVE 後に埋まる。 */
export interface GcpDeploymentState {
  readonly state: string;
  readonly outputs?: Readonly<Record<string, string>>;
}

/** GCP Infrastructure Manager API の最小 client 契約 (= account-gated REST 実装の注入点)。 */
export interface GcpInfraManagerClient {
  upsertDeployment(spec: GcpDeploymentSpec): Promise<void>;
  getDeployment(name: string): Promise<GcpDeploymentState | undefined>;
  deleteDeployment(name: string): Promise<void>;
}

export interface GcpInfraManagerAdapterContext {
  /** WIF 短命 token を解決 (trust-bridge 経由、 handler が束縛、 account-gated)。 */
  readonly getCredential: () => Promise<GcpCredential>;
  readonly client: (credential: GcpCredential) => GcpInfraManagerClient;
}

export const GCP_PROVIDER = "gcp";
export const GCP_ENGINE = "infra-manager";

/** Infra Manager deployment state を platform の 6-state に射影。 不在=destroyed、 未知/進行中は安全側 deploying。 */
export function mapGcpDeploymentState(raw: string | undefined): RuntimeStatus {
  if (raw === undefined) return "destroyed";
  const s = raw.toLowerCase();
  if (["active", "succeeded"].includes(s)) return "ready";
  if (["failed", "error"].includes(s)) return "failed";
  if (["deleting"].includes(s)) return "destroying";
  if (["deleted"].includes(s)) return "destroyed";
  // creating / updating / applying / pending / unknown → 安全側 (ready と誤判定しない)
  return "deploying";
}

export class GcpInfraManagerRuntimeAdapter implements ProblemRuntimeAdapter {
  public readonly provider = GCP_PROVIDER;
  public readonly engine = GCP_ENGINE;

  constructor(
    private readonly ctx: GcpInfraManagerAdapterContext,
    private readonly runtime: ProblemRuntime,
  ) {}

  private async resolveClient(): Promise<GcpInfraManagerClient> {
    return this.ctx.client(await this.ctx.getCredential());
  }

  async deploy(input: RuntimeDeployInput): Promise<RuntimeDeployResult> {
    const client = await this.resolveClient();
    await client.upsertDeployment({
      name: input.namePrefix,
      blueprintRef: this.runtime.entry, // ADR-027: runtime.entry = Terraform config reference
      inputs: {
        tenkacloud_name_prefix: input.namePrefix,
        tenkacloud_problem_id: input.problemId,
        tenkacloud_team: input.teamSlug,
        ...(input.challengePayloadUrl
          ? { tenkacloud_challenge_payload_url: input.challengePayloadUrl }
          : {}),
      },
    });
    return { status: "deploying" };
  }

  async collectOutputs(input: RuntimeCollectOutputsInput): Promise<RuntimeOutputs> {
    const client = await this.resolveClient();
    const deployment = await client.getDeployment(input.namePrefix);
    return deployment?.outputs ?? {};
  }

  async getStatus(input: RuntimeStatusInput): Promise<RuntimeStatus> {
    const client = await this.resolveClient();
    const deployment = await client.getDeployment(input.namePrefix);
    return mapGcpDeploymentState(deployment?.state);
  }

  async destroy(input: RuntimeDestroyInput): Promise<RuntimeDestroyResult> {
    const client = await this.resolveClient();
    await client.deleteDeployment(input.namePrefix);
    return { status: "destroying" };
  }
}
