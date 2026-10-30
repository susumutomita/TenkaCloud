import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
  if?: string;
}
interface Job {
  needs?: string[];
  if?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
  "continue-on-error"?: boolean;
}
const root = resolve(import.meta.dirname, "../..");
const workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};

test("the required ci gate rejects failed, cancelled or skipped lockfile verification", () => {
  const final = workflow.jobs.ci;
  expect(final.if).toBe("always()");
  expect(final.needs).toContain("actions-lock");
  const script = final.steps.find((step) => step.run)?.run;
  expect(script).toContain("needs.actions-lock.result");
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const expanded = script?.replace(/\$\{\{ needs\.([\w-]+)\.result \}\}/gu, (_, job: string) =>
      job === "actions-lock" ? result : "success",
    );
    const output = spawnSync("/bin/bash", ["-e", "-c", expanded ?? ""], { encoding: "utf8" });
    expect(output.status).toBe(result === "success" ? 0 : 1);
    if (result !== "success") expect(output.stderr).toContain(`actions-lock(${result})`);
  }
});

test("lockfile verification has read-only repository access and cannot silently repair or skip dependencies", () => {
  const job = workflow.jobs["actions-lock"];
  expect(job.permissions).toEqual({ contents: "read" });
  expect(job["continue-on-error"]).not.toBe(true);
  expect(job.if).toBeUndefined();
  expect(job.env?.GH_TOKEN).toMatch(/^\$\{\{ github\.token \}\}$/u);
  const install = job.steps.find((step) => step.run?.startsWith("gh extension install"));
  expect(install?.run).toMatch(/github\/gh-actions-lock --pin v\d+\.\d+\.\d+$/u);
  const verify = job.steps.find((step) => step.run?.startsWith("gh actions-lock"));
  expect(verify?.run).toBe("gh actions-lock --verify --no-interactive");
  expect(verify?.["continue-on-error"]).not.toBe(true);
  expect(verify?.if).toBeUndefined();
  expect(job.steps.indexOf(install as Step)).toBeLessThan(job.steps.indexOf(verify as Step));
});

test("same-repository composite definitions and the installed source use the same workflow revision", () => {
  let consumers = 0;
  for (const job of Object.values(workflow.jobs)) {
    const local = job.steps.findIndex((step) => step.uses === "$/.github/actions/bun-install");
    if (local < 0) continue;
    consumers++;
    const checkout = job.steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(checkout).toBeLessThan(local);
    // No alternate repository, ref or path: checkout's default revision matches this workflow.
    for (const key of ["repository", "ref", "path"])
      expect(job.steps[checkout]?.with?.[key]).toBeUndefined();
  }
  expect(consumers).toBeGreaterThan(0);
  expect(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")).not.toContain(
    "uses: ./.github/actions/",
  );
});
