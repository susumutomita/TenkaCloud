/**
 * [Issue #1411] gcp/infra-manager runtime adapter (Infrastructure Manager).
 *
 * GCP problem は Infrastructure Manager (= GCP が state/lock を所有する managed Terraform) で
 * deployment を作る。GCP が state / lock を所有し、platform は backend を持たない。
 * `runtime.entry` が Terraform config 参照 (repository-relative path)、 problem パラメータは TF input
 * vars、 deployment outputs を deploy output に読む。Deployment Manager は 2026-03 EOL なので不採用。
 *
 * 認証は **Workload Identity Federation** trust-bridge の `gcp-workload-identity` adapter が
 * 短命 access token を発行する (service-account key 不要)。 本 adapter はその token を受け取る resolver を
 * 注入される (= account-gated な WIF exchange は handler 側)。
 *
 * [Issue #2745] `runtime.entry` はそのままでは Infra Manager が読める `gs://` object ではない (repository
 * 相対 path)。 `deploy()` は client を呼ぶ前に注入された `materializeBlueprint` を呼び、 実 Terraform source
 * (materialized tree / private payload zip) を immutable GCS object へ zip 化 upload した結果の
 * `gs://bucket/object#generation` を `blueprintRef` に使う (= `assertGcsBlueprintRef` の fail-closed guard
 * を満たす)。 具体実装は `runtime-clients/gcp-blueprint-materializer.ts`。
 *
 * orchestration は注入された `GcpInfraManagerClient` / `getCredential` / `materializeBlueprint` に対して書き
 * unit test で pin する。 具体 Infra Manager REST 実装 + WIF exchange 実装は実 account で検証する別レイヤ
 * (#1419 / Sakura / Azure と同方針)。
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

/** WIF 交換で得た短命 access token (trust-bridge gcp-workload-identity 由来)。 */
export interface GcpCredential {
  readonly accessToken: string;
}

/**
 * Infra Manager deployment の仕様。 blueprintRef = materialized `gs://` object (#2745、 旧
 * runtime.entry 直渡しは fail-closed guard に必ず reject される)、 inputs = problem パラメータ。
 */
export interface GcpDeploymentSpec {
  readonly name: string;
  readonly blueprintRef: string;
  readonly inputs: Readonly<Record<string, string>>;
}

/** [Issue #2745] `materializeBlueprint` に渡す、 Terraform source 解決に要る最小 input。 */
export interface MaterializeGcpBlueprintInput {
  readonly tenantId: string;
  readonly teamSlug: string;
  readonly problemId: string;
  readonly problemDir: string;
  /** `runtime.entry` — problemDir からの相対 path (file または directory module)。 */
  readonly entry: string;
  /** private 問題の presigned payload.zip URL。 */
  readonly challengePayloadUrl?: string;
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
  /**
   * [Issue #2745] `runtime.entry` を実 Terraform source から materialize した `gs://bucket/object`
   * (+ `#generation`) に変換する。 同じ WIF token (`credential`) を GCS upload の Bearer auth にも
   * 再利用するため引数で受け取る (= 2 度目の WIF 交換をしない)。
   */
  readonly materializeBlueprint: (
    credential: GcpCredential,
    input: MaterializeGcpBlueprintInput,
  ) => Promise<string>;
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
    // [Issue #2745] getCredential() runs BEFORE client() so the SAME WIF token can be reused for
    // both the GCS blueprint upload (materializeBlueprint) and the Infra Manager REST calls — no
    // second WIF exchange per deploy.
    const credential = await this.ctx.getCredential();
    const blueprintRef = await this.ctx.materializeBlueprint(credential, {
      tenantId: input.tenantId,
      teamSlug: input.teamSlug,
      problemId: input.problemId,
      problemDir: input.problemDir,
      entry: this.runtime.entry,
      ...(input.challengePayloadUrl ? { challengePayloadUrl: input.challengePayloadUrl } : {}),
    });
    const client = this.ctx.client(credential);
    const platformInputs = {
      tenkacloud_name_prefix: input.namePrefix,
      tenkacloud_problem_id: input.problemId,
      tenkacloud_team: input.teamSlug,
      ...(input.challengePayloadUrl
        ? { tenkacloud_challenge_payload_url: input.challengePayloadUrl }
        : {}),
    };
    await client.upsertDeployment({
      name: input.namePrefix,
      blueprintRef, // #2745: materialized gs:// object, not the raw repository-relative entry
      inputs: mergeCompositeParameters(platformInputs, input.parameters),
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
