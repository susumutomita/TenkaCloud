/**
 * Issue #2951: machine API の client と、platform が返すエラーの人間向け翻訳。
 *
 * `forbidden_machine_route` は「この credential では届かない」という **設計上の答え** であって
 * 一時的な障害ではない。素の JSON をそのまま出すと、利用者は capability 不足なのか route が
 * そもそも machine に開いていないのかを判別できない。ここで言葉にする。
 */

export type ApiFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** platform の error code を、次に何をすればよいかまで書いた文へ翻訳する。 */
export function explainApiError(status: number, code: string | undefined): string {
  if (code === "forbidden_machine_route") {
    return (
      "この machine credential ではこの操作に到達できません (forbidden_machine_route)。\n" +
      "  - route が machine の allowlist に無い場合、credential を作り直しても到達できません。" +
      "その操作は人間の運営者が行う設計です。\n" +
      "  - capability が足りないだけなら、`--preset deploy` で発行し直した credential で通ります " +
      "(read preset は deploy を実行できません)。"
    );
  }
  if (code === "forbidden_role") {
    return (
      "role がこの操作を許可していません (forbidden_role)。machine credential の role は " +
      "TenantMachine で、破壊的な操作の allowlist には含まれません。"
    );
  }
  if (code === "missing_tenant_claim") {
    return "token から tenant を解決できませんでした。binding scope (tc-tenant-<tenantId>/bind) を確認してください。";
  }
  if (code === "deploy_quota_exceeded") {
    return "同時デプロイ数の上限に達しています。不要な deployment を撤去してから再実行してください。";
  }
  if (status === 401) {
    return (
      "認証に失敗しました (401)。token が期限切れか、必要な scope を持っていません。" +
      "gateway は scope を method 単位で強制するので、read token で deploy を呼ぶとここに来ます。"
    );
  }
  if (status === 404) return "対象が見つかりません (404)。";
  return `API が ${status} を返しました${code ? ` (${code})` : ""}。`;
}

export interface MachineApiClientOptions {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly fetchImpl: ApiFetch;
}

export interface DeploymentSummary {
  readonly jobId: string;
  readonly status: string;
  readonly [key: string]: unknown;
}

/**
 * base URL の末尾 `/` を落として path を繋ぐ。
 *
 * 正規表現 (`/\/+$/`) を使わないのは、baseUrl が設定ファイルや環境変数から来る外部入力で、
 * `/` が大量に並ぶ入力に対して backtracking で時間を食う形になるためである (CodeQL の
 * polynomial-redos)。線形の走査で同じ結果を出す。
 */
function joinUrl(baseUrl: string, path: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charAt(end - 1) === "/") end -= 1;
  return `${baseUrl.slice(0, end)}${path}`;
}

export class MachineApiClient {
  constructor(private readonly options: MachineApiClientOptions) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.options.fetchImpl(joinUrl(this.options.baseUrl, path), {
      method,
      headers: {
        authorization: `Bearer ${this.options.accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const code =
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : undefined;
      throw new ApiError(response.status, code, explainApiError(response.status, code));
    }
    return parsed;
  }

  listDeployments(): Promise<unknown> {
    return this.call("GET", "/deployments");
  }

  getDeployment(jobId: string): Promise<DeploymentSummary> {
    return this.call(
      "GET",
      `/deployments/${encodeURIComponent(jobId)}`,
    ) as Promise<DeploymentSummary>;
  }

  listProblemDeployments(problemId: string): Promise<unknown> {
    return this.call("GET", `/problems/${encodeURIComponent(problemId)}/deployments`);
  }

  deployProblem(
    problemId: string,
    body: { readonly awsAccountId: string; readonly region: string; readonly teamName: string },
  ): Promise<{ jobId: string }> {
    return this.call("POST", `/problems/${encodeURIComponent(problemId)}/deploy`, body) as Promise<{
      jobId: string;
    }>;
  }
}

/** deploy が終わったと見なせる状態。 */
export const TERMINAL_SUCCESS_STATUSES: readonly string[] = ["COMPLETE"];
export const TERMINAL_FAILURE_STATUSES: readonly string[] = [
  "FAILED",
  "DELETED",
  "EXPIRED",
  "AUTO_DELETED",
];

export type PollOutcome =
  | { readonly kind: "succeeded"; readonly status: string }
  | { readonly kind: "failed"; readonly status: string }
  | { readonly kind: "timed_out"; readonly status: string };

/**
 * job が終わるまで status を見る。
 *
 * timeout は「まだ終わっていない」であって成功でも失敗でもない。`timed_out` を成功に
 * 丸めると、CI が緑のまま deploy が失敗している状態を作ってしまう。
 */
export async function pollUntilSettled(args: {
  readonly client: Pick<MachineApiClient, "getDeployment">;
  readonly jobId: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onStatus?: (status: string) => void;
}): Promise<PollOutcome> {
  const deadline = args.now() + args.timeoutMs;
  let lastStatus = "UNKNOWN";
  for (;;) {
    const deployment = await args.client.getDeployment(args.jobId);
    lastStatus = deployment.status;
    args.onStatus?.(lastStatus);
    if (TERMINAL_SUCCESS_STATUSES.includes(lastStatus)) {
      return { kind: "succeeded", status: lastStatus };
    }
    if (TERMINAL_FAILURE_STATUSES.includes(lastStatus)) {
      return { kind: "failed", status: lastStatus };
    }
    if (args.now() + args.intervalMs > deadline) {
      return { kind: "timed_out", status: lastStatus };
    }
    await args.sleep(args.intervalMs);
  }
}
