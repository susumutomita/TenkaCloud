import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #2960: destroy 後に log group が 48 個残り、うち **29 個が retention 未設定
 * (= Never expire)** だった。残骸が残るだけでなく、残った分の保存料金が永久に出る形になっていた。
 *
 * `LogGroupRetention` Aspect はまさにこのために書かれており、CFn resource として存在する
 * log group には正しく効いている。ここではその範囲を機械で固定する — synth に現れる
 * `AWS::Logs::LogGroup` は 1 つ残らず `RetentionInDays` を持たなければならない。
 *
 * ## この test が守れない範囲 (意図的に明記する)
 *
 * 実測で retention=null だったのは、いずれも **synth に現れない** log group だった。
 * `/aws/lambda/*` は Lambda 関数の初回実行時に Lambda サービスが暗黙に作るので、CFn resource
 * ではなく Aspect の視界にも synth 出力にも入らない。具体的には CDK 自身が生成する custom
 * resource provider (`CustomCDKBucketDeployment` / `CustomS3AutoDeleteObjects` /
 * `CustomAWSCDKOpenIdConnectProvider`) と `/aws/codebuild/*` がそれにあたる。
 *
 * したがって「synth 上は全件 retention 付き」であることと「アカウント上に無期限保持が無い」
 * ことは **同じではない**。後者は cleanup.sh の log group sweep が回収する。この test を
 * 「全部塞いだ証明」として読まないこと。
 */

const CDK_OUT = resolve(__dirname, "..", "..", "cdk.out");

interface CfnTemplate {
  readonly Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }>;
}

function templateFiles(): string[] {
  return readdirSync(CDK_OUT)
    .filter((name) => name.endsWith(".template.json"))
    .map((name) => join(CDK_OUT, name));
}

describe("#2960: every synthesized log group carries a retention", () => {
  it("should find synthesized templates to inspect", () => {
    // cdk.out が無い状態で 0 件を「違反なし」と読むと、この test は永遠に緑のまま無意味になる。
    // `make check-synth` / `make synth` を通っていることをここで要求する。
    expect(
      templateFiles().length,
      "cdk.out にテンプレートがありません。先に `make check-synth` を実行してください。",
    ).toBeGreaterThan(0);
  });

  it("should never emit a log group without RetentionInDays", () => {
    const offenders: string[] = [];
    let inspected = 0;
    for (const file of templateFiles()) {
      const template = JSON.parse(readFileSync(file, "utf8")) as CfnTemplate;
      for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
        if (resource.Type !== "AWS::Logs::LogGroup") continue;
        inspected += 1;
        if (resource.Properties?.RetentionInDays === undefined) {
          offenders.push(`${file.split("/").pop()}:${logicalId}`);
        }
      }
    }
    expect(
      inspected,
      "log group が 1 つも見つからないのは走査対象が壊れている兆候",
    ).toBeGreaterThan(0);
    expect(offenders, `retention 未設定の log group: ${offenders.join(", ")}`).toEqual([]);
  });
});
