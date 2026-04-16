import { initDynamoDB } from "@tenkacloud/dynamodb";
import { GamedayRepository } from "../repositories/gameday-repository";

const tableName = process.env.DYNAMODB_TABLE;
if (!tableName) {
	throw new Error("DYNAMODB_TABLE 環境変数が設定されていません");
}

const region = process.env.AWS_REGION;
if (!region) {
	throw new Error("AWS_REGION 環境変数が設定されていません");
}

// DynamoDB初期化
initDynamoDB({
	tableName,
	region,
	endpoint: process.env.DYNAMODB_ENDPOINT,
});

// リポジトリインスタンス
export const gamedayRepository = new GamedayRepository();
