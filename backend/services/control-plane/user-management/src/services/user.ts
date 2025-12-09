import type { User, UserRole, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import {
  createKeycloakUser,
  resetKeycloakPassword,
  disableKeycloakUser,
} from '../lib/keycloak';

const logger = createLogger('user-service');

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

    // Create user in Keycloak
    const keycloakResult = await createKeycloakUser(
      input.tenantSlug,
      input.email,
      input.name
    );

    // Create user in database
    const user = await prisma.user.create({
      data: {
        tenantId: input.tenantId,
        email: input.email,
        name: input.name,
        role: input.role ?? 'PARTICIPANT',
        status: 'PENDING',
        keycloakId: keycloakResult.keycloakId,
      },
    });

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

    const user = await prisma.user.update({
      where: { id: userId },
      data: { role },
    });

    // Verify tenant ownership
    if (user.tenantId !== tenantId) {
      throw new Error('ユーザーが見つかりません');
    }

    logger.info({ userId, role }, 'ユーザーロールを更新しました');

    return user;
  }

  async resetPassword(
    tenantId: string,
    tenantSlug: string,
    userId: string
  ): Promise<string> {
    logger.info({ userId }, 'パスワードリセットを開始します');

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
      tenantSlug,
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

    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new Error('ユーザーが見つかりません');
    }

    // Disable in Keycloak if linked
    if (user.keycloakId) {
      await disableKeycloakUser(tenantSlug, user.keycloakId);
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
