/**
 * [ADR-026 / Issues #1412, #2746] sakura/apprun runtime adapter.
 *
 * Sakura には CloudFormation 相当の state-owning IaC が無いので、problem の container image を
 * AppRun application として deploy し、AppRun が runtime / scaling / teardown を所有する。
 * image は `runtime.entry`、problem parameter + platform metadata は env var で渡し、public URL を
 * deploy output に読む。
 *
 * 認証は static API key (Access Token + Secret) を SSM SecureString から都度取得する。Sakura は
 * federation primitive を持たないため Trust Bridge には乗らない。orchestration は注入された
 * `SakuraAppRunClient` / `getApiKey` に対して書き、具体 HTTP 実装は service 層へ閉じ込める。
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

/** Sakura API の静的キー (Access Token + Secret)。SSM SecureString から取得する。 */
export interface SakuraCredential {
  readonly accessToken: string;
  readonly accessTokenSecret: string;
}

/** AppRun application の deploy 仕様。image = runtime.entry。 */
export interface SakuraAppRunSpec {
  readonly name: string;
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
}

/** AppRun application の観測状態。publicUrl は作成後に埋まる。 */
export interface SakuraApplicationState {
  readonly status: string;
  readonly publicUrl?: string;
}

export interface SakuraAppRunClient {
  /** name の application を作成または更新する。 */
  upsertApplication(spec: SakuraAppRunSpec): Promise<void>;
  /** name の application 状態を取得する。不在は undefined。 */
  getApplication(name: string): Promise<SakuraApplicationState | undefined>;
  /** name の application を冪等に削除する。 */
  deleteApplication(name: string): Promise<void>;
}

export interface SakuraAppRunAdapterContext {
  readonly getApiKey: () => Promise<SakuraCredential>;
  readonly client: (credential: SakuraCredential) => SakuraAppRunClient;
}

export const SAKURA_PROVIDER = "sakura";
export const SAKURA_ENGINE = "apprun";

/**
 * Current AppRun API states are Healthy / Deploying / UnHealthy. Historical aliases remain
 * accepted for rows or fakes created before #2746. Unknown states fail closed as deploying so
 * scoring never starts from an unrecognized provider state.
 */
export function mapSakuraStatus(raw: string | undefined): RuntimeStatus {
  if (raw === undefined) return "destroyed";
  const status = raw.toLowerCase();
  if (["healthy", "running", "ready", "active", "succeeded", "available"].includes(status)) {
    return "ready";
  }
  if (["unhealthy", "failed", "error", "crashed", "failure"].includes(status)) {
    return "failed";
  }
  if (["deleting", "terminating"].includes(status)) return "destroying";
  if (["deleted", "gone", "notfound"].includes(status)) return "destroyed";
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
    await client.upsertApplication({
      name: input.namePrefix,
      image: this.runtime.entry,
      env: {
        TENKACLOUD_NAME_PREFIX: input.namePrefix,
        TENKACLOUD_PROBLEM_ID: input.problemId,
        TENKACLOUD_TEAM: input.teamSlug,
        ...(input.challengePayloadUrl
          ? { TENKACLOUD_CHALLENGE_PAYLOAD_URL: input.challengePayloadUrl }
          : {}),
      },
    });
    return { status: "deploying" };
  }

  async collectOutputs(input: RuntimeCollectOutputsInput): Promise<RuntimeOutputs> {
    const client = await this.resolveClient();
    const application = await client.getApplication(input.namePrefix);
    return application?.publicUrl ? { BaseUrl: application.publicUrl } : {};
  }

  async getStatus(input: RuntimeStatusInput): Promise<RuntimeStatus> {
    const client = await this.resolveClient();
    const application = await client.getApplication(input.namePrefix);
    return mapSakuraStatus(application?.status);
  }

  async destroy(input: RuntimeDestroyInput): Promise<RuntimeDestroyResult> {
    const client = await this.resolveClient();
    await client.deleteApplication(input.namePrefix);
    return { status: "destroying" };
  }
}
