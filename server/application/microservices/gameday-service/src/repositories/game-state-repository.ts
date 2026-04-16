/**
 * ゲーム状態リポジトリ
 *
 * GameDay のゲーム状態（開始・停止・スコアウェイト・ブラックアウト）を管理する
 */
import {
	PutCommand,
	GetCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { getDocClient, getTableName } from "@tenkacloud/dynamodb";
import type { GameState, ScoreWeight } from "../types";
import {
	buildGamedayPK,
	buildMetadataSK,
	buildTenantGamedayGSI,
	toGameState,
	GameAlreadyExistsError,
	ConcurrentModificationError,
	type GameStateItem,
} from "./repository-helpers";

export class GameStateRepository {
	async createGameState(input: {
		eventId: string;
		tenantId: string;
		durationMinutes: number;
	}): Promise<GameState> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		const item: GameStateItem = {
			PK: buildGamedayPK(input.eventId),
			SK: buildMetadataSK(),
			GSI1PK: buildTenantGamedayGSI(input.tenantId),
			GSI1SK: now,
			EntityType: "GAMEDAY",
			eventId: input.eventId,
			tenantId: input.tenantId,
			isRunning: true,
			startedAt: now,
			scoreWeight: "normal",
			blackout: false,
			durationMinutes: input.durationMinutes,
			CreatedAt: now,
			UpdatedAt: now,
		};

		try {
			await client.send(
				new PutCommand({
					TableName: tableName,
					Item: item,
					ConditionExpression: "attribute_not_exists(PK)",
				}),
			);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				throw new GameAlreadyExistsError(input.eventId);
			}
			throw error;
		}

		return toGameState(item);
	}

	async initGameState(input: {
		eventId: string;
		tenantId: string;
		durationMinutes: number;
	}): Promise<GameState> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		const item: GameStateItem = {
			PK: buildGamedayPK(input.eventId),
			SK: buildMetadataSK(),
			GSI1PK: buildTenantGamedayGSI(input.tenantId),
			GSI1SK: now,
			EntityType: "GAMEDAY",
			eventId: input.eventId,
			tenantId: input.tenantId,
			isRunning: false,
			startedAt: null,
			scoreWeight: "normal",
			blackout: false,
			durationMinutes: input.durationMinutes,
			CreatedAt: now,
			UpdatedAt: now,
		};

		try {
			await client.send(
				new PutCommand({
					TableName: tableName,
					Item: item,
					ConditionExpression: "attribute_not_exists(PK)",
				}),
			);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				throw new GameAlreadyExistsError(input.eventId);
			}
			throw error;
		}

		return toGameState(item);
	}

	async getGameState(eventId: string): Promise<GameState | null> {
		const client = getDocClient();
		const tableName = getTableName();

		const result = await client.send(
			new GetCommand({
				TableName: tableName,
				Key: {
					PK: buildGamedayPK(eventId),
					SK: buildMetadataSK(),
				},
			}),
		);

		if (!result.Item) {
			return null;
		}

		return toGameState(result.Item as GameStateItem);
	}

	async stopGame(eventId: string): Promise<GameState | null> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		try {
			const result = await client.send(
				new UpdateCommand({
					TableName: tableName,
					Key: {
						PK: buildGamedayPK(eventId),
						SK: buildMetadataSK(),
					},
					UpdateExpression: "SET isRunning = :running, UpdatedAt = :now",
					ExpressionAttributeValues: {
						":running": false,
						":now": now,
					},
					ConditionExpression: "attribute_exists(PK)",
					ReturnValues: "ALL_NEW",
				}),
			);

			if (!result.Attributes) {
				return null;
			}

			return toGameState(result.Attributes as GameStateItem);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				return null;
			}
			throw error;
		}
	}

	async startExistingGame(eventId: string): Promise<GameState | null> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		try {
			const result = await client.send(
				new UpdateCommand({
					TableName: tableName,
					Key: {
						PK: buildGamedayPK(eventId),
						SK: buildMetadataSK(),
					},
					UpdateExpression:
						"SET isRunning = :running, startedAt = :startedAt, UpdatedAt = :now",
					ExpressionAttributeValues: {
						":running": true,
						":startedAt": now,
						":now": now,
						":alreadyRunning": true,
					},
					ConditionExpression:
						"attribute_exists(PK) AND isRunning <> :alreadyRunning",
					ReturnValues: "ALL_NEW",
				}),
			);

			if (!result.Attributes) {
				return null;
			}

			return toGameState(result.Attributes as GameStateItem);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				throw new GameAlreadyExistsError(eventId);
			}
			throw error;
		}
	}

	async toggleScoreWeight(eventId: string): Promise<GameState | null> {
		const current = await this.getGameState(eventId);
		if (!current) {
			return null;
		}

		const newWeight: ScoreWeight =
			current.scoreWeight === "normal" ? "high" : "normal";
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		try {
			const result = await client.send(
				new UpdateCommand({
					TableName: tableName,
					Key: {
						PK: buildGamedayPK(eventId),
						SK: buildMetadataSK(),
					},
					UpdateExpression: "SET scoreWeight = :weight, UpdatedAt = :now",
					ExpressionAttributeValues: {
						":weight": newWeight,
						":now": now,
						":expectedWeight": current.scoreWeight,
					},
					ConditionExpression:
						"attribute_exists(PK) AND scoreWeight = :expectedWeight",
					ReturnValues: "ALL_NEW",
				}),
			);

			if (!result.Attributes) {
				return null;
			}

			return toGameState(result.Attributes as GameStateItem);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				throw new ConcurrentModificationError();
			}
			throw error;
		}
	}

	async enableBlackout(eventId: string): Promise<GameState | null> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		try {
			const result = await client.send(
				new UpdateCommand({
					TableName: tableName,
					Key: {
						PK: buildGamedayPK(eventId),
						SK: buildMetadataSK(),
					},
					UpdateExpression: "SET blackout = :true, UpdatedAt = :now",
					ExpressionAttributeValues: {
						":true": true,
						":now": now,
						":false": false,
					},
					// 冪等: blackout が false の場合のみ更新
					ConditionExpression: "attribute_exists(PK) AND blackout = :false",
					ReturnValues: "ALL_NEW",
				}),
			);

			if (!result.Attributes) return null;
			return toGameState(result.Attributes as GameStateItem);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				// 既に blackout=true → 何もせず現状を返す
				return this.getGameState(eventId);
			}
			throw error;
		}
	}

	async toggleBlackout(eventId: string): Promise<GameState | null> {
		const current = await this.getGameState(eventId);
		if (!current) {
			return null;
		}

		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		try {
			const result = await client.send(
				new UpdateCommand({
					TableName: tableName,
					Key: {
						PK: buildGamedayPK(eventId),
						SK: buildMetadataSK(),
					},
					UpdateExpression: "SET blackout = :blackout, UpdatedAt = :now",
					ExpressionAttributeValues: {
						":blackout": !current.blackout,
						":now": now,
						":expectedBlackout": current.blackout,
					},
					ConditionExpression:
						"attribute_exists(PK) AND blackout = :expectedBlackout",
					ReturnValues: "ALL_NEW",
				}),
			);

			if (!result.Attributes) {
				return null;
			}

			return toGameState(result.Attributes as GameStateItem);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				throw new ConcurrentModificationError();
			}
			throw error;
		}
	}
}
