#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import * as dotenv from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger, format, transports, type Logger } from "winston";
import { processConfigFile, parseConfig, validateConfig } from "../lib/utils/config-loader";
import type { Config } from "../lib/config/config-interface";
import { ControlPlaneStack } from "../lib/control-plane";
import { AppPlaneStack } from "../lib/app-plane";
import { ProblemDeployPlaneStack } from "../lib/problem-deploy-plane";
import { AwsSolutionsChecks } from "cdk-nag";

const logger: Logger = createLogger({
  level: "info",
  format: format.combine(
    format.colorize(),
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level}: ${message}`),
  ),
  transports: [new transports.Console()],
});

/**
 * Load environment variables from .env file if present.
 */
function loadEnvironmentVariables(envFilePath: string): void {
  if (fs.existsSync(envFilePath)) {
    dotenv.config({ path: envFilePath });
    logger.info(`Loaded environment variables from ${envFilePath}`);
  } else {
    logger.warn(`.env file not found at ${envFilePath}. Using process.env only.`);
  }
}

function main(): void {
  const app = new cdk.App();

  // Determine environment from CDK context (default: development)
  const environment = app.node.tryGetContext("environment") ?? "development";
  logger.info(`Deploying environment: ${environment}`);

  // Resolve environment directory
  const envDir = path.resolve(__dirname, `../environments/${environment}`);
  logger.info(`Environment directory: ${envDir}`);

  // Load .env
  const envFilePath = path.resolve(envDir, ".env");
  loadEnvironmentVariables(envFilePath);

  // Load, parse, and validate config.json
  const configPath = path.resolve(envDir, "config.json");
  let config: Config;
  try {
    const configContent = processConfigFile(configPath, process.env, logger);
    config = parseConfig(configContent, logger);
    validateConfig(config, logger);
  } catch (error) {
    logger.error(`Config error: ${(error as Error).message}`);
    process.exit(1);
  }

  const env = {
    account: config.accountId,
    region: config.region,
  };
  logger.info(`Target: account=${env.account}, region=${env.region}`);

  // 1. Control Plane: Tenant management API + Cognito auth + EventBridge bus
  logger.info("Initializing ControlPlaneStack...");
  const controlPlaneStack = new ControlPlaneStack(app, "ControlPlaneStack", {
    env,
    systemAdminEmail: config.controlPlaneConfig.systemAdminEmail,
    systemAdminRoleName: config.controlPlaneConfig.systemAdminRoleName,
    enableAdvancedSecurityMode: config.controlPlaneConfig.enableAdvancedSecurityMode,
    setAPIGWScopes: config.controlPlaneConfig.setAPIGWScopes,
    disableAPILogging: config.controlPlaneConfig.disableAPILogging,
  });

  // 2. Application Plane Layer 1: Tenant provisioning (onboarding / offboarding)
  logger.info("Initializing AppPlaneStack...");
  new AppPlaneStack(app, "AppPlaneStack", {
    env,
    eventManager: controlPlaneStack.eventManager,
    appName: config.appName,
    dynamoDbTablePrefix: config.appPlaneConfig.dynamoDbTablePrefix,
    cfnStackPrefix: config.appPlaneConfig.cfnStackPrefix,
  });

  // 3. Application Plane Layer 2: Problem deployment engine (custom event-driven)
  logger.info("Initializing ProblemDeployPlaneStack...");
  new ProblemDeployPlaneStack(app, "ProblemDeployPlaneStack", {
    env,
    eventManager: controlPlaneStack.eventManager,
    appName: config.appName,
    targetRoleName: config.problemDeployConfig.targetRoleName,
  });

  // Enable cdk-nag AWS Solutions checks on all stacks
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

  logger.info("CDK app initialized successfully (cdk-nag enabled)");
}

main();
