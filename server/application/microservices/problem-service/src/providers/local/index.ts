/**
 * Local Cloud Provider Implementation
 *
 * ローカル開発環境用のプロバイダー実装（Docker Compose ベース）
 */

import { execFile } from "node:child_process";
import { createServer } from "node:net";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import type {
	CloudCredentials,
	CloudProvider,
	DeploymentResult,
	Problem,
	StackStatus,
} from "../../types";
import type {
	AccountInfo,
	CleanupOptions,
	CleanupResult,
	DeployStackOptions,
	ICloudProvider,
	RegionInfo,
} from "../interface";
import { resolveProblemAssetPath } from "../problem-assets";

const execFileAsync = promisify(execFile);

/**
 * ローカル環境の擬似リージョン
 */
const LOCAL_REGIONS: RegionInfo[] = [
	{ code: "local", name: "Local Development", available: true },
	{ code: "docker", name: "Docker Compose", available: true },
];

/**
 * LocalCloudProvider
 *
 * Docker Compose を使用したローカル開発環境用プロバイダー
 */
export class LocalCloudProvider implements ICloudProvider {
	readonly provider: CloudProvider = "local";
	readonly displayName = "Local Development";

	private deployedStacks: Map<string, LocalStack> = new Map();

	/**
	 * 認証情報の検証（ローカルでは常に成功）
	 */
	async validateCredentials(credentials: CloudCredentials): Promise<boolean> {
		return credentials.provider === "local";
	}

	/**
	 * 問題スタックのデプロイ（Docker Compose）
	 */
	async deployStack(
		problem: Problem,
		_credentials: CloudCredentials,
		options: DeployStackOptions,
	): Promise<DeploymentResult> {
		const startedAt = new Date();
		let composePath = "";
		let projectName = "";
		let environment: Record<string, string> = {};

		try {
			const template = problem.deployment.templates.local;
			if (!template?.path) {
				throw new Error(
					"Local deployment template not found for this problem",
				);
			}

			composePath = await resolveProblemAssetPath(template.path);
			const problemRoot = nodePath.resolve(nodePath.dirname(composePath), "..");
			const ports = await this.allocatePorts();
			const stackId = `local-${options.stackName}`;
			projectName = this.getProjectName(options.stackName);
			environment = this.buildComposeEnvironment(
				template.parameters ?? {},
				options.parameters ?? {},
				problemRoot,
				options.region,
				options.stackName,
				ports,
			);

			if (!options.dryRun) {
				await this.runDockerCompose("up", composePath, projectName, environment);
				await this.waitForServicesReady(composePath, projectName, environment);
			}

			const stack: LocalStack = {
				stackId,
				stackName: options.stackName,
				problemId: problem.id,
				projectName,
				status: options.dryRun ? "CREATE_COMPLETE" : "CREATE_COMPLETE",
				outputs: {
					ApiUrl: `http://localhost:${ports.apiPort}`,
					FrontendUrl: `http://localhost:${ports.frontendPort}`,
					ServiceUrl: `http://localhost:${ports.frontendPort}`,
					DashboardUrl: `http://localhost:${ports.frontendPort}`,
				},
				createdAt: new Date(),
				composePath,
				environment,
			};
			this.deployedStacks.set(options.stackName, stack);

			return {
				success: true,
				stackId,
				stackName: options.stackName,
				outputs: stack.outputs,
				startedAt,
				completedAt: new Date(),
			};
		} catch (error) {
			if (composePath && projectName) {
				try {
					await this.runDockerCompose(
						"down",
						composePath,
						projectName,
						environment,
					);
				} catch {
					// Cleanup failure should not hide the original error.
				}
			}

			return {
				success: false,
				stackName: options.stackName,
				error: error instanceof Error ? error.message : String(error),
				startedAt,
				completedAt: new Date(),
			};
		}
	}

	/**
	 * スタックのステータス取得
	 */
	async getStackStatus(
		stackName: string,
		_credentials: CloudCredentials,
	): Promise<StackStatus | null> {
		const stack = this.deployedStacks.get(stackName);
		if (!stack) {
			return null;
		}

		return {
			stackName: stack.stackName,
			stackId: stack.stackId,
			status: stack.status,
			outputs: stack.outputs,
			lastUpdatedTime: stack.createdAt,
		};
	}

