/**
 * [Issue #1419] executor の `sendDispatch` dep 具体実装 = 正規化記述子 (DisruptionDispatch) を
 * 競技者アカウントの実 SDK command に map して送る。 client は describe-stack-handler と同じ factory dep
 * (`{ region, credentials }` を受けて assumed-credential client を返す) で注入し、 unit test では mock する。
 *
 * 新 SDK 依存は無し (ssm / lambda / cloudformation client は infra に既存)。 SDK の振る舞い選択:
 *   - ssm-run-command: target = stackOutputs の instance ids (comma 区切り) を SendCommand の InstanceIds に。
 *     params は SSM Parameters (= Record<string,string[]>) へ coerce。
 *   - lambda-invoke: InvocationType="Event" の **非同期** 投入 (= fault 注入の完了は待たない、 executor を塞がない)。
 *   - cfn-stack-update: UsePreviousTemplate=true + params を CFn Parameters に。 既存 stack を parameter 上書き
 *     だけで degrade させる前提。 IAM capability は competitor stack が named role を含みうるため明示。
 */

import {
  Capability,
  type CloudFormationClient,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { SendCommandCommand, type SSMClient } from "@aws-sdk/client-ssm";
import type { Credentials } from "@aws-sdk/client-sts";
import type { DisruptionDispatch } from "./dispatch-command.js";

export interface DispatchTarget {
  readonly region: string;
  readonly credentials?: Credentials;
}

export interface SendDispatchDeps {
  readonly ssmClient: (target: DispatchTarget) => Pick<SSMClient, "send">;
  readonly lambdaClient: (target: DispatchTarget) => Pick<LambdaClient, "send">;
  readonly cfnClient: (target: DispatchTarget) => Pick<CloudFormationClient, "send">;
}

const DEFAULT_SSM_DOCUMENT = "AWS-RunShellScript";
const CFN_UPDATE_CAPABILITIES: Capability[] = [
  Capability.CAPABILITY_IAM,
  Capability.CAPABILITY_NAMED_IAM,
  Capability.CAPABILITY_AUTO_EXPAND,
];

/** dispatch.params の各値を SSM Parameters の Record<string, string[]> へ coerce。 */
function toSsmParameters(params: Readonly<Record<string, unknown>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = Array.isArray(value) ? value.map((v) => String(v)) : [String(value)];
  }
  return out;
}

/** dispatch.params を CFn UpdateStack の Parameters ({ParameterKey, ParameterValue}[]) へ。 */
function toCfnParameters(
  params: Readonly<Record<string, unknown>>,
): { ParameterKey: string; ParameterValue: string }[] {
  return Object.entries(params).map(([key, value]) => ({
    ParameterKey: key,
    ParameterValue: String(value),
  }));
}

/** comma 区切りの instance ids 文字列を trim + 空要素除去で配列化。 */
function toInstanceIds(target: string): string[] {
  return target
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 1 つの dispatch 記述子を competitor account で実行する。 AssumeRole 済の credentials は target に乗る
 * 前提 (= 解決は caller=handler 側)。 SDK error は握り潰さず伝播 (= 注入失敗を loud にする)。
 */
export async function sendDispatch(
  dispatch: DisruptionDispatch,
  target: DispatchTarget,
  deps: SendDispatchDeps,
): Promise<void> {
  // [#1710 / IAM audit] 同一アカウント (Lite) mode では AssumeRole 先が無く、 dispatch は executor
  // 自身の credentials で実行される (= `target.credentials` 不在)。 executor role は Lite 向けに
  // `ssm-run-command` (SendCommand) だけを scope 付きで許可しており、 `lambda-invoke`
  // (`lambda:InvokeFunction`) と `cfn-stack-update` (`cloudformation:UpdateStack`) は付与していない。
  // そのまま SDK を叩くと AccessDenied になり「infra 設定ミス」に見える誤診を招くため、 ここで
  // fail-closed に落として未対応であることを loud に示す。 SaaS mode は assumed competitor role で
  // 全 kind が動くので本 guard は通過する (= `target.credentials` が有る)。
  // EN: In same-account (Lite) mode there is no assumed competitor role, so the dispatch runs under
  // the executor's OWN role, which grants only `ssm-run-command`. Fail loudly for the ungranted
  // kinds instead of surfacing a misleading AccessDenied. (Granting Lite parity would be a separate,
  // deliberate change to the executor role — see #1710's scoping rationale.)
  if (!target.credentials && dispatch.kind !== "ssm-run-command") {
    throw new Error(
      `Disruption kind "${dispatch.kind}" is not supported in same-account (Lite) mode ` +
        "(the executor role grants only ssm-run-command there); run this event in SaaS mode.",
    );
  }
  if (dispatch.kind === "ssm-run-command") {
    await deps.ssmClient(target).send(
      new SendCommandCommand({
        DocumentName: dispatch.documentName ?? DEFAULT_SSM_DOCUMENT,
        InstanceIds: toInstanceIds(dispatch.target),
        Parameters: toSsmParameters(dispatch.params),
      }),
    );
    return;
  }
  if (dispatch.kind === "lambda-invoke") {
    await deps.lambdaClient(target).send(
      new InvokeCommand({
        FunctionName: dispatch.target,
        InvocationType: "Event",
        Payload: new TextEncoder().encode(JSON.stringify(dispatch.params)),
      }),
    );
    return;
  }
  // cfn-stack-update
  await deps.cfnClient(target).send(
    new UpdateStackCommand({
      StackName: dispatch.target,
      UsePreviousTemplate: true,
      Parameters: toCfnParameters(dispatch.params),
      Capabilities: CFN_UPDATE_CAPABILITIES,
    }),
  );
}
