import Ajv from "ajv";
import addFormats from "ajv-formats";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "winston";
import type { Config } from "../config/config-interface";

/**
 * Load config.json from the environment directory and replace ${VAR} / ${VAR:-default} placeholders
 * with values from process.env.
 */
export function processConfigFile(configPath: string, secrets: NodeJS.ProcessEnv, logger: Logger): string {
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`Config file not found: ${configPath}`);
  }
  logger.info(`Read config file from ${configPath}`);

  let replacedCount = 0;
  const placeholderRegex = /\$\{([^}]+)\}/g;
  content = content.replace(placeholderRegex, (_match: string, expression: string): string => {
    const [rawVarName, ...defaultParts] = expression.split(":-");
    const varName = rawVarName.trim();
    const defaultValue = defaultParts.length > 0 ? defaultParts.join(":-") : undefined;

    const value = secrets[varName];

    if (value !== undefined && value !== "") {
      replacedCount++;
      return JSON.stringify(value).slice(1, -1);
    }

    if (defaultValue !== undefined) {
      replacedCount++;
      return JSON.stringify(defaultValue).slice(1, -1);
    }

    throw new Error(`Environment variable ${varName} is not defined and no default provided`);
  });

  logger.info(`Replaced ${replacedCount} placeholder(s) in config`);
  return content;
}

/**
 * Parse config JSON string into a typed Config object.
 */
export function parseConfig(configContent: string, logger: Logger): Config {
  try {
    const config: Config = JSON.parse(configContent);
    logger.info("Parsed config JSON successfully");
    return config;
  } catch (error) {
    logger.error(`Error parsing config.json: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Validate a Config object against the JSON Schema.
 */
export function validateConfig(config: Config, logger: Logger): void {
  const schemaPath = path.resolve(__dirname, "../config/config-schema.json");
  let schemaContent: string;
  try {
    schemaContent = fs.readFileSync(schemaPath, "utf-8");
  } catch {
    throw new Error(`JSON schema file not found: ${schemaPath}`);
  }

  const schema = JSON.parse(schemaContent);
  logger.info("Loaded JSON schema for validation");

  const ajv = new Ajv();
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(config);

  if (!valid) {
    logger.error("Config validation errors:");
    logger.error(JSON.stringify(validate.errors, null, 2));
    throw new Error("Invalid configuration file");
  }

  logger.info("Config validation passed");
}
