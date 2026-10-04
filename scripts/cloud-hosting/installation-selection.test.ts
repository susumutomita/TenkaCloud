import { describe, expect, it } from "bun:test";
import { cloudStackNames } from "../../infrastructure/lib/cloud-hosting/stack-names";
import { selectCloudInstallation } from "./installation-selection";
import { assertOwnedStack, expectedStackTags } from "./stack-check";

const account = "123456789012";
const region = "ap-northeast-1";
const environment = "staging";
function fixture(present: readonly string[]) {
  const recorded: string[][] = [];
  const run = async (args: readonly string[]) => {
    recorded.push([...args]);
    const name = args[args.indexOf("--stack-name") + 1] ?? "";
    return present.includes(name)
      ? {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            StackName: name,
            StackId: `arn:aws:cloudformation:${region}:${account}:stack/${name}/synthetic-id`,
            StackStatus: "CREATE_COMPLETE",
          }),
        }
      : { code: 1, stdout: "", stderr: `(ValidationError) Stack with id ${name} does not exist` };
  };
  return { recorded, run, options: { account, region, environment, run } };
}
const original = cloudStackNames(environment, "lite");
const cloud = cloudStackNames(environment, "cloud");
describe("physical installation discovery before mutation", () => {
  it.each([
    { present: [], expected: "cloud" },
    { present: [original.app, original.backend], expected: "lite" },
    { present: [cloud.app, cloud.backend], expected: "cloud" },
    { present: [original.backend], expected: "lite" },
    { present: [cloud.app], expected: "cloud" },
    { present: [cloud.backend], expected: "cloud" },
  ])("preserves the discovered installation: %j", async ({ present, expected }) => {
    const f = fixture(present);
    expect(await selectCloudInstallation(f.options)).toBe(expected);
    expect(f.recorded).toHaveLength(4);
    expect(f.recorded.every((args) => args[1] === "describe-stacks")).toBe(true);
  });
  it("does not choose one installation when both physical layouts exist", async () => {
    const f = fixture([original.app, cloud.backend]);
    await expect(selectCloudInstallation(f.options)).rejects.toThrow(
      "Both tenkacloud-lite and tenkacloud-cloud",
    );
    expect(f.recorded.every((args) => args[1] === "describe-stacks")).toBe(true);
  });
  it.each(["lite", "cloud"])(
    "allows an explicit bounded operator selection: %s",
    async (explicitLayout) => {
      const f = fixture([original.app, cloud.app]);
      expect(await selectCloudInstallation({ ...f.options, explicitLayout })).toBe(explicitLayout);
      expect(f.recorded).toEqual([]);
    },
  );
  it("rejects arbitrary target names before even a read", async () => {
    const f = fixture([]);
    await expect(
      selectCloudInstallation({ ...f.options, explicitLayout: "someone-else" }),
    ).rejects.toThrow("must be lite or cloud");
    expect(f.recorded).toEqual([]);
  });
  it("does not interpret access denial as a new installation", async () => {
    await expect(
      selectCloudInstallation({
        account,
        region,
        environment,
        run: async () => ({ code: 1, stdout: "", stderr: "AccessDenied" }),
      }),
    ).rejects.toThrow("AccessDenied");
  });
  it("rejects a mismatched account in a discovered stack", async () => {
    const f = fixture([original.app]);
    await expect(
      selectCloudInstallation({
        ...f.options,
        run: async (args) => {
          const result = await f.run(args);
          return { ...result, stdout: result.stdout.replace(account, "999999999999") };
        },
      }),
    ).rejects.toThrow("does not match");
  });
});

describe("existing physical ownership tags", () => {
  it.each(["lite", "cloud"] as const)(
    "accepts the original %s tags without requiring a newly invented marker",
    (layout) => {
      const name = cloudStackNames(environment, layout).app;
      const arn = `arn:aws:cloudformation:${region}:${account}:stack/${name}/synthetic-id`;
      const tags: Readonly<Record<string, string>> =
        layout === "lite"
          ? { Project: "TenkaCloud", Environment: environment }
          : { TenkaCloudProject: "cloud-hosting", Environment: environment };
      expect(
        assertOwnedStack(
          JSON.stringify({
            StackId: arn,
            StackName: name,
            Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          }),
          { account, region, environment, name },
        ),
      ).toBe(arn);
      expect(expectedStackTags(environment, arn)).toEqual(tags);
    },
  );
  it("rejects an unrelated stack regardless of matching tags", () => {
    expect(() => expectedStackTags(environment, "unrelated")).toThrow("Unknown installation");
  });
});
