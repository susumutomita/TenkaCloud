import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cloudStackNames } from "../../infrastructure/lib/cloud-hosting/stack-names";

const SAMPLE_ENVIRONMENTS = ["development", "staging", "production"];

function selectedEnvironment(env: NodeJS.ProcessEnv): string {
  const selectors = [env.ENV, env.CDK_PARAM_ENVIRONMENT].filter((value) => value !== undefined);
  for (const value of selectors) cloudStackNames(value);
  if (new Set(selectors).size > 1)
    throw new Error("ENV and CDK_PARAM_ENVIRONMENT must select the same cloud environment.");
  return selectors[0] ?? "development";
}

export function cloudEnvironmentInstructions(environment: string): string {
  const directory = `infrastructure/environments/${environment}`;
  const configuration = SAMPLE_ENVIRONMENTS.includes(environment)
    ? `Configure ${directory}/.env using ${directory}/.env.example (copy only if .env does not exist)`
    : `Configure exported variables or ${directory}/.env for this custom environment`;
  return `${configuration}, then run make deploy ENV=${environment}. Review first-account setup with make deploy ENV=${environment} CLOUD_ARGS="--show-setup" before --setup.`;
}

function parseValue(raw: string, location: string): string {
  if (!raw.startsWith('"') && !raw.startsWith("'")) {
    const comment = raw.search(/(?:^|\s)#/u);
    return (comment < 0 ? raw : raw.slice(0, comment)).trim();
  }
  const quoted = /^(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/u.exec(raw);
  if (!quoted) throw new Error(`Invalid single-line quoted value in ${location}.`);
  return quoted[1] ?? quoted[2] ?? "";
}

/** Deliberately small, single-line dotenv format: never shell execution or interpolation. */
function parseEnvironmentFile(contents: string, path: string): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {};
  for (const [index, source] of contents.split(/\r?\n/u).entries()) {
    const line = source.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = line
      .slice(0, separator)
      .replace(/^export\s+/u, "")
      .trim();
    if (separator < 0 || !/^[A-Za-z_]\w*$/u.test(key) || Object.hasOwn(values, key))
      throw new Error(`Invalid or duplicate environment assignment in ${path}:${index + 1}.`);
    const raw = line.slice(separator + 1).trim();
    const value = parseValue(raw, `${path}:${index + 1}`);
    Object.defineProperty(values, key, { value, enumerable: true, configurable: true });
  }
  return values;
}

/** Read only the selected environment; never create or modify an operator's .env. */
export function loadCloudEnvironment(
  root: string,
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv & { ENV: string; CDK_PARAM_ENVIRONMENT: string } {
  const environment = selectedEnvironment(inherited);
  const path = join(root, "infrastructure", "environments", environment, ".env");
  let file: NodeJS.ProcessEnv = {};
  try {
    file = parseEnvironmentFile(readFileSync(path, "utf8"), path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  for (const selector of [file.ENV, file.CDK_PARAM_ENVIRONMENT]) {
    if (selector !== undefined && selector !== environment)
      throw new Error(`Environment selector in ${path} must match ${environment}.`);
  }
  // Exported variables win, including deliberate empty values. Undefined is absent.
  const overrides = Object.fromEntries(
    Object.entries(inherited).filter(([, value]) => value !== undefined),
  );
  return { ...file, ...overrides, ENV: environment, CDK_PARAM_ENVIRONMENT: environment };
}
