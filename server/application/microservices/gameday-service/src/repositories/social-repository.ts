/**
 * ソーシャルリポジトリ
 *
 * GameDay の同盟・ヘルスチェック・投票・メンバーシップを管理する
 */
import {
	PutCommand,
	GetCommand,
	UpdateCommand,
	DeleteCommand,
	QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ulid } from "ulid";
import { getDocClient, getTableName } from "@tenkacloud/dynamodb";
import type { Alliance, AllianceStatus, HealthCheckResult, Vote } from "../types";
import {
	buildGamedayPK,
	buildAllianceSK,
	buildHealthCheckSK,
	buildVoteSK,
	buildMemberSK,
	toAlliance,
	toHealthCheckResult,
	toVote,
	toMemberRecord,
	VoteAlreadyExistsError,
	type MemberItem,
	type MemberRecord,
} from "./repository-helpers";

export class SocialRepository {
	// === 同盟 ===

	async listAlliances(eventId: string): Promise<Alliance[]> {
		const client = getDocClient();
		const tableName = getTableName();
		const allItems: Alliance[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const result = await client.send(
				new QueryCommand({
					TableName: tableName,
					KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
					ExpressionAttributeValues: {
						":pk": buildGamedayPK(eventId),
						":skPrefix": "ALLIANCE#",
					},
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);

			for (const item of result.Items ?? []) {
				// Kumo の begins_with バグ回避: アプリ側でフィルタ
				const sk = (item as Record<string, unknown>).SK as string | undefined;
				if (!sk || !sk.startsWith("ALLIANCE#")) continue;
				allItems.push(toAlliance(item as Record<string, unknown>));
			}
			exclusiveStartKey = result.LastEvaluatedKey as
				| Record<string, unknown>
				| undefined;
		} while (exclusiveStartKey);

		return allItems;
	}

	async listTeamActiveAlliances(
		eventId: string,
		teamId: string,
	): Promise<Alliance[]> {
		const client = getDocClient();
		const tableName = getTableName();
		const allItems: Alliance[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const result = await client.send(
				new QueryCommand({
					TableName: tableName,
					KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
					FilterExpression:
						"#status = :active AND (#requester = :teamId OR #target = :teamId)",
					ExpressionAttributeNames: {
						"#status": "status",
						"#requester": "requesterTeamId",
						"#target": "targetTeamId",
					},
					ExpressionAttributeValues: {
						":pk": buildGamedayPK(eventId),
						":skPrefix": "ALLIANCE#",
						":active": "ACTIVE",
						":teamId": teamId,
					},
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);

			for (const item of result.Items ?? []) {
				// Kumo の begins_with バグ回避: アプリ側でフィルタ (+ FilterExpression も無視されるため再チェック)
				const sk = (item as Record<string, unknown>).SK as string | undefined;
				const allianceItem = item as Record<string, unknown>;
				if (
					!sk ||
					!sk.startsWith("ALLIANCE#") ||
					allianceItem.status !== "ACTIVE" ||
					(allianceItem.requesterTeamId !== teamId &&
						allianceItem.targetTeamId !== teamId)
				)
					continue;
				allItems.push(toAlliance(item as Record<string, unknown>));
			}
			exclusiveStartKey = result.LastEvaluatedKey as
				| Record<string, unknown>
				| undefined;
		} while (exclusiveStartKey);

		return allItems;
	}

	async getAlliance(
		eventId: string,
		allianceId: string,
	): Promise<Alliance | null> {
		const client = getDocClient();
		const tableName = getTableName();

		const result = await client.send(
			new GetCommand({
				TableName: tableName,
				Key: {
					PK: buildGamedayPK(eventId),
					SK: buildAllianceSK(allianceId),
				},
			}),
		);

		if (!result.Item) {
			return null;
		}

		return toAlliance(result.Item as Record<string, unknown>);
	}

	async createAlliance(input: {
		eventId: string;
		requesterTeamId: string;
		targetTeamId: string;
	}): Promise<Alliance> {
		const client = getDocClient();
		const tableName = getTableName();
		const id = ulid();
		const now = new Date().toISOString();

		const item = {
			PK: buildGamedayPK(input.eventId),
			SK: buildAllianceSK(id),
			EntityType: "ALLIANCE",
			id,
			eventId: input.eventId,
			requesterTeamId: input.requesterTeamId,
			targetTeamId: input.targetTeamId,
			status: "PENDING" as AllianceStatus,
			createdAt: now,
			updatedAt: now,
		};

		await client.send(
			new PutCommand({
				TableName: tableName,
				Item: item,
			}),
		);

		return toAlliance(item as Record<string, unknown>);
	}

	async updateAllianceStatus(
		eventId: string,
		allianceId: string,
		status: AllianceStatus,
	): Promise<void> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		await client.send(
			new UpdateCommand({
				TableName: tableName,
				Key: {
					PK: buildGamedayPK(eventId),
					SK: buildAllianceSK(allianceId),
				},
				UpdateExpression: "SET #status = :status, updatedAt = :now",
				ExpressionAttributeNames: {
					"#status": "status",
				},
				ExpressionAttributeValues: {
					":status": status,
					":now": now,
				},
			}),
		);
	}

	async deleteAlliance(eventId: string, allianceId: string): Promise<void> {
		const client = getDocClient();
		const tableName = getTableName();

		await client.send(
			new DeleteCommand({
				TableName: tableName,
				Key: {
					PK: buildGamedayPK(eventId),
					SK: buildAllianceSK(allianceId),
				},
			}),
		);
	}

	// === ヘルスチェック ===

	async listHealthChecks(
		eventId: string,
		teamId: string,
	): Promise<HealthCheckResult[]> {
		const client = getDocClient();
		const tableName = getTableName();
		const allItems: HealthCheckResult[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const result = await client.send(
				new QueryCommand({
					TableName: tableName,
					KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
					ExpressionAttributeValues: {
						":pk": buildGamedayPK(eventId),
						":skPrefix": `HEALTHCHECK#${teamId}#`,
					},
					ScanIndexForward: false,
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);

			for (const item of result.Items ?? []) {
				// Kumo の begins_with バグ回避: アプリ側でフィルタ
				const sk = (item as Record<string, unknown>).SK as string | undefined;
				if (sk && sk.startsWith(`HEALTHCHECK#${teamId}#`)) {
					allItems.push(toHealthCheckResult(item as Record<string, unknown>));
				}
			}
			exclusiveStartKey = result.LastEvaluatedKey as
				| Record<string, unknown>
				| undefined;
		} while (exclusiveStartKey);

		return allItems;
	}

	async createHealthCheck(input: {
		eventId: string;
		teamId: string;
		checkType: "website" | "api";
		isHealthy: boolean;
		statusCode: number | null;
		responseTimeMs: number | null;
	}): Promise<HealthCheckResult> {
		const client = getDocClient();
		const tableName = getTableName();
		const id = ulid();
		const now = new Date().toISOString();

		const item = {
			PK: buildGamedayPK(input.eventId),
			SK: buildHealthCheckSK(input.teamId, now),
			EntityType: "HEALTHCHECK",
			id,
			eventId: input.eventId,
			teamId: input.teamId,
			checkType: input.checkType,
			isHealthy: input.isHealthy,
			statusCode: input.statusCode,
			responseTimeMs: input.responseTimeMs,
			createdAt: now,
		};

		await client.send(
			new PutCommand({
				TableName: tableName,
				Item: item,
			}),
		);

		return toHealthCheckResult(item as Record<string, unknown>);
	}

	// === 投票 ===

	async castVote(input: {
		eventId: string;
		voterTeamId: string;
		votedForTeamId: string;
	}): Promise<Vote> {
		const client = getDocClient();
		const tableName = getTableName();
		const id = ulid();
		const now = new Date().toISOString();

		const item = {
			PK: buildGamedayPK(input.eventId),
			SK: buildVoteSK(input.voterTeamId),
			EntityType: "VOTE",
			id,
			eventId: input.eventId,
			voterTeamId: input.voterTeamId,
			votedForTeamId: input.votedForTeamId,
			createdAt: now,
		};

		try {
			await client.send(
				new PutCommand({
					TableName: tableName,
					Item: item,
					ConditionExpression:
						"attribute_not_exists(PK) AND attribute_not_exists(SK)",
				}),
			);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				throw new VoteAlreadyExistsError();
			}
			throw error;
		}

		return toVote(item as Record<string, unknown>);
	}

	async listVotes(eventId: string): Promise<Vote[]> {
		const client = getDocClient();
		const tableName = getTableName();
		const allItems: Vote[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const result = await client.send(
				new QueryCommand({
					TableName: tableName,
					KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
					ExpressionAttributeValues: {
						":pk": buildGamedayPK(eventId),
						":skPrefix": "VOTE#",
					},
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);

			for (const item of result.Items ?? []) {
				// Kumo の begins_with バグ回避: アプリ側でフィルタ
				const sk = (item as Record<string, unknown>).SK as string | undefined;
				if (!sk || !sk.startsWith("VOTE#")) continue;
				allItems.push(toVote(item as Record<string, unknown>));
			}
			exclusiveStartKey = result.LastEvaluatedKey as
				| Record<string, unknown>
				| undefined;
		} while (exclusiveStartKey);

		return allItems;
	}

	// === メンバーシップ ===

	async addMember(input: {
		eventId: string;
		userId: string;
		teamId: string;
		teamName: string;
		mode: "solo" | "team";
	}): Promise<MemberRecord> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		const item: MemberItem = {
			PK: buildGamedayPK(input.eventId),
			SK: buildMemberSK(input.userId),
			EntityType: "MEMBER",
			eventId: input.eventId,
			userId: input.userId,
			teamId: input.teamId,
			teamName: input.teamName,
			mode: input.mode,
			CreatedAt: now,
		};

		await client.send(
			new PutCommand({
				TableName: tableName,
				Item: item,
			}),
		);

		return toMemberRecord(item);
	}

	async getMembership(
		eventId: string,
		userId: string,
	): Promise<MemberRecord | null> {
		const client = getDocClient();
		const tableName = getTableName();

		const result = await client.send(
			new GetCommand({
				TableName: tableName,
				Key: {
					PK: buildGamedayPK(eventId),
					SK: buildMemberSK(userId),
				},
			}),
		);

		if (!result.Item) {
			return null;
		}

		return toMemberRecord(result.Item as MemberItem);
	}
}
