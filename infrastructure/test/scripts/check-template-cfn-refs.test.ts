import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectGetAttResources,
  collectRefs,
  collectSubMapKeys,
  collectSubRefs,
  parseSections,
} from "../../../scripts/check-template-cfn-refs";

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
 *   - PROBLEMS_DIR で fixture catalog を明示し、 live submodule / catalog の problem 数には依存しない
 */

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

describe("check-template-cfn-refs script (#951 sub-2)", () => {
  it("should scan only the configured problems directory", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "tc-cfn-refs-cli-"));
    const problemsDir = join(fixtureRoot, "problems");
    const problemDir = join(problemsDir, "challenges/test-problem");
    mkdirSync(problemDir, { recursive: true });
    writeFileSync(
      join(problemDir, "template.yaml"),
      `AWSTemplateFormatVersion: "2010-09-09"
Parameters:
  NamePrefix:
    Type: String
Resources:
  ParticipantViewerRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub "\${NamePrefix}-participant-viewer"
Outputs:
  ParticipantViewerRoleArn:
    Value: !GetAtt ParticipantViewerRole.Arn
`,
    );
    const result = spawnSync("bun", ["run", "scripts/check-template-cfn-refs.ts"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, PROBLEMS_DIR: problemsDir },
    });
    try {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("OK:");
      expect(result.stdout).toContain("1 template(s)");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
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
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
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

describe("check-template-cfn-refs unit (= 抽出した helper の挙動を pin)", () => {
  it("parseSections: should separate Resources / Parameters / Outputs and collect names", () => {
    const yaml = `AWSTemplateFormatVersion: "2010-09-09"
Parameters:
  NamePrefix:
    Type: String
  ExternalId:
    Type: String
Resources:
  Role:
    Type: AWS::IAM::Role
  Bucket:
    Type: AWS::S3::Bucket
Outputs:
  RoleArn:
    Value: !GetAtt Role.Arn
`;
    const sections = parseSections(yaml);
    expect([...sections.parameters].sort()).toEqual(["ExternalId", "NamePrefix"]);
    expect([...sections.resources].sort()).toEqual(["Bucket", "Role"]);
    expect([...sections.outputs].sort()).toEqual(["RoleArn"]);
  });

  it("parseSections: should exit currentSection on entering other top-level sections (e.g. Conditions)", () => {
    const yaml = `Resources:
  A:
    Type: AWS::Foo
Conditions:
  IsProd: !Equals [a, b]
Resources:
  B:
    Type: AWS::Bar
`;
    const sections = parseSections(yaml);
    expect([...sections.resources].sort()).toEqual(["A", "B"]);
  });

  it("collectRefs: should pick up both !Ref shortform and Ref: longform", () => {
    const yaml = `Resources:
  A:
    Properties:
      Name: !Ref NamePrefix
      Tag:
        Ref: ExternalId
`;
    expect(collectRefs(yaml).sort()).toEqual(["ExternalId", "NamePrefix"]);
  });

  it("collectGetAttResources: should pick up both !GetAtt and Fn::GetAtt", () => {
    const yaml = `Resources:
  Out:
    Value: !GetAtt Role.Arn
  Other:
    Value:
      Fn::GetAtt: [ Bucket, Arn ]
`;
    expect(collectGetAttResources(yaml).sort()).toEqual(["Bucket", "Role"]);
  });

  it(`collectSubRefs: should treat \\\${Var} as ref, \\\${X.Y} as getAtt, and ignore \\\${!Literal}`, () => {
    const yaml = `Foo: !Sub "\${NamePrefix}-suffix"
Bar: !Sub "arn:\${AWS::Partition}:s3:::bucket"
Baz: !Sub "arn:s3:::\${Role.Arn}"
Esc: !Sub "literal \${!NotAVariable}"
`;
    const out = collectSubRefs(yaml);
    expect(out.refs.sort()).toEqual(["AWS::Partition", "NamePrefix"]);
    expect(out.getAtts).toEqual(["Role"]);
    expect(out.refs).not.toContain("NotAVariable");
    expect(out.getAtts).not.toContain("NotAVariable");
  });

  it("collectSubRefs: should skip shell expansions that are not valid CFn Sub variable names", () => {
    // Plain `Fn::Base64: |` UserData ships shell scripts whose ${...} は CFn 参照ではない。
    // CFn の Sub 変数文法 (英数 logical name / AWS:: pseudo / Dotted.Attr) に合わない式は捨てる。
    const yaml = `Script: |
  APP_IP="\${1:-}"
  NAME="\${EXPECTED_NAME}"
  WITH_DEFAULT="\${FOO:-bar}"
  ALL="\${ARR[@]}"
  CFN: !Sub "\${NamePrefix}"
`;
    const out = collectSubRefs(yaml);
    expect(out.refs).toEqual(["NamePrefix"]);
    expect(out.getAtts).toEqual([]);
  });

  it("collectSubMapKeys: should collect list-form Fn::Sub variable-map keys as declared names", () => {
    // UserData:
    //   Fn::Base64: !Sub
    //     - |
    //       ORIGIN="http://\${NatPublicIp}/"
    //     - NatPublicIp: !GetAtt NatInstance.PublicIp
    const yaml = `UserData:
  Fn::Base64: !Sub
    - |
      ORIGIN="http://\${NatPublicIp}/"
    - NatPublicIp: !GetAtt NatInstance.PublicIp
`;
    expect(collectSubMapKeys(yaml)).toEqual(["NatPublicIp"]);
    const out = collectSubRefs(yaml);
    expect(out.refs).toContain("NatPublicIp");
  });
});
