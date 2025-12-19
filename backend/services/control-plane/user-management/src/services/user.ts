import type { User, UserRole, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import {
  createAuth0User,
  resetAuth0Password,
  disableAuth0User,
  deleteAuth0User,
} from '../lib/auth0';

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

    const validatedSlug = await validateAndGetTenantSlug(
      input.tenantId,
      input.tenantSlug
    );

    const orgName = `tenant-${validatedSlug}`;
    const auth0Result = await createAuth0User(orgName, input.email, input.name);

    let user: User;
    try {
      user = await prisma.user.create({
        data: {
          tenantId: input.tenantId,
          email: input.email,
          name: input.name,
          role: input.role ?? 'PARTICIPANT',
          status: 'PENDING',
          auth0Id: auth0Result.auth0Id,
        },
      });
    } catch (error) {
      logger.error(
        { auth0Id: auth0Result.auth0Id, error },
        'DB ユーザー作成失敗、Auth0 ユーザーをロールバックします'
      );
      try {
        await deleteAuth0User(orgName, auth0Result.auth0Id);
      } catch (rollbackError) {
        logger.error(
          { auth0Id: auth0Result.auth0Id, rollbackError },
          'Auth0 ロールバック失敗'
        );
      }
      throw error;
    }

    logger.info({ userId: user.id }, 'ユーザーを作成しました');

    return {
      user,
      temporaryPassword: auth0Result.temporaryPassword,
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

    const validatedSlug = await validateAndGetTenantSlug(tenantId, tenantSlug);

    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new Error('ユーザーが見つかりません');
    }

    if (!user.auth0Id) {
      throw new Error('Auth0ユーザーが紐付けられていません');
    }

    const orgName = `tenant-${validatedSlug}`;
    const temporaryPassword = await resetAuth0Password(orgName, user.auth0Id);

    logger.info({ userId }, 'パスワードリセットが完了しました');

    return temporaryPassword;
  }

  async deactivateUser(
    tenantId: string,
    tenantSlug: string,
    userId: string
  ): Promise<User> {
    logger.info({ userId }, 'ユーザー無効化を開始します');

    const validatedSlug = await validateAndGetTenantSlug(tenantId, tenantSlug);

    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new Error('ユーザーが見つかりません');
    }

    if (user.auth0Id) {
      const orgName = `tenant-${validatedSlug}`;
      await disableAuth0User(orgName, user.auth0Id);
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { status: 'INACTIVE' },
    });

    logger.info({ userId }, 'ユーザーを無効化しました');

    return updatedUser;
  }
}
