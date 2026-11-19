import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBundle, sha256, validateConfig } from "../cli/terraform-bundle";
import { runTerraformCommand, type TerraformExecutor } from "../cli/terraform-runner";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup(kintone = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tenka-terraform-")));
  temporary.push(base);
  // macOS /var is a symlink; resolve the trusted root once before passing it.
  const root = join(base, "state");
  const bundle = join(base, "bundle");
  mkdirSync(bundle);
  const config = {
    terraform: {
      required_version: "= 1.14.8",
      ...(kintone
        ? {
            required_providers: { kintone: { source: "susumutomita/kintone", version: "= 0.1.0" } },
          }
        : {}),
    },
    resource: kintone
      ? {
          kintone_app: {
            exercise: { name: "test", rights: [{ entity_type: "CREATOR", app_editable: true }] },
          },
        }
      : { terraform_data: { exercise: { input: "test" } } },
  };
  writeFileSync(join(bundle, "main.tf.json"), JSON.stringify(config));
  writeFileSync(join(bundle, ".terraform.lock.hcl"), "# reviewed fixture");
  if (kintone) {
    mkdirSync(join(bundle, "mirror"));
    writeFileSync(join(bundle, "mirror", "provider"), "reviewed plugin");
  }
  const binary = join(base, "terraform");
  writeFileSync(binary, "mock binary");
  chmodSync(binary, 0o700);
  const scope = [
    "--root",
    root,
    "--tenant",
    "tenant",
    "--event",
    "event",
    "--team",
    "team",
    "--problem",
    "problem",
    "--generation",
    "1",
  ];
  const lines: string[] = [];
  const calls: string[][] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const runner: TerraformExecutor = (_binary, args, cwd, env) => {
    calls.push(args);
    environments.push(env);
    if (args[0] === "plan") writeFileSync(join(cwd, "approved.tfplan"), "private plan");
    if (args[0] === "apply") writeFileSync(join(cwd, "terraform.tfstate"), "private state");
    return 0;
  };
  const env = {
    KINTONE_BASE_URL: "https://example.cybozu.com",
    KINTONE_USERNAME: "organizer",
    KINTONE_PASSWORD: randomUUID(),
    TF_LOG: "TRACE",
    TF_CLI_ARGS: "-destroy",
    AWS_SECRET_ACCESS_KEY: "SECRET",
  };
  const run = (command: string, extra: string[] = [], executor = runner, inputEnv = env) =>
    runTerraformCommand(
      [command, ...scope, ...extra],
      (line) => lines.push(line),
      inputEnv,
      executor,
    );
  const prepare = () =>
    run("prepare", [
      "--bundle",
      bundle,
      "--reviewed-sha",
      readBundle(bundle).digest,
      "--binary",
      binary,
      "--binary-sha",
      sha256(readFileSync(binary)),
      ...(kintone ? ["--endpoint", env.KINTONE_BASE_URL] : []),
    ]);
  const directory = () => join(root, readdirSync(root)[0]);
  const journal = () => JSON.parse(readFileSync(join(directory(), "journal.json"), "utf8"));
  return {
    base,
    root,
    bundle,
    binary,
    scope,
    config,
    lines,
    calls,
    environments,
    runner,
    env,
    run,
    prepare,
    directory,
    journal,
  };
}
describe("restricted Terraform organizer runner", () => {
  test("prepare/plan/approve/apply, private scope and no replay", () => {
    const f = setup();
    expect(f.prepare()).toBe(0);
    expect(f.calls).toHaveLength(0);
    expect(f.run("status")).toBe(0);
    const status = JSON.parse(f.lines.at(-1) ?? "{}");
    expect(status.scopeId).toBe(readdirSync(f.root)[0]);
    expect(JSON.stringify(status)).not.toContain(f.root);
    expect(f.run("plan")).toBe(0);
    expect(f.run("apply", ["--approve-plan", "wrong"])).toBe(1);
    expect(f.run("apply", ["--approve-plan", f.journal().planSha])).toBe(0);
    expect(f.journal().phase).toBe("applied");
    expect(f.run("apply", ["--approve-plan", f.journal().planSha])).toBe(1);
    expect(
      f.environments.every(
        (env) =>
          !env.TF_LOG && !env.TF_CLI_ARGS && !env.AWS_SECRET_ACCESS_KEY && !env.KINTONE_PASSWORD,
      ),
    ).toBe(true);
    expect(f.lines.join(" ")).not.toContain("SECRET");
    expect(f.lines.join(" ")).not.toContain(f.env.KINTONE_PASSWORD);
  });
  test("endpoint and principal cannot change between prepare/plan/apply", () => {
    const f = setup(true);
    expect(f.prepare()).toBe(0);
    expect(
      f.run("plan", [], f.runner, { ...f.env, KINTONE_BASE_URL: "https://other.cybozu.com" }),
    ).toBe(1);
    expect(f.run("plan")).toBe(0);
    expect(
      f.run("apply", ["--approve-plan", f.journal().planSha], f.runner, {
        ...f.env,
        KINTONE_USERNAME: "other",
      }),
    ).toBe(1);
    expect(f.calls.filter((args) => args[0] === "apply")).toHaveLength(0);
  });
  test("apply failure preserves partial state and refuses automatic retry", () => {
    const f = setup();
    f.prepare();
    f.run("plan");
    const fail: TerraformExecutor = (_bin, args, cwd) => {
      if (args[0] !== "apply") return 0;
      writeFileSync(join(cwd, "terraform.tfstate"), "partial SECRET state");
      return 1;
    };
    expect(f.run("apply", ["--approve-plan", f.journal().planSha], fail)).toBe(1);
    expect(f.journal().phase).toBe("apply_failed");
    expect(readFileSync(join(f.directory(), "work", "terraform.tfstate"), "utf8")).toBe(
      "partial SECRET state",
    );
    expect(f.run("apply", ["--approve-plan", f.journal().planSha])).toBe(1);
    expect(f.lines.join(" ")).not.toContain("SECRET");
    expect(f.lines.join(" ")).not.toContain(f.env.KINTONE_PASSWORD);
  });
  test("exclusive operation lock refuses concurrent commands", () => {
    const f = setup();
    f.prepare();
    writeFileSync(join(f.directory(), "operation.lock"), "");
    expect(f.run("plan")).toBe(1);
    expect(f.calls).toHaveLength(0);
  });
  test("bundle, mirror, binary and plan tampering refused", () => {
    const f = setup(true);
    f.prepare();
    writeFileSync(join(f.directory(), "bundle", "mirror", "provider"), "tampered");
    expect(f.run("plan")).toBe(1);
    const g = setup();
    g.prepare();
    g.run("plan");
    writeFileSync(join(g.directory(), "work", "approved.tfplan"), "tampered");
    expect(g.run("apply", ["--approve-plan", g.journal().planSha])).toBe(1);
    writeFileSync(g.binary, "tampered");
    expect(g.run("plan")).toBe(1);
  });
  test("symlink, state input, extra config, unsafe directory rejected", () => {
    const f = setup();
    symlinkSync(f.binary, join(f.bundle, "evil"));
    expect(() => readBundle(f.bundle)).toThrow();
    const g = setup();
    writeFileSync(join(g.bundle, "terraform.tfstate"), "state");
    expect(() => readBundle(g.bundle)).toThrow();
    const h = setup();
    h.prepare();
    writeFileSync(join(h.directory(), "work", "override.tf"), "");
    expect(h.run("plan")).toBe(1);
    const i = setup();
    mkdirSync(i.root, { mode: 0o755 });
    // Keep this deliberately unsafe fixture independent of the caller's umask.
    chmodSync(i.root, 0o755);
    expect(i.prepare()).toBe(1);
  });
  test("no modules, backends, credentials, provisioners or interpolation", () => {
    const f = setup();
    for (const config of [
      { ...f.config, module: {} },
      { ...f.config, terraform: { required_version: "= 1.14.8", backend: {} } },
      { ...f.config, provider: { kintone: { password: f.env.KINTONE_PASSWORD } } },
      { ...f.config, resource: { terraform_data: { x: { provisioner: {} } } } },
      { ...f.config, resource: { terraform_data: { x: { input: `\${file("secret")}` } } } },
    ])
      expect(() => validateConfig(config)).toThrow();
  });
  test("prepare refuses existing unowned working state without changing it", () => {
    const f = setup();
    expect(f.run("status")).toBe(1);
    const work = join(f.directory(), "work");
    mkdirSync(work, { mode: 0o700 });
    const state = join(work, "terraform.tfstate");
    writeFileSync(state, "existing unowned state", { mode: 0o600 });
    expect(f.prepare()).toBe(1);
    expect(readFileSync(state, "utf8")).toBe("existing unowned state");
    expect(f.calls).toHaveLength(0);
    expect(readdirSync(f.directory())).toEqual(["work"]);
  });
  test("rejects expressions in nested object keys before running Terraform", () => {
    const f = setup();
    for (const key of [`\${1+1}`, `\${file("local-file")}`, "%{if true}key%{endif}"]) {
      const config = {
        ...f.config,
        resource: { terraform_data: { x: { input: { nested: [{ [key]: "value" }] } } } },
      };
      expect(() => validateConfig(config)).toThrow("Expressions are not supported");
      writeFileSync(join(f.bundle, "main.tf.json"), JSON.stringify(config));
      expect(() => readBundle(f.bundle)).toThrow("Expressions are not supported");
    }
    expect(f.calls).toHaveLength(0);
  });
  test("interrupted apply, CLI configuration and mirror/state symlinks fail closed", () => {
    const f = setup();
    expect(f.prepare()).toBe(0);
    writeFileSync(
      join(f.directory(), "journal.json"),
      JSON.stringify({ ...f.journal(), phase: "applying" }),
    );
    expect(f.run("plan")).toBe(1);
    expect(f.run("apply", ["--approve-plan", "anything"])).toBe(1);
    expect(f.calls).toHaveLength(0);
    const g = setup();
    expect(g.prepare()).toBe(0);
    writeFileSync(join(g.directory(), "terraform.rc"), "provider_installation { direct {} }");
    expect(g.run("plan")).toBe(1);
    expect(g.calls).toHaveLength(0);
    const h = setup(true);
    expect(h.prepare()).toBe(0);
    symlinkSync(h.binary, join(h.directory(), "bundle", "mirror", "extra"));
    expect(h.run("plan")).toBe(1);
    const i = setup();
    expect(i.prepare()).toBe(0);
    symlinkSync(i.binary, join(i.directory(), "work", "terraform.tfstate"));
    expect(i.run("plan")).toBe(1);
    expect(i.calls).toHaveLength(0);
  });
  test("plan failure is persisted without invoking apply; prepared scope is immutable", () => {
    const f = setup();
    expect(f.prepare()).toBe(0);
    expect(f.prepare()).toBe(1);
    expect(f.run("plan", [], () => 1)).toBe(1);
    expect(f.journal().phase).toBe("plan_failed");
    expect(f.run("apply", ["--approve-plan", "anything"])).toBe(1);
    expect(f.run("plan")).toBe(0);
  });
  test("apply rechecks provider cache via readonly init and blocks apply on checksum failure", () => {
    const f = setup(true);
    expect(f.prepare()).toBe(0);
    expect(f.run("plan")).toBe(0);
    const commands: string[][] = [];
    const failInit: TerraformExecutor = (_binary, argv) => {
      commands.push(argv);
      return 1;
    };
    expect(f.run("apply", ["--approve-plan", f.journal().planSha], failInit)).toBe(1);
    expect(commands).toEqual([["init", "-input=false", "-lockfile=readonly", "-no-color"]]);
    expect(f.journal().phase).toBe("apply_failed");
    expect(f.run("apply", ["--approve-plan", f.journal().planSha])).toBe(1);
    const g = setup();
    expect(g.prepare()).toBe(0);
    expect(g.run("plan")).toBe(0);
    expect(g.run("apply", ["--approve-plan", g.journal().planSha])).toBe(0);
    expect(g.calls.slice(-2).map((argv) => argv[0])).toEqual(["init", "apply"]);
  });
  test("separate generations do not share state", () => {
    const f = setup();
    f.prepare();
    const other = [...f.scope];
    other[other.length - 1] = "2";
    expect(
      runTerraformCommand(
        [
          "prepare",
          ...other,
          "--bundle",
          f.bundle,
          "--reviewed-sha",
          readBundle(f.bundle).digest,
          "--binary",
          f.binary,
          "--binary-sha",
          sha256(readFileSync(f.binary)),
        ],
        (line) => f.lines.push(line),
      ),
    ).toBe(0);
    expect(readdirSync(f.root)).toHaveLength(2);
  });
});
