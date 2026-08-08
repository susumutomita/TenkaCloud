import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BIND_RESOURCE_SERVER_PREFIX,
  BIND_SCOPE_NAME,
  CAPABILITY_RESOURCE_SERVER_ID,
  MACHINE_ACCESS_TOKEN_VALIDITY_MINUTES,
  MACHINE_CLIENT_NAME_PREFIX,
} from "../../lib/problem-deploy/handlers/shared/machine-scopes";

/**
 * Issue #2952: machine (M2M) credential のライフサイクル。
 *
 * `tc-tenant-<tenantId>` bind resource server と `tc-m2m-*` app client は CFn 管理外なので
 * `cdk destroy` では回収されない。pooled tier では UserPool が共有で残り続けるため、回収し
 * 損ねると **削除済み tenant の credential が有効なまま残る**。
 *
 * `deprovision-tenant.sh` は CodeBuild が yum / sudo 込みで丸ごと実行する script なので
 * end-to-end では走らせられない。そこで回収 function だけを切り出し、fake `aws` を PATH に
 * 置いて実際に bash で実行し、発行される AWS 呼び出しを assert する。
 */

const REPO_ROOT = resolve(__dirname, "../../..");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** `reap_machine_credentials` とその定数だけを script から抜き出す。 */
function extractReapFunction(): string {
  const script = readFileSync(join(REPO_ROOT, "scripts/deprovision-tenant.sh"), "utf8");
  const start = script.indexOf('BIND_RESOURCE_SERVER_PREFIX="tc-tenant-"');
  expect(start, "deprovision-tenant.sh no longer defines the reaping constants").toBeGreaterThan(
    -1,
  );
  const end = script.indexOf("# Un deploy the tenant template for platinum tier", start);
  expect(end, "deprovision-tenant.sh no longer defines reap_machine_credentials").toBeGreaterThan(
    start,
  );
  return script.slice(start, end);
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly awsCalls: readonly string[];
}

function runReap(args: {
  readonly userPoolId: string;
  readonly tenantId: string;
  readonly machineClientIds?: readonly string[];
  readonly bindResourceServerExists?: boolean;
}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "tenkacloud-reap-"));
  tempDirs.push(dir);
  const callLog = join(dir, "aws-calls.log");
  const fakeAws = join(dir, "aws");

  writeFileSync(
    fakeAws,
    `#!/bin/bash
echo "$*" >> ${JSON.stringify(callLog)}
case "$1 $2" in
  "cognito-idp list-user-pool-clients")
    ${
      (args.machineClientIds ?? []).length === 0
        ? "true"
        : `printf '%s\\t' ${(args.machineClientIds ?? []).map((id) => JSON.stringify(id)).join(" ")}; echo`
    }
    exit 0
    ;;
  "cognito-idp describe-resource-server")
    exit ${args.bindResourceServerExists === false ? 254 : 0}
    ;;
esac
exit 0
`,
    "utf8",
  );
  chmodSync(fakeAws, 0o755);

  const runner = join(dir, "run.sh");
  writeFileSync(
    runner,
    `set -e
set -o pipefail
${extractReapFunction()}
reap_machine_credentials ${JSON.stringify(args.userPoolId)} ${JSON.stringify(args.tenantId)}
`,
    "utf8",
  );

  const result = spawnSync("bash", [runner], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  });
  let awsCalls: string[] = [];
  try {
    awsCalls = readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    awsCalls = [];
  }
  return { status: result.status, stdout: `${result.stdout}\n${result.stderr}`, awsCalls };
}

describe("#2952: deprovision reaps machine credentials", () => {
  it("should delete every tc-m2m client and the bind resource server", () => {
    const result = runReap({
      userPoolId: "ap-northeast-1_TEST",
      tenantId: "tenant-1",
      machineClientIds: ["client-a", "client-b"],
    });
    expect(result.status, result.stdout).toBe(0);
    expect(result.awsCalls.join("\n")).toContain(
      "delete-user-pool-client --user-pool-id ap-northeast-1_TEST --client-id client-a",
    );
    expect(result.awsCalls.join("\n")).toContain("--client-id client-b");
    expect(result.awsCalls.join("\n")).toContain(
      "delete-resource-server --user-pool-id ap-northeast-1_TEST --identifier tc-tenant-tenant-1",
    );
  });

  it("should scope the client query to this tenant's tc-m2m prefix", () => {
    const result = runReap({ userPoolId: "ap-northeast-1_TEST", tenantId: "tenant-1" });
    expect(result.awsCalls.join("\n")).toContain("starts_with(ClientName, 'tc-m2m-tenant-1')");
  });

  it("should be idempotent when the tenant never had a machine credential", () => {
    const result = runReap({
      userPoolId: "ap-northeast-1_TEST",
      tenantId: "tenant-1",
      machineClientIds: [],
      bindResourceServerExists: false,
    });
    expect(result.status, result.stdout).toBe(0);
    expect(result.awsCalls.join("\n")).not.toContain("delete-user-pool-client");
    expect(result.awsCalls.join("\n")).not.toContain("delete-resource-server");
  });

  it("should skip loudly rather than guess when the user pool id could not be resolved", () => {
    const result = runReap({ userPoolId: "", tenantId: "tenant-1" });
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("user pool id not resolved");
    expect(result.awsCalls).toEqual([]);
  });

  it("should state that already-issued tokens survive until their TTL expires", () => {
    const result = runReap({ userPoolId: "ap-northeast-1_TEST", tenantId: "tenant-1" });
    expect(result.stdout).toContain("expire within 15 minutes");
  });
});

