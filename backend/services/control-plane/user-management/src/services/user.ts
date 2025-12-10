import type { User, UserRole, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import {
  createKeycloakUser,
  resetKeycloakPassword,
  disableKeycloakUser,
  deleteKeycloakUser,
} from '../lib/keycloak';

const logger = createLogger('user-service');

/**
 * テナントの slug を検証し、tenantId に対応する正しい slug を返す
 * これにより、悪意のある tenantSlug ヘッダー改ざんを防ぐ
 */
async function validateAndGetTenantSlug(
  tenantId: string,
  providedSlug: string
): Promise<string> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { slug: true },
  });

  if (!tenant) {
    throw new Error('テナントが見つかりません');
  }

  // 提供された slug が実際の slug と一致することを検証
  if (tenant.slug !== providedSlug) {
    logger.warn(
      { tenantId, providedSlug, actualSlug: tenant.slug },
      'テナント slug の不一致を検出しました'
    );
    throw new Error('テナント情報が一致しません');
  }

  return tenant.slug;
}

export interface CreateUserInput {
  tenantId: string;
  tenantSlug: string;
  email: string;
  name: string;
  role?: UserRole;
}

export interface CreateUserResult {
  user: User;
  temporaryPassword: string;
}

export interface ListUsersInput {
  tenantId: string;
  status?: UserStatus;
  role?: UserRole;
  limit?: number;
  offset?: number;
}

export interface ListUsersResult {
  users: User[];
  total: number;
}

export class UserService {
  async createUser(input: CreateUserInput): Promise<CreateUserResult> {
    logger.info(
      { tenantId: input.tenantId, email: input.email },
      'ユーザー作成を開始します'
    );

    // tenantSlug の検証（クロステナント攻撃の防止）
    const validatedSlug = await validateAndGetTenantSlug(
      input.tenantId,
      input.tenantSlug
    );

    // Create user in Keycloak
    const keycloakResult = await createKeycloakUser(
      validatedSlug,
      input.email,
      input.name
    );

    // Create user in database with rollback on failure
    let user: User;
    try {
      user = await prisma.user.create({
        data: {
          tenantId: input.tenantId,
          email: input.email,
          name: input.name,
          role: input.role ?? 'PARTICIPANT',
          status: 'PENDING',
          keycloakId: keycloakResult.keycloakId,
        },
      });
    } catch (error) {
      // DB 作成失敗時は Keycloak ユーザーを削除してロールバック
      logger.error(
        { keycloakId: keycloakResult.keycloakId, error },
        'DB ユーザー作成失敗、Keycloak ユーザーをロールバックします'
      );
      try {
        await deleteKeycloakUser(validatedSlug, keycloakResult.keycloakId);
      } catch (rollbackError) {
        logger.error(
          { keycloakId: keycloakResult.keycloakId, rollbackError },
          'Keycloak ロールバック失敗'
        );
      }
      throw error;
    }

    logger.info({ userId: user.id }, 'ユーザーを作成しました');

    return {
      user,
      temporaryPassword: keycloakResult.temporaryPassword,
    };
  }

  async listUsers(input: ListUsersInput): Promise<ListUsersResult> {
    const where = {
      tenantId: input.tenantId,
      ...(input.status && { status: input.status }),
      ...(input.role && { role: input.role }),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        take: input.limit ?? 50,
        skip: input.offset ?? 0,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);

    return { users, total };
  }

  async getUserById(tenantId: string, userId: string): Promise<User | null> {
    return prisma.user.findFirst({
      where: { id: userId, tenantId },
    });
  }

  async updateUserRole(
    tenantId: string,
    userId: string,
    role: UserRole
  ): Promise<User> {
    logger.info({ userId, role }, 'ユーザーロールを更新します');

    // 原子的な更新: WHERE 句でテナント所有権を検証しながら更新
    // TOCTOU レース条件を回避
    const result = await prisma.user.updateMany({
      where: { id: userId, tenantId },
      data: { role },
    });

    if (result.count === 0) {
      throw new Error('ユーザーが見つかりません');
    }

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    logger.info({ userId, role }, 'ユーザーロールを更新しました');

    return user;
  }

  async resetPassword(
    tenantId: string,
    tenantSlug: string,
    userId: string
  ): Promise<string> {
    logger.info({ userId }, 'パスワードリセットを開始します');

    // tenantSlug の検証（クロステナント攻撃の防止）
    const validatedSlug = await validateAndGetTenantSlug(tenantId, tenantSlug);

    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new Error('ユーザーが見つかりません');
    }

    if (!user.keycloakId) {
      throw new Error('Keycloakユーザーが紐付けられていません');
    }

    const temporaryPassword = await resetKeycloakPassword(
      validatedSlug,
      user.keycloakId
    );

    logger.info({ userId }, 'パスワードリセットが完了しました');

    return temporaryPassword;
  }

  async deactivateUser(
    tenantId: string,
    tenantSlug: string,
    userId: string
  ): Promise<User> {
    logger.info({ userId }, 'ユーザー無効化を開始します');

    // tenantSlug の検証（クロステナント攻撃の防止）
    const validatedSlug = await validateAndGetTenantSlug(tenantId, tenantSlug);

    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new Error('ユーザーが見つかりません');
    }

    // Disable in Keycloak if linked
    if (user.keycloakId) {
      await disableKeycloakUser(validatedSlug, user.keycloakId);
    }

    // Update status in database
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { status: 'INACTIVE' },
    });

    logger.info({ userId }, 'ユーザーを無効化しました');

    return updatedUser;
  }
}