	/**
	 * スタックの削除
	 */
	async deleteStack(
		stackName: string,
		_credentials: CloudCredentials,
	): Promise<DeploymentResult> {
		const startedAt = new Date();

		try {
			const stack = this.deployedStacks.get(stackName);
			if (!stack) {
				return {
					success: false,
					stackName,
					error: `Stack ${stackName} not found`,
					startedAt,
					completedAt: new Date(),
				};
			}

			await this.runDockerCompose(
				"down",
				stack.composePath,
				stack.projectName,
				stack.environment,
			);
			this.deployedStacks.delete(stackName);

			return {
				success: true,
				stackName,
				startedAt,
				completedAt: new Date(),
			};
		} catch (error) {
			return {
				success: false,
				stackName,
				error: error instanceof Error ? error.message : String(error),
				startedAt,
				completedAt: new Date(),
			};
		}
	}

	/**
	 * スタック出力の取得
	 */
	async getStackOutputs(
		stackName: string,
		_credentials: CloudCredentials,
	): Promise<Record<string, string>> {
		const stack = this.deployedStacks.get(stackName);
		return stack?.outputs || {};
	}

	/**
	 * 静的ファイルのアップロード（ローカルではファイル参照）
	 */
	async uploadStaticFiles(
		localPath: string,
		_remotePath: string,
		_credentials: CloudCredentials,
	): Promise<string> {
		return `file://${localPath}`;
	}

