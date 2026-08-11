import type { VerifiedCloudActionIntent } from "./schema.js";

/**
 * Issue #1727: 検証済み intent と
 * digest 一致した artifact (= CFn テンプレ本文) を、 **customer-local な
 * CloudFormation 権限** で実際に deploy / destroy する executor。
 *
 * ここで使う権限は customer 側から注入された CFn client と、任意の CFn service role
 * ARN に限る。hosted control plane が trust する role を AssumeRole し直さないため、
 * control plane から customer account の配置権限へ到達できない。
 *
 * `@aws-sdk/client-cloudformation` は hard dep にしない (= trust-bridge の方針)。
 * consumer が `CreateStackCommand` / `UpdateStackCommand` / `DeleteStackCommand` を
 * wrap した {@link CfnDeployClient} を注入する。 test では fake。
 */

export interface CfnStackMutationInput {
  readonly StackName: string;
  readonly TemplateBody: string;
  readonly Capabilities: readonly string[];
  /** CFn service role ARN (= LOCAL authority)。 未指定なら呼び出し元 role で実行。 */
  readonly RoleARN?: string;
}

export interface CfnDeployClient {
  createStack(input: CfnStackMutationInput): Promise<{ readonly StackId?: string }>;
  updateStack(input: CfnStackMutationInput): Promise<{ readonly StackId?: string }>;
  deleteStack(input: { readonly StackName: string; readonly RoleARN?: string }): Promise<void>;
}

export interface CloudFormationExecutorOptions {
  readonly client: CfnDeployClient;
  /** stack 名 prefix。default "tc"。customer 側 evaluator が操作できる stack を `tc-*` に限定する。 */
  readonly stackNamePrefix?: string;
  /** CFn capabilities。 default `["CAPABILITY_NAMED_IAM"]` (challenge は named IAM を作りうる)。 */
  readonly capabilities?: readonly string[];
  /** CFn service role ARN。 渡されれば create/update/delete に転写する。 */
  readonly executionRoleArn?: string;
}

export type CfnExecutionAction = "created" | "updated" | "no-op" | "deleted";

export interface CfnExecutionResult {
  readonly action: CfnExecutionAction;
  readonly stackName: string;
  readonly stackId?: string;
}

const DEFAULT_PREFIX = "tc";
const DEFAULT_CAPABILITIES = ["CAPABILITY_NAMED_IAM"] as const;
const STACK_NAME_MAX = 128;

function errName(err: unknown): string | undefined {
  return (err as { name?: string } | null | undefined)?.name;
}

function isNoUpdates(err: unknown): boolean {
  const message = (err as { message?: string } | null | undefined)?.message ?? "";
  return errName(err) === "ValidationError" && /No updates are to be performed/i.test(message);
}

/** intent の source から決定的・CFn 命名規則準拠の stack 名を作る。 */
export function deriveStackName(intent: VerifiedCloudActionIntent, prefix: string): string {
  const parts = [intent.source.problemId, intent.source.deploymentId].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const suffix = parts.length > 0 ? parts.join("-") : intent.requestId;
  const raw = `${prefix}-${suffix}`;
  // CFn stack 名: 英数 + ハイフンのみ、 先頭は英字、 最大 128。
  const cleaned = raw.replace(/[^A-Za-z0-9-]/g, "-").replace(/^[^A-Za-z]+/, "");
  return (cleaned || prefix).slice(0, STACK_NAME_MAX);
}

export class CloudFormationExecutor {
  private readonly options: CloudFormationExecutorOptions;

  constructor(options: CloudFormationExecutorOptions) {
    this.options = options;
  }

  /** deploy → create-or-update、 destroy → delete。 他の action は非対応。 */
  async execute(
    intent: VerifiedCloudActionIntent,
    artifactBody: string,
  ): Promise<CfnExecutionResult> {
    const stackName = deriveStackName(intent, this.options.stackNamePrefix ?? DEFAULT_PREFIX);
    if (intent.action.type === "deploy") {
      return this.deploy(stackName, artifactBody);
    }
    if (intent.action.type === "destroy") {
      await this.options.client.deleteStack({
        StackName: stackName,
        ...(this.options.executionRoleArn ? { RoleARN: this.options.executionRoleArn } : {}),
      });
      return { action: "deleted", stackName };
    }
    throw new Error(
      `CloudFormationExecutor supports deploy/destroy, got action ${intent.action.type}`,
    );
  }

  private mutationInput(stackName: string, body: string): CfnStackMutationInput {
    return {
      StackName: stackName,
      TemplateBody: body,
      Capabilities: this.options.capabilities ?? [...DEFAULT_CAPABILITIES],
      ...(this.options.executionRoleArn ? { RoleARN: this.options.executionRoleArn } : {}),
    };
  }

  private async deploy(stackName: string, body: string): Promise<CfnExecutionResult> {
    try {
      const { StackId } = await this.options.client.createStack(
        this.mutationInput(stackName, body),
      );
      return { action: "created", stackName, ...(StackId ? { stackId: StackId } : {}) };
    } catch (err) {
      if (errName(err) === "AlreadyExistsException") {
        return this.update(stackName, body);
      }
      throw err;
    }
  }

  private async update(stackName: string, body: string): Promise<CfnExecutionResult> {
    try {
      const { StackId } = await this.options.client.updateStack(
        this.mutationInput(stackName, body),
      );
      return { action: "updated", stackName, ...(StackId ? { stackId: StackId } : {}) };
    } catch (err) {
      // CFn は「変更なし」を ValidationError で返す。 これは成功扱いの no-op。
      if (isNoUpdates(err)) {
        return { action: "no-op", stackName };
      }
      throw err;
    }
  }
}
