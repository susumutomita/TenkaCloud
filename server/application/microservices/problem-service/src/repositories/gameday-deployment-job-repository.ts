/**
 * GameDay Deployment Job Repository (DynamoDB)
 *
 * CloudFormation スタックのデプロイジョブ状態の永続化
 *
 * DynamoDB キー設計:
 *   PK  = GAMEDAY_DEPLOY#EVENT#{eventId}#PROBLEM#{problemId}
 *   SK  = JOB#{jobId}
 *   GSI1PK = GAMEDAY_DEPLOY_ACTIVE  (pending / in_progress のみ設定)
 *   GSI1SK = {createdAt}#{jobId}    (起動時 reconcile クエリ用)
 */

import {
	PutCommand,
	GetCommand,
	QueryCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { getDocClient, getTableName } from "@tenkacloud/dynamodb";
import type { DeploymentJob, DeploymentJobStatus, DeploymentResult } from "../types";

const ACTIVE_GSI1PK = "GAMEDAY_DEPLOY_ACTIVE" as const;

interface GameDayDeploymentJobItem {
	PK: string;
	SK: string;
	GSI1PK?: string;
	GSI1SK?: string;
	EntityType: "GAMEDAY_DEPLOYMENT_JOB";
	CreatedAt: string;
	UpdatedAt: string;
	id: string;
	eventId: string;
	problemId: string;
	competitorAccountId: string;
	provider: string;
	region: string;
	status: string;
	stackName?: string;
	stackId?: string;
	outputs?: Record<string, string>;
	error?: string;
	retryCount: number;
	maxRetries: number;
	startedAt?: string;
	completedAt?: string;
}

const buildPK = (eventId: string, problemId: string) =>
	`GAMEDAY_DEPLOY#EVENT#${eventId}#PROBLEM#${problemId}`;
const buildSK = (jobId: string) => `JOB#${jobId}`;
const buildGSI1SK = (createdAt: string, jobId: string) =>
	`${createdAt}#${jobId}`;

const ACTIVE_STATUSES: DeploymentJobStatus[] = ["pending", "queued", "in_progress"];

function isActive(status: string): boolean {
	return ACTIVE_STATUSES.includes(status as DeploymentJobStatus);
}

function toDomain(item: GameDayDeploymentJobItem): DeploymentJob {
	return {
		id: item.id,
		eventId: item.eventId,
		problemId: item.problemId,
		competitorAccountId: item.competitorAccountId,
		provider: item.provider as DeploymentJob["provider"],
		region: item.region,
		status: item.status as DeploymentJobStatus,
		stackName: item.stackName,
		stackId: item.stackId,
		result: item.outputs
			? {
					success: item.status === "completed",
					stackName: item.stackName,
					stackId: item.stackId,
					outputs: item.outputs,
					startedAt: item.startedAt ? new Date(item.startedAt) : new Date(),
					completedAt: item.completedAt ? new Date(item.completedAt) : new Date(),
				}
			: undefined,
		retryCount: item.retryCount,
		maxRetries: item.maxRetries,
		createdAt: new Date(item.CreatedAt),
		startedAt: item.startedAt ? new Date(item.startedAt) : undefined,
		completedAt: item.completedAt ? new Date(item.completedAt) : undefined,
		error: item.error,
	};
}

export interface CreateJobInput {
	eventId: string;
	problemId: string;
	competitorAccountId: string;
	provider: string;
	region: string;
	maxRetries?: number;
}

export class GameDayDeploymentJobRepository {
	async create(input: CreateJobInput): Promise<DeploymentJob> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();
		const id = ulid();

		const item: GameDayDeploymentJobItem = {
			PK: buildPK(input.eventId, input.problemId),
			SK: buildSK(id),
			GSI1PK: ACTIVE_GSI1PK,
			GSI1SK: buildGSI1SK(now, id),
			EntityType: "GAMEDAY_DEPLOYMENT_JOB",
			CreatedAt: now,
			UpdatedAt: now,
			id,
			eventId: input.eventId,
			problemId: input.problemId,
			competitorAccountId: input.competitorAccountId,
			provider: input.provider,
			region: input.region,
			status: "pending",
			retryCount: 0,
			maxRetries: input.maxRetries ?? 3,
		};

		await client.send(
			new PutCommand({
				TableName: tableName,
				Item: item,
			}),
		);

		return toDomain(item);
	}

	async findById(
		eventId: string,
		problemId: string,
		jobId: string,
	): Promise<DeploymentJob | null> {
		const client = getDocClient();
		const tableName = getTableName();

		const result = await client.send(
			new GetCommand({
				TableName: tableName,
				Key: {
					PK: buildPK(eventId, problemId),
					SK: buildSK(jobId),
				},
			}),
		);

		if (!result.Item) return null;
		return toDomain(result.Item as GameDayDeploymentJobItem);
	}

	async findByEventAndProblem(
		eventId: string,
		problemId: string,
	): Promise<DeploymentJob[]> {
		const client = getDocClient();
		const tableName = getTableName();

		const result = await client.send(
			new QueryCommand({
				TableName: tableName,
				KeyConditionExpression:
					"PK = :pk AND begins_with(SK, :skPrefix)",
				ExpressionAttributeValues: {
					":pk": buildPK(eventId, problemId),
					":skPrefix": "JOB#",
				},
			}),
		);

		return (result.Items ?? []).map((item) =>
			toDomain(item as GameDayDeploymentJobItem),
		);
	}

	async findActive(): Promise<DeploymentJob[]> {
		const client = getDocClient();
		const tableName = getTableName();

		const result = await client.send(
			new QueryCommand({
				TableName: tableName,
				IndexName: "GSI1",
				KeyConditionExpression: "GSI1PK = :gsi1pk",
				ExpressionAttributeValues: {
					":gsi1pk": ACTIVE_GSI1PK,
				},
			}),
		);

		return (result.Items ?? []).map((item) =>
			toDomain(item as GameDayDeploymentJobItem),
		);
	}

	async updateStatus(
		eventId: string,
		problemId: string,
		jobId: string,
		status: DeploymentJobStatus,
		opts?: {
			error?: string;
			result?: DeploymentResult;
			retryCount?: number;
		},
	): Promise<void> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		const updateExpressions: string[] = [
			"#status = :status",
			"UpdatedAt = :updatedAt",
		];
		const attrNames: Record<string, string> = { "#status": "status" };
		const attrValues: Record<string, unknown> = {
			":status": status,
			":updatedAt": now,
		};

		if (status === "in_progress") {
			updateExpressions.push("startedAt = :startedAt");
			attrValues[":startedAt"] = now;
		}

		if (status === "completed" || status === "failed" || status === "cancelled") {
			updateExpressions.push("completedAt = :completedAt");
			attrValues[":completedAt"] = now;
			// GSI1 属性を削除してアクティブインデックスから外す
			updateExpressions.push("REMOVE GSI1PK, GSI1SK");
		}

		if (opts?.error !== undefined) {
			updateExpressions.push("#error = :error");
			attrNames["#error"] = "error";
			attrValues[":error"] = opts.error;
		}

		if (opts?.result) {
			if (opts.result.stackName) {
				updateExpressions.push("stackName = :stackName");
				attrValues[":stackName"] = opts.result.stackName;
			}
			if (opts.result.stackId) {
				updateExpressions.push("stackId = :stackId");
				attrValues[":stackId"] = opts.result.stackId;
			}
			if (opts.result.outputs) {
				updateExpressions.push("outputs = :outputs");
				attrValues[":outputs"] = opts.result.outputs;
			}
		}

		if (opts?.retryCount !== undefined) {
			updateExpressions.push("retryCount = :retryCount");
			attrValues[":retryCount"] = opts.retryCount;
		}

		// REMOVE 句と SET 句を分離
		const setExpressions = updateExpressions.filter(
			(e) => !e.startsWith("REMOVE"),
		);
		const removeFields = updateExpressions
			.filter((e) => e.startsWith("REMOVE"))
			.map((e) => e.replace("REMOVE ", ""))
			.join(", ");

		let updateExpression = `SET ${setExpressions.join(", ")}`;
		if (removeFields && !isActive(status)) {
			updateExpression += ` REMOVE ${removeFields}`;
		}

		await client.send(
			new UpdateCommand({
				TableName: tableName,
				Key: {
					PK: buildPK(eventId, problemId),
					SK: buildSK(jobId),
				},
				UpdateExpression: updateExpression,
				ExpressionAttributeNames:
					Object.keys(attrNames).length > 0 ? attrNames : undefined,
				ExpressionAttributeValues: attrValues,
				ConditionExpression: "attribute_exists(PK)",
			}),
		);
	}
}
