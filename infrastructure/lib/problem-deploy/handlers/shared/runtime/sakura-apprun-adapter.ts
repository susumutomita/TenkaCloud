/**
 * [Issues #1412, #2746] sakura/apprun runtime adapter.
 *
 * Sakura には CloudFormation 相当の state-owning IaC が無いので、 problem の container image を
 * **AppRun application** として deploy し、 AppRun (Knative on managed k8s) が runtime / scaling /
 * teardown を所有し、platform は state file / lock を持たない。image は
 * `runtime.entry`、 problem パラメータ + platform メタは env var で渡し、 public URL を deploy output に読む。
 *
 * 認証は **static API key (Access Token + Secret)** を SSM SecureString から都度取得する。
 * AWS の ExternalId と同型の保管で、long-lived なので scope 最小化 + per-team account 前提。Sakura は
 * federation primitive を持たないため Trust Bridge には乗らない。
 *
 * orchestration は注入された `SakuraAppRunClient` / `getApiKey` に対して書き、 unit test で全分岐を pin する。
 * 具体 HTTP 実装 (実 AppRun REST 呼び出し) と SSM key 取得は **実 account で検証する別レイヤ** (= deploy
 * handler が束縛する)。#1419 executor と同じく、logic を注入境界で組み実 I/O を別層で配線する。
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

/** Sakura API の静的キー (Access Token + Secret)。 SSM SecureString から取得。 */
export interface SakuraCredential {
  readonly accessToken: string;
  readonly accessTokenSecret: string;
}

/** AppRun application の deploy 仕様。 image = runtime.entry、 env = problem パラメータ + platform メタ。 */
export interface SakuraAppRunSpec {
  readonly name: string;
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
}

/** AppRun application の観測状態。 publicUrl は ready 後に埋まる。 */
export interface SakuraApplicationState {
  readonly status: string;
  readonly publicUrl?: string;
}

/**
 * Sakura AppRun API の最小 client 契約 (= account-gated な HTTP 実装を注入する seam)。 adapter の
 * orchestration はこの interface に対して書かれ、 具体実装 (Access Token + Secret 認証の REST 呼び出し)
 * は実 account で検証する別レイヤ。 handler が `handler must not call fetch` 規約に従い service 層で実装する。
 */
export interface SakuraAppRunClient {
  /** name の application を作成 or 更新 (= 冪等な deploy)。 */
  upsertApplication(spec: SakuraAppRunSpec): Promise<void>;
  /** name の application 状態を取得。 不在は undefined。 */
  getApplication(name: string): Promise<SakuraApplicationState | undefined>;
  /** name の application を削除 (= teardown、 AppRun が lifecycle を所有)。 */
  deleteApplication(name: string): Promise<void>;
}

export interface SakuraAppRunAdapterContext {
  /** team の scoped API key を SSM SecureString から解決 (deploy handler が束縛、 account-gated)。 */
  readonly getApiKey: () => Promise<SakuraCredential>;
  /** credential を受けて AppRun client を返す factory (= 具体 HTTP 実装の注入点)。 */
  readonly client: (credential: SakuraCredential) => SakuraAppRunClient;
}

export const SAKURA_PROVIDER = "sakura";
export const SAKURA_ENGINE = "apprun";

/**
 * AppRun の current status (`Healthy` / `Deploying` / `UnHealthy`) と互換 alias を platform の
 * 6-state に射影する。 不在 (= 未作成 / 削除済) は `destroyed`、 稼働は `ready`、 failure は `failed`、
 * それ以外 (provisioning / pending / 未知) は安全側で `deploying` (= ready と誤判定して採点を始めない)。
 */
export function mapSakuraStatus(raw: string | undefined): RuntimeStatus {
  if (raw === undefined) return "destroyed";
  const s = raw.toLowerCase();
  if (["healthy", "running", "ready", "active", "succeeded", "available"].includes(s)) {
    return "ready";
  }
  if (["unhealthy", "failed", "error", "crashed", "failure"].includes(s)) return "failed";
  if (["deleting", "terminating"].includes(s)) return "destroying";
  if (["deleted", "gone", "notfound"].includes(s)) return "destroyed";
  return "deploying";
}

export class SakuraAppRunRuntimeAdapter implements ProblemRuntimeAdapter {
  public readonly provider = SAKURA_PROVIDER;
  public readonly engine = SAKURA_ENGINE;

  constructor(
    private readonly ctx: SakuraAppRunAdapterContext,
    private readonly runtime: ProblemRuntime,
  ) {}

  private async resolveClient(): Promise<SakuraAppRunClient> {
    return this.ctx.client(await this.ctx.getApiKey());
  }

  async deploy(input: RuntimeDeployInput): Promise<RuntimeDeployResult> {
    const client = await this.resolveClient();
    const platformEnv = {
      TENKACLOUD_NAME_PREFIX: input.namePrefix,
      TENKACLOUD_PROBLEM_ID: input.problemId,
      TENKACLOUD_TEAM: input.teamSlug,
      ...(input.challengePayloadUrl
        ? { TENKACLOUD_CHALLENGE_PAYLOAD_URL: input.challengePayloadUrl }
        : {}),
    };
    await client.upsertApplication({
      name: input.namePrefix,
      image: this.runtime.entry, // runtime.entry is the immutable container image reference.
      env: mergeCompositeParameters(platformEnv, input.parameters),
    });
    return { status: "deploying" };
  }

  async collectOutputs(input: RuntimeCollectOutputsInput): Promise<RuntimeOutputs> {
    const client = await this.resolveClient();
    const app = await client.getApplication(input.namePrefix);
    // public URL が読めたら BaseUrl として返す (= endpoints[].default の cfn-output と同位置付け)。
    return app?.publicUrl ? { BaseUrl: app.publicUrl } : {};
  }

  async getStatus(input: RuntimeStatusInput): Promise<RuntimeStatus> {
    const client = await this.resolveClient();
    const app = await client.getApplication(input.namePrefix);
    return mapSakuraStatus(app?.status);
  }

  async destroy(input: RuntimeDestroyInput): Promise<RuntimeDestroyResult> {
    const client = await this.resolveClient();
    await client.deleteApplication(input.namePrefix);
    return { status: "destroying" };
  }
}
