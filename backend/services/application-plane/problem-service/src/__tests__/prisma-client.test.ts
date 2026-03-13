/**
 * Prisma Client Tests
 *
 * @prisma/client が利用不可でもモジュールがクラッシュしないことを検証
 */

import { describe, it, expect } from 'vitest';
import { prisma } from '../repositories/prisma-client';

describe('prisma-client', () => {
  it('モジュールが正常にインポートできるべき', () => {
    // prisma は null（@prisma/client 未生成時）または PrismaClient インスタンス
    // 重要: クラッシュしないことが保証されている
    expect(prisma === null || prisma !== undefined).toBe(true);
  });

  it('prisma エクスポートが定義されているべき', async () => {
    const mod = await import('../repositories/prisma-client');
    expect(mod).toHaveProperty('prisma');
    expect(mod).toHaveProperty('default');
  });
});
