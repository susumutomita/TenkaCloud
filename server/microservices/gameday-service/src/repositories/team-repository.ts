/**
 * チームリポジトリ
 *
 * GameDay のチーム登録・URL 更新・ヘルス状態・スコア更新を管理する
 */
import {
	PutCommand,
	GetCommand,
	UpdateCommand,
	QueryCommand,
	TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { getDocClient, getTableName } from "@tenkacloud/dynamodb";
import {
	buildGamedayPK,
	buildTeamSK,
	toTeamState,
	TeamAlreadyExistsError,
	type TeamStateItem,
	type TeamState,
} from "./repository-helpers";

export class TeamRepository {
	async createTeam(input: {
		eventId: string;
		teamId: string;
		teamName: string;
		websiteUrl?: string;
		apiUrl?: string;
		inviteCode?: string;
	}): Promise<TeamState> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();
		const inviteCode =
			input.inviteCode ??
			crypto.randomUUID().substring(0, 8).toUpperCase();

		const item: TeamStateItem = {
			PK: buildGamedayPK(input.eventId),
			SK: buildTeamSK(input.teamId),
			EntityType: "TEAM",
			eventId: input.eventId,
			teamId: input.teamId,
			teamName: input.teamName,
			score: 0,
			isHealthy: true,
			websiteUrl: input.websiteUrl ?? null,
			apiUrl: input.apiUrl ?? null,
			inviteCode,
			CreatedAt: now,
			UpdatedAt: now,
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
				throw new TeamAlreadyExistsError(input.teamId);
			}
			throw error;
		}

		return toTeamState(item);
	}

	async updateTeamUrls(
		eventId: string,
		teamId: string,
		urls: { websiteUrl?: string; apiUrl?: string },
	): Promise<void> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		const expressionParts: string[] = ["UpdatedAt = :now"];
		const expressionValues: Record<string, unknown> = { ":now": now };

		if (urls.websiteUrl !== undefined) {
			expressionParts.push("websiteUrl = :wUrl");
			expressionValues[":wUrl"] = urls.websiteUrl;
		}
		if (urls.apiUrl !== undefined) {
			expressionParts.push("apiUrl = :aUrl");
			expressionValues[":aUrl"] = urls.apiUrl;
		}

		try {
			await client.send(
				new UpdateCommand({
					TableName: tableName,
					Key: {
						PK: buildGamedayPK(eventId),
						SK: buildTeamSK(teamId),
					},
					UpdateExpression: `SET ${expressionParts.join(", ")}`,
					ExpressionAttributeValues: expressionValues,
					ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
				}),
			);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				return;
			}
			throw error;
		}
	}

	async updateTeamHealthy(
		eventId: string,
		teamId: string,
		isHealthy: boolean,
	): Promise<void> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		await client.send(
			new UpdateCommand({
				TableName: tableName,
				Key: {
					PK: buildGamedayPK(eventId),
					SK: buildTeamSK(teamId),
				},
				UpdateExpression: "SET isHealthy = :h, UpdatedAt = :now",
				ExpressionAttributeValues: {
					":h": isHealthy,
					":now": now,
				},
			}),
		);
	}

	async getTeamState(
		eventId: string,
		teamId: string,
	): Promise<TeamState | null> {
		const client = getDocClient();
		const tableName = getTableName();

		const result = await client.send(
			new GetCommand({
				TableName: tableName,
				Key: {
					PK: buildGamedayPK(eventId),
					SK: buildTeamSK(teamId),
				},
			}),
		);

		if (!result.Item) {
			return null;
		}

		return toTeamState(result.Item as TeamStateItem);
	}

	async listTeams(eventId: string): Promise<TeamState[]> {
		const client = getDocClient();
		const tableName = getTableName();
		const allItems: TeamState[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const result = await client.send(
				new QueryCommand({
					TableName: tableName,
					KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
					ExpressionAttributeValues: {
						":pk": buildGamedayPK(eventId),
						":skPrefix": "TEAM#",
					},
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);

			for (const item of result.Items ?? []) {
				// Kumo の begins_with バグ回避: アプリ側でフィルタ
				const sk = (item as Record<string, unknown>).SK as string | undefined;
				if (!sk || !sk.startsWith("TEAM#")) continue;
				allItems.push(toTeamState(item as TeamStateItem));
			}
			exclusiveStartKey = result.LastEvaluatedKey as
				| Record<string, unknown>
				| undefined;
		} while (exclusiveStartKey);

		return allItems;
	}

	async findTeamByInviteCode(
		eventId: string,
		inviteCode: string,
	): Promise<TeamState | null> {
		const teams = await this.listTeams(eventId);
		return teams.find((t) => t.inviteCode === inviteCode) ?? null;
	}

	async updateTeamScore(
		eventId: string,
		teamId: string,
		delta: number,
	): Promise<void> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		await client.send(
			new UpdateCommand({
				TableName: tableName,
				Key: {
					PK: buildGamedayPK(eventId),
					SK: buildTeamSK(teamId),
				},
				UpdateExpression: "ADD score :delta SET UpdatedAt = :now",
				ExpressionAttributeValues: {
					":delta": delta,
					":now": now,
				},
			}),
		);
	}

	async updateMultipleTeamScores(
		eventId: string,
		updates: Array<{ teamId: string; delta: number }>,
	): Promise<void> {
		if (updates.length === 0) return;

		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		await client.send(
			new TransactWriteCommand({
				TransactItems: updates.map(({ teamId, delta }) => ({
					Update: {
						TableName: tableName,
						Key: {
							PK: buildGamedayPK(eventId),
							SK: buildTeamSK(teamId),
						},
						UpdateExpression: "ADD score :delta SET UpdatedAt = :now",
						ExpressionAttributeValues: {
							":delta": delta,
							":now": now,
						},
					},
				})),
			}),
		);
	}
}
