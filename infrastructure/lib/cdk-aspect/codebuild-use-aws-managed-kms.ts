import { type IAspect, Stack } from "aws-cdk-lib";
import { CfnProject } from "aws-cdk-lib/aws-codebuild";
import { CfnPolicy } from "aws-cdk-lib/aws-iam";
import { CfnKey } from "aws-cdk-lib/aws-kms";
import type { IConstruct } from "constructs";

/**
 * SBT (`@cdklabs/sbt-aws`) の `BashJobRunner` (= ScriptJob) は CodeBuild project の
 * artifact 暗号化用に **customer-managed KMS Key** を per-runner で 1 つ作る (= per-stack
 * で 2 つの BashJobRunner、合計 2 keys × N stack)。これは standing cost $1/key/month を
 * 試合ごとに払い続ける形になり、TenkaCloud の build artifact (= bash log + CFn output)
 * の機密性に対して過剰。
 *
 * 本 Aspect は CFn template の整合性を保ったまま customer-managed KMS Key 経路を
 * 取り除く。3 step 構成:
 *
 *   1. `AWS::CodeBuild::Project` の `EncryptionKey` property を **完全削除**
 *      (= CodeBuild が AWS-managed `alias/aws/s3` 既定に倒れる、無料)
 *   2. `AWS::IAM::Policy` の中で customer-managed KMS Key を `Fn::GetAtt` で参照する
 *      statement (= Resource の logical ID に "EncryptionKey" を含むもの) を **statement
 *      単位で除去**。AWS-managed key は CodeBuild service role に kms:* 権限が無くても
 *      透過的に使える
 *   3. 上で参照を切った customer-managed `AWS::KMS::Key` resource を template から除く。
 *      construct path に "EncryptionKey" を含む key の最上位 ancestor を tryRemoveChild
 *
 * セキュリティ: encryption-at-rest 要件は AWS-managed key でも満たす。CodeBuild
 * artifact は provision/deprovision の bash log と CFn output (DDB 名 / Lambda ARN)
 * 程度で、customer-managed key で守るほどの機密性は無い。
 *
 * 範囲: ノード path に `EncryptionKey` を含む `CfnKey` および IAM Policy statement
 * のみ対象。`KmsKeyShortPendingWindow` Aspect が pending window を絞っている他用途の
 * KMS Key (将来追加されたとき) には影響しない。
 *
 * 参考: ProtoShip 同型 PR https://github.com/maishu-kobo/ProtoShip/pull/151
 */
export class CodeBuildUseAwsManagedKms implements IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof CfnProject) {
      removeProjectEncryptionKey(node);
      return;
    }

    if (node instanceof CfnPolicy) {
      removePolicyEncryptionKeyStatements(node);
      return;
    }

    if (node instanceof CfnKey) {
      removeEncryptionKeyConstruct(node);
    }
  }
}

function removeProjectEncryptionKey(node: CfnProject): void {
  // step 1. EncryptionKey property を完全削除 → CodeBuild の AWS-managed default に倒れる。
  // 明示的に "alias/aws/s3" をセットするより future-proof (= AWS default が変わっても追従)。
  node.addPropertyDeletionOverride("EncryptionKey");
}

function removePolicyEncryptionKeyStatements(node: CfnPolicy): void {
  // step 2. policyDocument を resolve して plain JSON にし、Resource の Fn::GetAtt が
  // EncryptionKey 系の logical ID を指す statement を除去する。残った statement で
  // property override する。
  const resolved = Stack.of(node).resolve(node.policyDocument) as
    | { Statement?: PolicyStatement[]; Version?: string }
    | undefined;
  const statements = resolved?.Statement;
  if (!Array.isArray(statements)) return;
  const filtered = statements.filter((s) => !referencesEncryptionKey(s));
  if (filtered.length === statements.length) return;
  if (filtered.length === 0) {
    removeEmptyPolicy(node);
    return;
  }
  node.addPropertyOverride("PolicyDocument.Statement", filtered);
}

function removeEmptyPolicy(node: CfnPolicy): void {
  // 全 statement が消えた = この policy は全部 KMS key 用だった。policy ごと削除。
  const parent = node.node.scope;
  if (!parent) {
    throw new Error(
      `[CodeBuildUseAwsManagedKms] CfnPolicy '${node.node.path}' has no scope; ` +
        `cannot remove orphan empty policy. SBT 構造が変わった可能性、本 Aspect の追従が必要。`,
    );
  }
  parent.node.tryRemoveChild(node.node.id);
}

function removeEncryptionKeyConstruct(node: CfnKey): void {
  // step 3. CfnKey の Construct path に "EncryptionKey" が含まれていることを確認した
  // 上で、その「EncryptionKey」セグメントに対応する L2 Key construct (= ancestor) を
  // 親から remove する。
  if (!node.node.path.includes("EncryptionKey")) return;
  let target: IConstruct = node;
  while (!target.node.id.includes("EncryptionKey") && target.node.scope) {
    target = target.node.scope;
  }
  if (target.node.id.includes("EncryptionKey")) {
    target.node.scope?.node.tryRemoveChild(target.node.id);
  }
}

interface PolicyStatement {
  Action?: unknown;
  Effect?: string;
  Resource?: unknown;
  [key: string]: unknown;
}

/**
 * Statement の **全 Resource** が `Fn::GetAtt` で削除対象 KMS key を参照しているか判定する。
 * Resource は string / array / object のいずれか。object は `{ "Fn::GetAtt": [logicalId, attr] }`
 * の形なので logical ID を見て "EncryptionKey" を含むかで判定。
 *
 * `.some()` でなく `.every()` を使う理由: 1 statement の Resource array に
 * EncryptionKey 参照と他 ARN が混在する場合に `.some()` だと statement 全体を破棄
 * して非 KMS 権限まで道連れにしてしまう。SBT 0.3.9 の BashJobRunner は kms statement
 * に他 ARN を混ぜないので現状は影響無いが、将来 `@cdklabs/sbt-aws` が statement を
 * consolidate しても安全に動くよう defensive に書く。
 *
 * Resource が string literal (= ARN 直書き) の場合は false-negative になる (= statement
 * は維持)。SBT 0.3.9 の BashJobRunner は ARN を string literal で書かないので現状は
 * 問題無し。リスクを取らず温存する側に倒す方針。
 *
 * `JSON.stringify().includes(...)` だと statement の他の場所に "EncryptionKey" 文字列が
 * あれば false-positive する (= Sid 等)。Resource を構造的に見ることで誤判定を避ける。
 */
function referencesEncryptionKey(statement: PolicyStatement): boolean {
  const resource = statement.Resource;
  if (resource == null) return false;
  const resources = Array.isArray(resource) ? resource : [resource];
  return resources.every((r) => {
    if (typeof r !== "object" || r === null) return false;
    const getAtt = (r as { "Fn::GetAtt"?: unknown[] })["Fn::GetAtt"];
    if (!Array.isArray(getAtt) || getAtt.length === 0) return false;
    const logicalId = getAtt[0];
    return typeof logicalId === "string" && logicalId.includes("EncryptionKey");
  });
}
