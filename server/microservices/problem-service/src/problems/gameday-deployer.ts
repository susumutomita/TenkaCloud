/**
 * GameDay Deployer
 *
 * 問題を各チームの AWS アカウントへ並列デプロイするオーケストレーター。
 * ジョブ状態は DynamoDB で永続化する。
 */

import {
	encodeDeploymentKey,
	type ProblemDeployRequestedDetail,
} from "@tenkacloud/events";
import { getAWSProvider } from "../providers/aws";
import { getLocalProvider } from "../providers/local";
import {
	CompetitorAccountRepository,
	type CompetitorAccountWithMeta,
} from "../repositories/competitor-account-repository";
import {
	GameDayDeploymentJobRepository,
} from "../repositories/gameday-deployment-job-repository";
import type {
	CloudCredentials,
	DeploymentJob,
	DeploymentJobStatus,
	Problem,
} from "../types";
import type { DeployStackOptions } from "../providers/interface";
import { ProblemDeployPublisher } from "./deploy-publisher";

// ============================================================
// Core
// ============================================================

const jobRepo = new GameDayDeploymentJobRepository();
const accountRepo = new CompetitorAccountRepository();
// Force eventbridge delivery: inline mode is opt-in DI for tests, never
// auto-selected from env (that path lost its default runner when the broken
// lib/handlers/deploy-problem import was removed).
const deployPublisher = new ProblemDeployPublisher({ deliveryMode: "eventbridge" });

export function getGameDayDeploymentValidationError(
	problem: Pick<Problem, "type" | "deployment">,
	provider: "aws" | "local" = "aws",
): string | null {
	if (problem.type !== "gameday") {
		return "Team deployment is only supported for GameDay problems";
	}

	if (provider !== "aws" && provider !== "local") {
		return `Team deployment supports only aws/local providers, received: ${provider}`;
	}

	if (!problem.deployment.providers.includes(provider)) {
		return `Team deployment requires ${provider.toUpperCase()} deployment support`;
	}

	if (!problem.deployment.templates[provider]) {
		return `Team deployment requires ${provider === "aws" ? "an" : "a"} ${provider.toUpperCase()} deployment template`;
	}

	return null;
}

/**
 * 1 問題 × 全チームへのデプロイを開始する
 *
 * @returns 作成されたジョブ一覧
 */
export async function deployProblemToTeams(
	problem: Problem,
	eventId: string,
	tenantId?: string,
	concurrency = 10,
): Promise<DeploymentJob[]> {
	const accounts = await accountRepo.findByEventId(eventId);
	if (accounts.length === 0) {
		return [];
	}

	for (const provider of new Set(accounts.map((account) => account.provider))) {
		if (provider !== "aws" && provider !== "local") {
			throw new Error(
				`Team deployment supports only aws/local competitor accounts, received: ${provider}`,
			);
		}

		const validationError = getGameDayDeploymentValidationError(problem, provider);
		if (validationError) {
			throw new Error(validationError);
		}
	}

	// ジョブを作成
	const jobs: DeploymentJob[] = [];
	for (const account of accounts) {
		const job = await jobRepo.create({
			eventId,
			problemId: problem.id,
			competitorAccountId: account.id,
			provider: account.provider,
			region: account.region,
			maxRetries: 2,
		});
		jobs.push(job);
	}

	// EventBridge モードの場合はイベントを publish（CDK ProblemDeployPlane が処理）
	if (process.env.PROBLEM_DEPLOY_DELIVERY_MODE === "eventbridge") {
		const templateUrl =
			problem.deployment.templates.aws?.path ?? "";
		for (const job of jobs) {
			const account = accounts.find((a) => a.id === job.competitorAccountId);
			if (!account) continue;

			if (!account.roleArn || !account.externalId) {
				await jobRepo.updateStatus(eventId, problem.id, job.id, "failed", {
					error: `Missing roleArn or externalId for account ${account.id}`,
				});
				continue;
			}

			const detail: ProblemDeployRequestedDetail = {
				problemId: problem.id,
				teamId: account.id,
				tenantId: tenantId ?? eventId,
				eventId,
				jobId: job.id,
				targetRoleArn: account.roleArn,
				externalId: account.externalId,
				templateUrl,
				deploymentKey: encodeDeploymentKey(eventId, problem.id, job.id),
				timestamp: new Date().toISOString(),
			};
			try {
				await deployPublisher.publishDeployRequested(detail);
				await jobRepo.updateStatus(eventId, problem.id, job.id, "in_progress");
			} catch (error) {
				await jobRepo.updateStatus(eventId, problem.id, job.id, "failed", {
					error: error instanceof Error ? error.message : "EventBridge publish failed",
				});
			}
		}
		return jobs;
	}

	// ローカル開発: 非同期で並列デプロイ開始（レスポンスを待たない）
	void runDeployments(jobs, problem, accounts, concurrency);

	return jobs;
}

/**
 * 単一ジョブのリトライ
 */
