/**
 * 攻撃リポジトリ
 *
 * GameDay の攻撃カタログ・攻撃ログ・攻撃購入・脆弱性を管理する
 */
import {
	PutCommand,
	GetCommand,
	UpdateCommand,
	QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ulid } from "ulid";
import { getDocClient, getTableName } from "@tenkacloud/dynamodb";
import type { AttackLog, Attack, AttackPurchase, TeamVulnerability } from "../types";
import {
	buildGamedayPK,
	buildAttackLogSK,
	buildAttackSK,
	buildPurchaseSK,
	buildVulnerabilitySK,
	toAttackLog,
	toAttack,
	toAttackPurchase,
	toTeamVulnerability,
	AttackAlreadyPurchasedError,
	type AttackLogItem,
} from "./repository-helpers";

export class AttackRepository {
	// === 攻撃ログ ===

	async addAttackLog(input: {
		eventId: string;
		attackerTeamId: string;
		defenderTeamId: string;
		attackId: string;
		attackSlug: string;
		success: boolean;
		damage: number;
		reward: number;
		details: string;
	}): Promise<AttackLog> {
		const client = getDocClient();
		const tableName = getTableName();
		const id = ulid();
		const now = new Date().toISOString();

		const item: AttackLogItem = {
			PK: buildGamedayPK(input.eventId),
			SK: buildAttackLogSK(id),
			EntityType: "GAMEDAY_ATTACK_LOG",
			id,
			eventId: input.eventId,
			attackerTeamId: input.attackerTeamId,
			defenderTeamId: input.defenderTeamId,
			attackId: input.attackId,
			attackSlug: input.attackSlug,
			success: input.success,
			neutralized: false,
			damage: input.damage,
			reward: input.reward,
			details: input.details,
			createdAt: now,
		};

		await client.send(
			new PutCommand({
				TableName: tableName,
				Item: item,
			}),
		);

		return toAttackLog(item);
	}