	/**
	 * リソースのクリーンアップ
	 */
	async cleanupResources(
		_accountId: string,
		credentials: CloudCredentials,
		options?: CleanupOptions,
	): Promise<CleanupResult> {
		const deletedResources: CleanupResult["deletedResources"] = [];
		const failedResources: CleanupResult["failedResources"] = [];

		for (const [stackName, stack] of this.deployedStacks) {
			try {
				if (!options?.dryRun) {
					await this.deleteStack(stackName, credentials);
				}
				deletedResources.push({
					type: "Docker::Compose",
					id: stack.stackId,
					name: stackName,
					region: "local",
				});
			} catch (error) {
				failedResources.push({
					type: "Docker::Compose",
					id: stack.stackId,
					name: stackName,
					region: "local",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return {
			success: failedResources.length === 0,
			deletedResources,
			failedResources,
			totalDeleted: deletedResources.length,
			totalFailed: failedResources.length,
			dryRun: options?.dryRun ?? false,
		};
	}

	/**
	 * 利用可能なリージョン一覧の取得
	 */
	async getAvailableRegions(): Promise<RegionInfo[]> {
		return LOCAL_REGIONS;
	}

	/**
	 * アカウント情報の取得
	 */
	async getAccountInfo(credentials: CloudCredentials): Promise<AccountInfo> {
		return {
			accountId: credentials.accountId || "local-dev",
			accountName: "Local Development",
			provider: "local",
		};
	}

	private buildComposeEnvironment(
		templateParameters: Record<string, string>,
		overrideParameters: Record<string, string>,
		problemRoot: string,
		region: string,
		stackName: string,
		ports: LocalPorts,
	): Record<string, string> {
		return {
			...Object.fromEntries(
				Object.entries(templateParameters).map(([key, value]) => [
					key,
					this.sanitizeEnvironmentValue(String(value)),
				]),
			),
			...Object.fromEntries(
				Object.entries(overrideParameters).map(([key, value]) => [
					key,
					this.sanitizeEnvironmentValue(String(value)),
				]),
			),
			PROBLEM_ROOT: this.sanitizeEnvironmentValue(problemRoot),
			REGION: this.sanitizeEnvironmentValue(region),
			STACK_NAME: this.sanitizeEnvironmentValue(stackName),
			API_PORT: String(ports.apiPort),
			FRONTEND_PORT: String(ports.frontendPort),
			DB_EXPOSE_PORT: String(ports.dbPort),
		};
	}

	private async runDockerCompose(
		command: "up" | "down",
		composePath: string,
		projectName: string,
		environment: Record<string, string>,
	): Promise<void> {
		const args =
			command === "up"
				? [
						"compose",
						"-f",
						composePath,
						"-p",
						projectName,
						"up",
						"-d",
						"--remove-orphans",
					]
				: [
						"compose",
						"-f",
						composePath,
						"-p",
						projectName,
						"down",
						"--remove-orphans",
						"-v",
					];

		try {
			await execFileAsync("docker", args, {
				env: {
					...process.env,
					...environment,
				},
			});
		} catch (error) {
			const commandError = error as {
				stderr?: string;
				stdout?: string;
				message?: string;
			};
			const details = commandError.stderr || commandError.stdout || commandError.message;
			throw new Error(`docker compose ${command} failed: ${details}`);
		}
	}

	private async waitForServicesReady(
		composePath: string,
		projectName: string,
		environment: Record<string, string>,
		timeoutMs = 30_000,
	): Promise<void> {
		const expectedServices = await this.getExpectedServices(
			composePath,
			projectName,
			environment,
		);
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			const runningServices = await this.getComposeServicesByStatus(
				composePath,
				projectName,
				environment,
				"running",
			);
			const exitedServices = await this.getComposeServicesByStatus(
				composePath,
				projectName,
				environment,
				"exited",
			);

			if (exitedServices.length > 0) {
				throw new Error(
					`docker compose services exited unexpectedly: ${exitedServices.join(", ")}`,
				);
			}

			if (expectedServices.every((service) => runningServices.includes(service))) {
				return;
			}

			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		throw new Error(
			`docker compose services did not become ready: ${expectedServices.join(", ")}`,
		);
	}

	private async getExpectedServices(
		composePath: string,
		projectName: string,
		environment: Record<string, string>,
	): Promise<string[]> {
		const { stdout } = await execFileAsync(
			"docker",
			["compose", "-f", composePath, "-p", projectName, "config", "--services"],
			{
				env: {
					...process.env,
					...environment,
				},
			},
		);
		return stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	}

	private async getComposeServicesByStatus(
		composePath: string,
		projectName: string,
		environment: Record<string, string>,
		status: "running" | "exited",
	): Promise<string[]> {
		const { stdout } = await execFileAsync(
			"docker",
			[
				"compose",
				"-f",
				composePath,
				"-p",
				projectName,
				"ps",
				"--services",
				"--status",
				status,
			],
			{
				env: {
					...process.env,
					...environment,
				},
			},
		);
		return stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	}

	private sanitizeEnvironmentValue(value: string): string {
		return value.replace(/[\r\n\x00-\x1F\x7F]/g, "");
	}

	private async allocatePorts(): Promise<LocalPorts> {
		const reservedPorts = await this.listDockerPublishedPorts();
		const frontendPort = await this.findAvailablePort(13080, reservedPorts);
		reservedPorts.add(frontendPort);
		const apiPort = await this.findAvailablePort(18080, reservedPorts);
		reservedPorts.add(apiPort);
		const dbPort = await this.findAvailablePort(3306, reservedPorts);
		return {
			apiPort,
			frontendPort,
			dbPort,
		};
	}

	private async findAvailablePort(
		basePort: number,
		reservedPorts: Set<number> = new Set(),
	): Promise<number> {
		for (let offset = 0; offset < 100; offset += 1) {
			const candidate = basePort + offset * 10;
			if (
				!reservedPorts.has(candidate) &&
				(await this.isPortAvailable(candidate))
			) {
				return candidate;
			}
		}

		throw new Error(`No available local port found for base port ${basePort}`);
	}

	private async listDockerPublishedPorts(): Promise<Set<number>> {
		try {
			const { stdout } = await execFileAsync("docker", [
				"ps",
				"--format",
				"{{.Ports}}",
			]);
			const ports = new Set<number>();
			for (const line of stdout.split("\n")) {
				const matches = line.matchAll(/:(\d+)->/g);
				for (const match of matches) {
					const port = Number(match[1]);
					if (Number.isFinite(port)) {
						ports.add(port);
					}
				}
			}
			return ports;
		} catch {
			return new Set();
		}
	}

	private async isPortAvailable(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const server = createServer();

			server.once("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "EPERM") {
					resolve(true);
					return;
				}
				resolve(false);
			});

			server.once("listening", () => {
				server.close(() => resolve(true));
			});

			server.listen(port, "127.0.0.1");
		});
	}

	private getProjectName(stackName: string): string {
		return `tenkacloud-${stackName}`
			.toLowerCase()
			.replace(/[^a-z0-9_-]/g, "-")
			.slice(0, 63);
	}
}

interface LocalStack {
	stackId: string;
	stackName: string;
	problemId: string;
	projectName: string;
	status: StackStatus["status"];
	outputs: Record<string, string>;
	createdAt: Date;
	composePath: string;
	environment: Record<string, string>;
}

interface LocalPorts {
	apiPort: number;
	frontendPort: number;
	dbPort: number;
}

let localProviderInstance: LocalCloudProvider | null = null;

/**
 * ローカルプロバイダーのシングルトンインスタンスを取得
 */
export function getLocalProvider(): LocalCloudProvider {
	if (!localProviderInstance) {
		localProviderInstance = new LocalCloudProvider();
	}
	return localProviderInstance;
}
