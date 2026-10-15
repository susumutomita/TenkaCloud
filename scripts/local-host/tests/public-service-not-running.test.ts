import { expect, test } from "bun:test";
import { LinuxNetworkGuard } from "../linux-network-guard";
import { localNetworkPlan } from "../local-network";

test("a declared service with no running instance reports no endpoints without inspecting a container", () => {
  const plan = {
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic allocation; pure command oracle never connects
    ...localNetworkPlan("tch-stopped-publisher", { dmz: "10.241.0.0/28" }),
    services: { web: ["dmz"] },
  };
  const calls: string[][] = [];
  const guard = new LinuxNetworkGuard({
    platform: "linux",
    read: () => {
      throw new Error("Unexpected read");
    },
    exists: () => true,
    link: () => {
      throw new Error("Unexpected link");
    },
    run: ({ command, args }) => {
      calls.push([command, ...args]);
      if (command === "docker" && args[0] === "ps") return "";
      throw new Error(`Unexpected native command ${command} ${args.join(" ")}`);
    },
  });

  expect(guard.endpoints(plan, "web", 8080)).toEqual([]);
  expect(calls).toEqual([
    [
      "docker",
      "ps",
      "-q",
      "--filter",
      "label=com.docker.compose.project=tch-stopped-publisher",
      "--filter",
      "label=com.docker.compose.service=web",
    ],
  ]);
});
