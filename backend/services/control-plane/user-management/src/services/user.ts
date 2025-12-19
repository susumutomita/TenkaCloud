import {
  UserRepository,
  TenantRepository,
  type User,
  type UserRole,
  type UserStatus,
} from '@tenkacloud/dynamodb';
import { createLogger } from '../lib/logger';
import {
  createAuth0User,
  resetAuth0Password,
  disableAuth0User,
  deleteAuth0User,
} from '../lib/auth0';

const logger = createLogger('user-service');

const userRepository = new UserRepository();
const tenantRepository = new TenantRepository();

/**
 * テナントの slug を検証し、tenantId に対応する正しい slug を返す
 * これにより、悪意のある tenantSlug ヘッダー改ざんを防ぐ
 */
async function validateAndGetTenantSlug(
  tenantId: string,
  providedSlug: string
): Promise<string> {
  const tenant = await tenantRepository.findById(tenantId);

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
  lastKey?: Record<string, unknown>;
}

export interface ListUsersResult {
  users: User[];
  total: number;
  lastKey?: Record<string, unknown>;
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

    // Check if email already exists for this tenant
    const existingUser = await userRepository.findByTenantAndEmail(
      input.tenantId,
      input.email
    );
    if (existingUser) {
      const error = new Error('このメールアドレスは既に登録されています');
      (error as Error & { code: string }).code = 'EMAIL_DUPLICATE';
      throw error;
    }

    const orgName = `tenant-${validatedSlug}`;
    const auth0Result = await createAuth0User(orgName, input.email, input.name);

    let user: User;
    try {
      user = await userRepository.create({
        tenantId: input.tenantId,
        email: input.email,
        name: input.name,
        role: input.role ?? 'PARTICIPANT',
      });

      // Update user with Auth0 ID
      user = await userRepository.update(user.id, {
        auth0Id: auth0Result.auth0Id,
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
    const [listResult, total] = await Promise.all([
      userRepository.listByTenant(input.tenantId, {
        status: input.status,
        role: input.role,
        limit: input.limit ?? 50,
        lastKey: input.lastKey,
      }),
      userRepository.countByTenant(input.tenantId),
    ]);

    return {
      users: listResult.users,
      total,
      lastKey: listResult.lastKey,
    };
  }

  async getUserById(tenantId: string, userId: string): Promise<User | null> {
    const user = await userRepository.findById(userId);
    // Ensure user belongs to the requested tenant
    if (!user || user.tenantId !== tenantId) {
      return null;
    }
    return user;
  }

  async updateUserRole(
    tenantId: string,
    userId: string,
    role: UserRole
  ): Promise<User> {
    logger.info({ userId, role }, 'ユーザーロールを更新します');

    // First check if user exists and belongs to tenant
    const existingUser = await userRepository.findById(userId);
    if (!existingUser || existingUser.tenantId !== tenantId) {
      throw new Error('ユーザーが見つかりません');
    }

    const user = await userRepository.update(userId, { role });

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

    const user = await userRepository.findById(userId);

    if (!user || user.tenantId !== tenantId) {
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

    const user = await userRepository.findById(userId);

    if (!user || user.tenantId !== tenantId) {
      throw new Error('ユーザーが見つかりません');
    }

    if (user.auth0Id) {
      const orgName = `tenant-${validatedSlug}`;
      await disableAuth0User(orgName, user.auth0Id);
    }

    const updatedUser = await userRepository.update(userId, {
      status: 'INACTIVE',
    });

    logger.info({ userId }, 'ユーザーを無効化しました');

    return updatedUser;
  }
}
