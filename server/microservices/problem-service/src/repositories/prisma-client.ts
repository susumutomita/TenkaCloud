/**
 * Prisma Client シングルトン（遅延初期化）
 *
 * アプリケーション全体で単一の Prisma インスタンスを共有
 *
 * @prisma/client が利用不可の場合（DynamoDB 移行中の開発環境など）は
 * null を返し、サーバー起動をブロックしない。
 */

import { createRequire } from "node:module";
import type { PrismaClient } from "@prisma/client";

declare global {
	var __prisma: PrismaClient | undefined;
}

const esmRequire = createRequire(import.meta.url);

function createPrismaClient(): PrismaClient | null {
	try {
		const { PrismaClient: PC } = esmRequire("@prisma/client") as {
			PrismaClient: new (opts: { log: string[] }) => PrismaClient;
		};
		return new PC({
			log:
				process.env.NODE_ENV === "development"
					? ["query", "info", "warn", "error"]
					: ["error"],
		});
	} catch {
		console.warn(
			"\x1b[33m⚠️  @prisma/client is not available. Prisma-dependent features are disabled.\x1b[0m",
		);
		console.warn(
			'\x1b[33m   Run "bunx prisma generate" to enable Prisma features.\x1b[0m',
		);
		return null;
	}
}

const _prisma = global.__prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production" && _prisma) {
	global.__prisma = _prisma;
}

/**
 * Prisma Client インスタンス
 *
 * @prisma/client が利用不可の場合は null になる。
 * 利用側で null チェックをスキップする場合は non-null assertion を使用する。
 */
export const prisma = _prisma as PrismaClient;
export default prisma;
