#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { configPath, loadConfig, saveConfig } from "./config.mjs";
import { validateProblemsDirectory } from "./problems.mjs";
import { assertAwsIdentity, runBundledCommand } from "./runtime.mjs";

function usage() {
  return [
    "TenkaCloud standalone CLI",
    "",
    "Usage:",
    "  tenkacloud init",
    "  tenkacloud doctor",
    "  tenkacloud problems validate",
    "  tenkacloud deploy",
    "  tenkacloud status",
    "  tenkacloud destroy",
    "  tenkacloud destroy --purge-retained-data",
    "  tenkacloud config path",
  ].join("\n");
}

async function promptInit() {
  const rl = createInterface({ input, output });
  try {
    const problemsDirectory = await rl.question("Problems directory: ");
    await validateProblemsDirectory(problemsDirectory.trim());
    const awsAccountId = await rl.question("AWS account ID (12 digits): ");
    const allowedRoleArn = await rl.question(
      "Allowed AWS operator role ARN (for example arn:aws:iam::123456789012:role/TenkaCloudOperator): ",
    );
    const awsRegion =
      (await rl.question("AWS region [ap-northeast-1]: ")).trim() || "ap-northeast-1";
    const environment =
      (await rl.question("Environment [development]: ")).trim() || "development";
    const file = await saveConfig({
      problemsDirectory: path.resolve(problemsDirectory.trim()),
      awsAccountId: awsAccountId.trim(),
      allowedRoleArn: allowedRoleArn.trim(),
      awsRegion,
      environment,
    });
    console.log(`Saved TenkaCloud configuration: ${file}`);
    console.log("Next: aws login && tenkacloud doctor && tenkacloud deploy");
    return 0;
  } finally {
    rl.close();
  }
}

async function doctor() {
  const config = await loadConfig();
  const problems = await validateProblemsDirectory(config.problemsDirectory);
  const identity = assertAwsIdentity(config);
  console.log(`Configuration: ${configPath()}`);
  console.log(`Problems: ${problems.problems.length} (${problems.root})`);
  console.log(`AWS account: ${identity.Account}`);
  console.log(`AWS role: ${identity.RoleArn}`);
  console.log(`AWS region: ${config.awsRegion}`);
  console.log("TenkaCloud is ready to deploy.");
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }
  if (command === "init") return promptInit();
  if (command === "doctor") return doctor();
  if (command === "config" && rest[0] === "path") {
    console.log(configPath());
    return 0;
  }
  if (command === "problems" && rest[0] === "validate") {
    const config = await loadConfig();
    const result = await validateProblemsDirectory(config.problemsDirectory);
    console.log(`Validated ${result.problems.length} problem(s) in ${result.root}`);
    return 0;
  }

  const config = await loadConfig();
  await validateProblemsDirectory(config.problemsDirectory);
  assertAwsIdentity(config);
  if (command === "deploy") return runBundledCommand(config, ["up"]);
  if (command === "status") return runBundledCommand(config, ["status"]);
  if (command === "destroy") {
    const args = ["down"];
    if (rest.includes("--purge-retained-data")) args.push("--purge-retained-data");
    return runBundledCommand(config, args);
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main(process.argv.slice(2))
  .then((status) => {
    process.exitCode = status;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
