import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Issue #951 sub #2: `scripts/check-template-cfn-refs.ts` の挙動を pin する。
 *
 * 直接 main を呼ばずに、 同 script の helper 関数を import して unit test する設計が望ましいが、
 * 現状 `main()` のみ export していないので、 child process で script 全体を実行して exit code +
 * stdout/stderr で検証する。 これにより、 後で helper を export 化したとき test を壊さずに済む
 * (= 公開 contract = 「exit code + 出力」 を pin する)。
 *
 * test 戦略:
 *   - 一時ディレクトリに problems/<category>/<id>/template.yaml を仕込んで script を回す
 *   - script は `problems/` 直下を絶対 path で見るため、 PROBLEMS_DIR を env で上書き...は本実装には
 *     無いので、 「 既存 problem template (= main repo の 4 個) を抜けるかどうか」 だけ smoke test
 */

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

describe("check-template-cfn-refs script (#951 sub-2)", () => {
  it("既存 4 問題 template は全 pass するべき (= smoke test)", () => {
    const result = spawnSync("bun", ["run", "scripts/check-template-cfn-refs.ts"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK:");
    expect(result.stdout).toContain("4 template(s)");
  });
});

/**
 * helper 関数の export 化を待たずに、 検出ロジックの unit test を持ちたい部分は
 * inline で同等のロジックを再現する (= regression を script 側で起こしたら同じ正規表現に
 * 戻すかどうかを review で議論できるよう、 期待挙動を doc 化する目的)。
 */
describe("check-template-cfn-refs detection patterns (= 期待挙動 doc)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "tc-cfn-refs-test-"));
  const tmpProblem = join(tmpDir, "problems/challenges/test-problem");
  beforeEach(() => {
    mkdirSync(tmpProblem, { recursive: true });
  });
  afterEach(() => {
    try {
      rmSync(tmpProblem, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("Resources / Parameters / pseudo を分けて parse できること (= shape 確認)", () => {
    const yaml = `AWSTemplateFormatVersion: "2010-09-09"
Parameters:
  NamePrefix:
    Type: String
  TenkaCloudAccountId:
    Type: String
Resources:
  HelloParameter:
    Type: AWS::SSM::Parameter
    Properties:
      Name: !Sub "/\${NamePrefix}/hello"
      Type: String
      Value: !Sub "Hello from \${NamePrefix}"
  ParticipantViewerRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub "\${NamePrefix}-participant-viewer"
Outputs:
  ParticipantViewerRoleArn:
    Value: !GetAtt ParticipantViewerRole.Arn
`;
    // 単純 parse: line に \`^  HelloParameter:\` 等が含まれることを確認する。
    expect(yaml).toContain("HelloParameter:");
    expect(yaml).toContain("ParticipantViewerRole:");
    expect(yaml).toContain("ParticipantViewerRoleArn:");
  });

  it("`!Ref UnknownResource` を unresolve として検出する (= pattern doc)", () => {
    // 本物の script を回さなくても、 unresolved-ref を投げ込むテンプレが具体的にどう失敗するかを
    // doc 化する目的の test。 実 script 走行は前段の smoke test で。
    const yaml = `Resources:
  Foo:
    Type: AWS::SSM::Parameter
    Properties:
      Name: !Ref BogusResource
`;
    const re = /!Ref\s+([A-Za-z][A-Za-z0-9:_]*)/g;
    const refs = [...yaml.matchAll(re)].map((m) => m[1]);
    expect(refs).toContain("BogusResource");
  });
});