describe("#2952: both deprovision branches reap", () => {
  const script = readFileSync(join(REPO_ROOT, "scripts/deprovision-tenant.sh"), "utf8");

  it("should call the reaper in the silo branch before cdk destroy", () => {
    const reapIndex = script.indexOf('reap_machine_credentials "$SILO_USERPOOL_ID"');
    const destroyIndex = script.indexOf("cdk -- destroy");
    expect(reapIndex).toBeGreaterThan(-1);
    // stack を消したあとでは UserPool id を引けないので、順序そのものが正しさの一部。
    expect(reapIndex).toBeLessThan(destroyIndex);
  });

  it("should call the reaper in the pooled branch (the shared pool outlives the tenant)", () => {
    expect(script).toContain('reap_machine_credentials "$SAAS_APP_USERPOOL_ID"');
  });
});

describe("#2952: the shell scripts and the TypeScript contract agree on the naming", () => {
  const issueScript = readFileSync(join(REPO_ROOT, "scripts/issue-machine-client.sh"), "utf8");
  const deprovisionScript = readFileSync(join(REPO_ROOT, "scripts/deprovision-tenant.sh"), "utf8");

  // 名前は handler の guard (`tc-tenant-<id>/bind` を parse する側) と shell (発行 / 回収する側) の
  // 両方に現れる。片方だけ変えると、発行はできるのに token が machine principal として解決され
  // ない、あるいは回収が空振りする。TypeScript 側の定数を正本にして両 script を照合する。
  it.each([
    ["issue-machine-client.sh", issueScript],
    ["deprovision-tenant.sh", deprovisionScript],
  ])("should use the shared prefixes in %s", (_name, script) => {
    expect(script).toContain(`BIND_RESOURCE_SERVER_PREFIX="${BIND_RESOURCE_SERVER_PREFIX}"`);
    expect(script).toContain(`MACHINE_CLIENT_NAME_PREFIX="${MACHINE_CLIENT_NAME_PREFIX}"`);
  });

  it("should issue tokens with the TTL the contract declares", () => {
    expect(issueScript).toContain(
      `ACCESS_TOKEN_VALIDITY_MINUTES=${MACHINE_ACCESS_TOKEN_VALIDITY_MINUTES}`,
    );
    expect(deprovisionScript).toContain(
      `expire within ${MACHINE_ACCESS_TOKEN_VALIDITY_MINUTES} minutes`,
    );
  });

  it("should name the capability resource server the handler expects", () => {
    expect(issueScript).toContain(
      `CAPABILITY_RESOURCE_SERVER_ID="${CAPABILITY_RESOURCE_SERVER_ID}"`,
    );
    expect(issueScript).toContain(`BIND_SCOPE_NAME="${BIND_SCOPE_NAME}"`);
  });
});

describe("#2952: the issuance script guards the resource server quota", () => {
  const script = readFileSync(join(REPO_ROOT, "scripts/issue-machine-client.sh"), "utf8");

  it("should fail hard at the quota and warn before it", () => {
    expect(script).toContain("preflight_resource_server_quota");
    expect(script).toContain("resource server quota");
    expect(script).toContain("warning: resource server 数が quota の");
  });

  it("should expose create, list, revoke and revoke-tenant", () => {
    for (const mode of ["create", "list", "revoke", "revoke-tenant"]) {
      expect(script).toContain(`  ${mode})`);
    }
  });

  it("should never persist the client secret", () => {
    // secret を tee / > / SSM put へ流す行が生えたらここで落ちる。
    expect(script).not.toMatch(/ClientSecret[^\n]*(>|tee|put-parameter)/);
    expect(script).not.toContain("put-parameter");
  });
});
