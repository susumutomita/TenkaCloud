#!/usr/bin/env bun
/** Emit only source-bundle retention settings, without loading unrelated secrets. */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  buildSourceBundleLifecyclePolicy,
  type SourceBundleConfig,
} from "../../infrastructure/lib/source-bundle/lifecycle-policy";

const env = process.argv[2] ?? process.env.ENV ?? "development";
if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(env)) {
  throw new Error("Invalid environment name");
}
const configPath = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "infrastructure",
  "environments",
  env,
  "config.json",
);
const rawConfig = existsSync(configPath)
  ? (JSON.parse(readFileSync(configPath, "utf-8")) as { sourceBundleConfig?: SourceBundleConfig })
  : {};

// Expand placeholders only inside the sourceBundleConfig subtree. Other config
// values may contain unset credentials that source preparation never needs.
function expandPlaceholders(raw: string): string {
  return raw.replace(/\$\{([^}]+)\}/g, (_, expression: string) => {
    const [rawVarName, ...defaultParts] = expression.split(":-");
    const varName = rawVarName.trim();
    const defaultValue = defaultParts.length > 0 ? defaultParts.join(":-") : undefined;
    const value = process.env[varName];
    if (value !== undefined && value !== "") return JSON.stringify(value).slice(1, -1);
    if (defaultValue !== undefined) return JSON.stringify(defaultValue).slice(1, -1);
    throw new Error(`Environment variable ${varName} is not defined and no default provided`);
  });
}

const sourceBundleConfig =
  rawConfig.sourceBundleConfig === undefined
    ? {}
    : (JSON.parse(
        expandPlaceholders(JSON.stringify(rawConfig.sourceBundleConfig)),
      ) as SourceBundleConfig);
const policy = buildSourceBundleLifecyclePolicy({
  ...sourceBundleConfig,
  ...(process.env.SOURCE_BUNDLE_KEEP_VERSIONS
    ? { keepNoncurrentVersions: process.env.SOURCE_BUNDLE_KEEP_VERSIONS }
    : {}),
  ...(process.env.SOURCE_BUNDLE_EXPIRE_DAYS
    ? { expireAfterDays: process.env.SOURCE_BUNDLE_EXPIRE_DAYS }
    : {}),
});
console.log(JSON.stringify(policy));
