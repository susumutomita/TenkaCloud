import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

test("native VPN acceptance is an exclusive, bounded manual GitHub VM with no credential persistence", () => {
  const source = readFileSync(
    new URL("../../.github/workflows/local-host-rehearsal.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(source);
  expect(workflow.on.workflow_dispatch.inputs.vpn_acceptance).toMatchObject({
    type: "boolean",
    default: false,
  });
  expect(workflow.jobs["local-host"].if).toBe(
    "github.event_name != 'workflow_dispatch' || !inputs.vpn_acceptance",
  );
  const job = workflow.jobs["vpn-acceptance"];
  expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.vpn_acceptance == true");
  expect(job["runs-on"]).toBe("ubuntu-24.04");
  expect(job["timeout-minutes"]).toBe(60);
  expect(job.permissions).toEqual({ contents: "read" });
  expect(job.strategy).toBeUndefined();
  expect(job.services).toBeUndefined();
  expect(
    job.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"))?.with[
      "persist-credentials"
    ],
  ).toBe(false);
  expect(
    job.steps.filter((step: { uses?: string }) =>
      /(?:cache|upload-artifact)/u.test(step.uses ?? ""),
    ),
  ).toHaveLength(0);
  expect(JSON.stringify(job)).not.toMatch(/secrets\.|id-token|--publish|--privileged/u);
  const cleanup = job.steps.find((step: { run?: string }) =>
    step.run?.includes("vpn-acceptance.ts --cleanup"),
  );
  expect(cleanup?.if).toBe("always()");
  expect(
    job.steps.reduce(
      (total: number, step: Record<string, unknown>) =>
        total + Number(step["timeout-minutes"] ?? 0),
      0,
    ),
  ).toBeLessThan(60);
  for (const id of ["normal-docker", "normal-browser", "vpn"]) {
    expect(job.steps.find((step: { id?: string }) => step.id === id)?.["continue-on-error"]).toBe(
      true,
    );
  }
  const report = job.steps.find(
    (step: { name?: string }) => step.name === "Report separate normal-flow and VPN outcomes",
  );
  expect(report.if).toBe("always()");
  expect(report.run).toContain('[[ "$outcome" == success ]] || exit 1');
});

test("VM preparation has an execution fence, exact native Docker pin and no route/table resets", () => {
  const setup = readFileSync(
    new URL("../local-host/tests/vpn-acceptance-setup.sh", import.meta.url),
    "utf8",
  );
  for (const guard of [
    "github-ephemeral-v1",
    "GITHUB_ACTIONS",
    "workflow_dispatch",
    "github-hosted",
    "ubuntu24",
    "$EUID",
  ])
    expect(setup).toContain(guard);
  expect(setup.indexOf("exit 1")).toBeLessThan(setup.indexOf("apt-get update"));
  expect(setup).toContain("docker-ce='5:28.4.0-1~ubuntu.24.04~noble'");
  expect(setup).toContain("https://download.docker.com/linux/ubuntu/gpg");
  expect(setup).toContain("net.bridge.bridge-nf-call-ip6tables=1");
  expect(setup).not.toMatch(
    /(?:iptables|ip6tables)\s+(?:-F|-X|--flush)|\broute\s+(?:flush|del)|\bsysctl\s+-p/u,
  );
});
