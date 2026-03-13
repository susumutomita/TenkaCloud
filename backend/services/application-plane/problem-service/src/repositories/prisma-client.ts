/**
 * Prisma Client シングルトン
 *
 * アプリケーション全体で単一の Prisma インスタンスを共有
 *
 * @prisma/client が利用不可の場合（DynamoDB 移行中の開発環境など）は
 * null を返し、サーバー起動をブロックしない。
 */

declare global {
  var __prisma: unknown | undefined;
}

function createPrismaClient(): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient } = require('@prisma/client') as {
      PrismaClient: new (opts: { log: string[] }) => unknown;
    };
    return new PrismaClient({
      log:
        process.env.NODE_ENV === 'development'
          ? ['query', 'info', 'warn', 'error']
          : ['error'],
    });
  } catch {
    console.warn(
      '\x1b[33m⚠️  @prisma/client is not available. Prisma-dependent features are disabled.\x1b[0m'
    );
    console.warn(
      '\x1b[33m   Run "bunx prisma generate" to enable Prisma features.\x1b[0m'
    );
    return null;
  }
}

export const prisma: unknown = global.__prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production' && prisma) {
  global.__prisma = prisma;
}

export default prisma;
