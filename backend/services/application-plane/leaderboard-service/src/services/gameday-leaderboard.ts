import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient, getTableName } from "@tenkacloud/dynamodb";

/**
 * GameDay リーダーボードのエントリ
 */
export interface GameDayLeaderboardEntry {
	rank: number;
	teamId: string;
	teamName: string;
	score: number;
}

/**
 * GameDay リーダーボードの取得結果
 */
export interface GameDayLeaderboardResult {
	eventId: string;
	entries: GameDayLeaderboardEntry[];
}

interface TeamStateItem {
	PK: string;
	SK: string;
	EntityType: string;
	eventId: string;
	teamId: string;
	teamName: string;
	score: number;
}

/**
 * GameDay リーダーボードのリポジトリインターフェース
 */
export interface GameDayLeaderboardRepository {
	listTeams(eventId: string): Promise<TeamStateItem[]>;
}

/**
 * DynamoDB を使用した GameDay リーダーボードリポジトリ実装
 *
 * GAMEDAY#{eventId} パーティションから TEAM# プレフィックスのアイテムをクエリする。
 */
export class DynamoDBGameDayLeaderboardRepository
	implements GameDayLeaderboardRepository
{
	async listTeams(eventId: string): Promise<TeamStateItem[]> {
		const client = getDocClient();
		const tableName = getTableName();
		const allItems: TeamStateItem[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const result = await client.send(
				new QueryCommand({
					TableName: tableName,
					KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
					ExpressionAttributeValues: {
						":pk": `GAMEDAY#${eventId}`,
						":skPrefix": "TEAM#",
					},
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);

			for (const item of result.Items ?? []) {
				const sk = item.SK as string;
				if (sk.startsWith("TEAM#") && !sk.includes("#", 5)) {
					allItems.push(item as TeamStateItem);
				}
			}

			exclusiveStartKey = result.LastEvaluatedKey as
				| Record<string, unknown>
				| undefined;
		} while (exclusiveStartKey);

		return allItems;
	}
}

/**
 * チーム一覧からリーダーボードエントリを構築する
 *
 * スコア降順でソートし、順位を付与する。
 *
 * @param teams - チーム状態アイテム一覧
 * @returns ランク付きリーダーボードエントリ
 */
export function buildGameDayLeaderboard(
	teams: TeamStateItem[],
): GameDayLeaderboardEntry[] {
	const sorted = [...teams].sort((a, b) => b.score - a.score);

	return sorted.map((t, index) => ({
		rank: index + 1,
		teamId: t.teamId,
		teamName: t.teamName,
		score: t.score,
	}));
}

/**
 * GameDay リーダーボードを取得する
 *
 * リポジトリからチーム一覧を取得し、スコア順のリーダーボードを構築する。
 *
 * @param eventId - イベントID
 * @param repository - リーダーボードリポジトリ
 * @returns イベントIDとエントリ一覧を含むリーダーボード結果
 */
export async function getGameDayLeaderboard(
	eventId: string,
	repository: GameDayLeaderboardRepository,
): Promise<GameDayLeaderboardResult> {
	const teams = await repository.listTeams(eventId);
	const entries = buildGameDayLeaderboard(teams);

	return {
		eventId,
		entries,
	};
}