export async function retryJob(
	eventId: string,
	problemId: string,
	jobId: string,
	problem: Problem,
): Promise<DeploymentJob | null> {
	const job = await jobRepo.findById(eventId, problemId, jobId);
	if (!job || job.status !== "failed") return null;

	const accounts = await accountRepo.findByEventId(eventId);
	const account = accounts.find((a) => a.id === job.competitorAccountId);
	if (!account) return null;

	await jobRepo.updateStatus(eventId, problemId, jobId, "pending", {
		retryCount: job.retryCount + 1,
	});
	const updated = (await jobRepo.findById(eventId, problemId, jobId))!;

	void runSingleDeployment(updated, problem, account);

	return updated;
}

/**
 * 起動時 reconcile: pending / in_progress ジョブを再実行
 */
export async function reconcile(): Promise<void> {
	const activeJobs = await jobRepo.findActive();
	if (activeJobs.length === 0) return;

	console.log(
		`[GameDayDeployer] reconcile: ${activeJobs.length} active jobs found`,
	);

	for (const job of activeJobs) {
		const accounts = await accountRepo.findByEventId(job.eventId);
		const account = accounts.find((a) => a.id === job.competitorAccountId);
		if (!account) {
			await jobRepo.updateStatus(
				job.eventId,
				job.problemId,
				job.id,
				"failed",
				{ error: "CompetitorAccount not found during reconcile" },
			);
			continue;
		}

		// Problem オブジェクトの取得は呼び出し側でロードする必要があるが、
		// reconcile は Problem なしでは実行できないため、status を failed にリセット
		// NOTE: 実際の運用では Problem を DB から取得して再実行する
		await jobRepo.updateStatus(
			job.eventId,
			job.problemId,
			job.id,
			"failed",
			{ error: "Process restarted during deployment. Please retry manually." },
		);
	}
}

// ============================================================
// 内部実装
// ============================================================

async function runDeployments(
	jobs: DeploymentJob[],
	problem: Problem,
	accounts: CompetitorAccountWithMeta[],
	concurrency: number,
): Promise<void> {
	const accountMap = new Map(accounts.map((a) => [a.id, a]));
	const queue = [...jobs];
	const running: Promise<void>[] = [];

	while (queue.length > 0 || running.length > 0) {
		while (running.length < concurrency && queue.length > 0) {
			const job = queue.shift()!;
			const account = accountMap.get(job.competitorAccountId);
			if (!account) continue;

			const p = runSingleDeployment(job, problem, account).finally(() => {
				const idx = running.indexOf(p);
				if (idx > -1) running.splice(idx, 1);
			});
			running.push(p);
		}
		if (running.length > 0) await Promise.race(running);
	}
}

async function runSingleDeployment(
	job: DeploymentJob,
	problem: Problem,
	account: CompetitorAccountWithMeta,
): Promise<void> {
	await setStatus(job, "in_progress");

	try {
		const credentials = buildCredentials(account);
		const provider =
			account.provider === "local" ? getLocalProvider() : getAWSProvider();
		const templateParameters =
			problem.deployment.templates[account.provider]?.parameters ?? {};

		// クレデンシャル検証
		const valid = await provider.validateCredentials(credentials);
		if (!valid) {
			await setStatus(job, "failed", {
				error: `Invalid credentials for account ${account.accountId}`,
			});
			return;
		}

		const stackName = buildStackName(job, account);

		const options: DeployStackOptions = {
			stackName,
			region: account.region,
			parameters: {
				TeamName: account.name,
				...templateParameters,
			},
			tags: {
				"tenkacloud:event-id": job.eventId,
				"tenkacloud:problem-id": job.problemId,
				"tenkacloud:competitor-account": account.accountId,
				"tenkacloud:managed-by": "tenkacloud",
			},
			timeoutSeconds: (problem.deployment.timeout || 60) * 60,
			rollbackOnFailure: true,
		};

		const result = await provider.deployStack(problem, credentials, options);

		if (result.success) {
			await setStatus(job, "completed", { result });
		} else {
			await setStatus(job, "failed", { error: result.error });
		}
	} catch (err) {
		await setStatus(job, "failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function setStatus(
	job: DeploymentJob,
	status: DeploymentJobStatus,
	opts?: {
		error?: string;
		result?: import("../types").DeploymentResult;
	},
): Promise<void> {
	await jobRepo.updateStatus(job.eventId, job.problemId, job.id, status, opts);
}

function buildCredentials(account: CompetitorAccountWithMeta): CloudCredentials {
	return {
		provider: account.provider,
		region: account.region,
		accountId: account.accountId,
		roleArn: account.roleArn,
		externalId: account.externalId,
		// accessKeyId / secretAccessKey は AssumeRole の場合不要
		// STS SDK が roleArn を使って一時クレデンシャルを取得する
	};
}

function buildStackName(
	job: DeploymentJob,
	account: CompetitorAccountWithMeta,
): string {
	const sanitize = (s: string) =>
		s.replace(/[^a-zA-Z0-9-]/g, "").substring(0, 16);
	return `tc-${sanitize(account.name)}-${sanitize(job.problemId)}`;
}