	async listAttackLogs(eventId: string): Promise<AttackLog[]> {
		const client = getDocClient();
		const tableName = getTableName();
		const allItems: AttackLog[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const result = await client.send(
				new QueryCommand({
					TableName: tableName,
					KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
					ExpressionAttributeValues: {
						":pk": buildGamedayPK(eventId),
						":skPrefix": "ATTACKLOG#",
					},
					ScanIndexForward: false,
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);

			for (const item of result.Items ?? []) {
				// Kumo の begins_with バグ回避: アプリ側でフィルタ
				const sk = (item as Record<string, unknown>).SK as string | undefined;
				if (!sk || !sk.startsWith("ATTACKLOG#")) continue;
				allItems.push(toAttackLog(item as AttackLogItem));
			}
			exclusiveStartKey = result.LastEvaluatedKey as
				| Record<string, unknown>
				| undefined;
		} while (exclusiveStartKey);

		return allItems;
	}

	// === 攻撃カタログ ===

	async listAttackCatalog(eventId: string): Promise<Attack[]> {
		const client = getDocClient();
		const tableName = getTableName();
		const allItems: Attack[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const result = await client.send(
				new QueryCommand({
					TableName: tableName,
					KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
					ExpressionAttributeValues: {
						":pk": buildGamedayPK(eventId),
						":skPrefix": "ATTACK#",
					},
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);

			for (const item of result.Items ?? []) {
				// Kumo の begins_with バグ回避: アプリ側でフィルタ
				const sk = (item as Record<string, unknown>).SK as string | undefined;
				if (!sk || !sk.startsWith("ATTACK#")) continue;
				allItems.push(toAttack(item as Record<string, unknown>));
			}
			exclusiveStartKey = result.LastEvaluatedKey as
				| Record<string, unknown>
				| undefined;
		} while (exclusiveStartKey);

		return allItems;
	}

	async getAttack(
		eventId: string,
		attackIdentifier: string,
	): Promise<Attack | null> {
		const client = getDocClient();
		const tableName = getTableName();

		const result = await client.send(
			new GetCommand({
				TableName: tableName,
				Key: {
					PK: buildGamedayPK(eventId),
					SK: buildAttackSK(attackIdentifier),
				},
			}),
		);

		if (result.Item) {
			return toAttack(result.Item as Record<string, unknown>);
		}

		const catalog = await this.listAttackCatalog(eventId);
		return (
			catalog.find(
				(attack) =>
					attack.id === attackIdentifier || attack.slug === attackIdentifier,
			) ?? null
		);
	}

	async seedAttackCatalog(eventId: string, attacks: Attack[]): Promise<void> {
		const client = getDocClient();
		const tableName = getTableName();

		await Promise.all(
			attacks.map((attack) =>
				client.send(
					new PutCommand({
						TableName: tableName,
						Item: {
							PK: buildGamedayPK(eventId),
							SK: buildAttackSK(attack.slug),
							EntityType: "ATTACK",
							...attack,
						},
					}),
				),
			),
		);
	}

	// === 攻撃購入 ===

	async getAttackPurchase(
		eventId: string,
		teamId: string,
		attackSlug: string,
	): Promise<AttackPurchase | null> {
		const client = getDocClient();
		const tableName = getTableName();

		const result = await client.send(
			new GetCommand({
				TableName: tableName,
				Key: {
					PK: buildGamedayPK(eventId),
					SK: buildPurchaseSK(teamId, attackSlug),
				},
			}),
		);

		if (!result.Item) {
			return null;
		}

		return toAttackPurchase(result.Item as Record<string, unknown>);
	}

	async createAttackPurchase(input: {
		eventId: string;
		teamId: string;
		attackId: string;
		attackSlug: string;
	}): Promise<AttackPurchase> {
		const client = getDocClient();
		const tableName = getTableName();
		const id = ulid();
		const now = new Date().toISOString();

		const item = {
			PK: buildGamedayPK(input.eventId),
			SK: buildPurchaseSK(input.teamId, input.attackSlug),
			EntityType: "PURCHASE",
			id,
			eventId: input.eventId,
			teamId: input.teamId,
			attackId: input.attackId,
			attackSlug: input.attackSlug,
			purchasedAt: now,
			lastUsedAt: null,
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
				throw new AttackAlreadyPurchasedError();
			}
			throw error;
		}

		return toAttackPurchase(item as Record<string, unknown>);
	}

	async updatePurchaseLastUsedAt(
		eventId: string,
		teamId: string,
		attackSlug: string,
		timestamp: string,
	): Promise<void> {
		const client = getDocClient();
		const tableName = getTableName();

		await client.send(
			new UpdateCommand({
				TableName: tableName,
				Key: {
					PK: buildGamedayPK(eventId),
					SK: buildPurchaseSK(teamId, attackSlug),
				},
				UpdateExpression: "SET lastUsedAt = :ts",
				ExpressionAttributeValues: {
					":ts": timestamp,
				},
			}),
		);
	}

	// === 脆弱性 ===

	async getTeamVulnerability(
		eventId: string,
		teamId: string,
		vulnSlug: string,
	): Promise<TeamVulnerability | null> {
		const client = getDocClient();
		const tableName = getTableName();

		const result = await client.send(
			new GetCommand({
				TableName: tableName,
				Key: {
					PK: buildGamedayPK(eventId),
					SK: buildVulnerabilitySK(teamId, vulnSlug),
				},
			}),
		);

		if (!result.Item) {
			return null;
		}

		return toTeamVulnerability(result.Item as Record<string, unknown>);
	}

	async upsertTeamVulnerability(input: {
		eventId: string;
		teamId: string;
		vulnerabilitySlug: string;
		isFixed: boolean;
	}): Promise<TeamVulnerability> {
		const client = getDocClient();
		const tableName = getTableName();
		const id = ulid();

		const item = {
			PK: buildGamedayPK(input.eventId),
			SK: buildVulnerabilitySK(input.teamId, input.vulnerabilitySlug),
			EntityType: "VULNERABILITY",
			id,
			eventId: input.eventId,
			teamId: input.teamId,
			vulnerabilitySlug: input.vulnerabilitySlug,
			isFixed: input.isFixed,
		};

		await client.send(
			new PutCommand({
				TableName: tableName,
				Item: item,
			}),
		);

		return toTeamVulnerability(item as Record<string, unknown>);
	}
}
