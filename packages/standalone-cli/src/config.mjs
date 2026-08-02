import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROLE_ARN_RE = /^arn:(aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/(.+)$/;

export function configDirectory(env = process.env, platform = process.platform) {
  if (env.TENKACLOUD_CONFIG_DIR) return path.resolve(env.TENKACLOUD_CONFIG_DIR);
  if (platform === "win32") {
    return path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "TenkaCloud");
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "tenkacloud");
}

export function configPath(env = process.env, platform = process.platform) {
  return path.join(configDirectory(env, platform), "config.json");
}

export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TenkaCloud configuration must be a JSON object.");
  }
  const required = [
    "problemsDirectory",
    "awsAccountId",
    "awsRegion",
    "environment",
    "allowedRoleArn",
  ];
  for (const key of required) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      throw new Error(`TenkaCloud configuration field '${key}' is required.`);
    }
  }
  if (!/^\d{12}$/.test(value.awsAccountId)) {
    throw new Error("awsAccountId must be a 12-digit AWS account ID.");
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value.awsRegion)) {
    throw new Error("awsRegion is not a valid AWS region name.");
  }
  const allowedRoleArn = value.allowedRoleArn.trim();
  const roleMatch = ROLE_ARN_RE.exec(allowedRoleArn);
  if (!roleMatch) {
    throw new Error("allowedRoleArn must be an IAM role ARN.");
  }
  if (roleMatch[2] !== value.awsAccountId) {
    throw new Error("allowedRoleArn must belong to awsAccountId.");
  }
  return {
    problemsDirectory: path.resolve(value.problemsDirectory),
    awsAccountId: value.awsAccountId,
    awsRegion: value.awsRegion,
    environment: value.environment,
    allowedRoleArn,
  };
}

export async function loadConfig(options = {}) {
  const file = options.file ?? configPath(options.env, options.platform);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`TenkaCloud is not initialized. Run 'tenkacloud init' first.\nExpected: ${file}`);
    }
    throw error;
  }
  try {
    return validateConfig(JSON.parse(text));
  } catch (error) {
    throw new Error(`Invalid TenkaCloud configuration at ${file}: ${error.message}`);
  }
}

export async function saveConfig(config, options = {}) {
  const normalized = validateConfig(config);
  const file = options.file ?? configPath(options.env, options.platform);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return file;
}
