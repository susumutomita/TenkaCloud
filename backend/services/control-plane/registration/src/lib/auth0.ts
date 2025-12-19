import { randomBytes } from 'node:crypto';
import { createLogger } from './logger';

const logger = createLogger('auth0-client');

interface Auth0Config {
  domain: string;
  clientId: string;
  clientSecret: string;
  audience: string;
}

interface Auth0TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface Auth0Organization {
  id: string;
  name: string;
  display_name: string;
  branding?: {
    logo_url?: string;
    colors?: {
      primary?: string;
      page_background?: string;
    };
  };
  metadata?: Record<string, string>;
}

interface Auth0User {
  user_id: string;
  email: string;
  name: string;
  nickname?: string;
  picture?: string;
  created_at: string;
}

interface Auth0OrganizationMember {
  user_id: string;
  email: string;
  name: string;
  roles?: { id: string; name: string }[];
}

function validateConfig(): Auth0Config {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const domain = process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_MGMT_CLIENT_ID;
  const clientSecret = process.env.AUTH0_MGMT_CLIENT_SECRET;

  if (nodeEnv === 'production' && (!domain || !clientId || !clientSecret)) {
    throw new Error(
      'AUTH0_DOMAIN, AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET are required in production'
    );
  }

  return {
    domain: domain || 'dev-tenkacloud.auth0.com',
    clientId: clientId || 'test-client-id',
    clientSecret: clientSecret || 'test-client-secret',
    audience: `https://${domain || 'dev-tenkacloud.auth0.com'}/api/v2/`,
  };
}

const config = validateConfig();

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getManagementToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && cachedToken.expiresAt > now + 60000) {
    return cachedToken.token;
  }

  try {
    const response = await fetch(`https://${config.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        audience: config.audience,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Auth0 token request failed: ${response.status} ${error}`
      );
    }

    const data = (await response.json()) as Auth0TokenResponse;
    cachedToken = {
      token: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };

    logger.info('Auth0 Management API トークンを取得しました');
    return cachedToken.token;
  } catch (error) {
    logger.error({ error }, 'Auth0 トークン取得に失敗しました');
    throw error;
  }
}

async function auth0Request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getManagementToken();

  const response = await fetch(`https://${config.domain}/api/v2${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorData: { message?: string; error?: string } = {};
    try {
      errorData = JSON.parse(errorText);
    } catch {
      errorData = { message: errorText };
    }
    throw new Error(
      `Auth0 API error: ${response.status} ${errorData.message || errorData.error || errorText}`
    );
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

export async function createOrganization(
  name: string,
  displayName: string,
  metadata?: Record<string, string>
): Promise<Auth0Organization> {
  try {
    const org = await auth0Request<Auth0Organization>('/organizations', {
      method: 'POST',
      body: JSON.stringify({
        name,
        display_name: displayName,
        metadata,
      }),
    });

    logger.info({ orgId: org.id, name }, 'Organization を作成しました');
    return org;
  } catch (error) {
    if (error instanceof Error && error.message.includes('409')) {
      logger.info({ name }, 'Organization は既に存在します');
      const orgs = await auth0Request<Auth0Organization[]>(
        `/organizations/name/${name}`
      );
      return orgs as unknown as Auth0Organization;
    }
    logger.error({ error, name }, 'Organization 作成に失敗しました');
    throw error;
  }
}

export async function getOrganization(
  orgId: string
): Promise<Auth0Organization | null> {
  try {
    return await auth0Request<Auth0Organization>(`/organizations/${orgId}`);
  } catch {
    return null;
  }
}

export async function getOrganizationByName(
  name: string
): Promise<Auth0Organization | null> {
  try {
    return await auth0Request<Auth0Organization>(`/organizations/name/${name}`);
  } catch {
    return null;
  }
}

export async function createUser(
  email: string,
  name: string,
  password: string,
  connection: string = 'Username-Password-Authentication'
): Promise<Auth0User> {
  try {
    const user = await auth0Request<Auth0User>('/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        name,
        password,
        connection,
        email_verified: false,
        verify_email: true,
      }),
    });

    logger.info({ userId: user.user_id, email }, 'ユーザーを作成しました');
    return user;
  } catch (error) {
    logger.error({ error, email }, 'ユーザー作成に失敗しました');
    throw error;
  }
}

export async function getUserByEmail(email: string): Promise<Auth0User | null> {
  try {
    const users = await auth0Request<Auth0User[]>(
      `/users-by-email?email=${encodeURIComponent(email)}`
    );
    return users[0] || null;
  } catch {
    return null;
  }
}

export async function addMemberToOrganization(
  orgId: string,
  userId: string
): Promise<void> {
  try {
    await auth0Request(`/organizations/${orgId}/members`, {
      method: 'POST',
      body: JSON.stringify({ members: [userId] }),
    });

    logger.info({ orgId, userId }, 'ユーザーを Organization に追加しました');
  } catch (error) {
    logger.error(
      { error, orgId, userId },
      'Organization へのメンバー追加に失敗しました'
    );
    throw error;
  }
}

export async function assignRolesToMember(
  orgId: string,
  userId: string,
  roleIds: string[]
): Promise<void> {
  try {
    await auth0Request(`/organizations/${orgId}/members/${userId}/roles`, {
      method: 'POST',
      body: JSON.stringify({ roles: roleIds }),
    });

    logger.info({ orgId, userId, roleIds }, 'ロールを割り当てました');
  } catch (error) {
    logger.error(
      { error, orgId, userId, roleIds },
      'ロール割り当てに失敗しました'
    );
    throw error;
  }
}

export async function getOrganizationMembers(
  orgId: string
): Promise<Auth0OrganizationMember[]> {
  try {
    return await auth0Request<Auth0OrganizationMember[]>(
      `/organizations/${orgId}/members`
    );
  } catch {
    return [];
  }
}

export async function resetUserPassword(
  userId: string,
  newPassword: string
): Promise<void> {
  try {
    await auth0Request(`/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ password: newPassword }),
    });

    logger.info({ userId }, 'パスワードをリセットしました');
  } catch (error) {
    logger.error({ error, userId }, 'パスワードリセットに失敗しました');
    throw error;
  }
}

export async function updateUserStatus(
  userId: string,
  blocked: boolean
): Promise<void> {
  try {
    await auth0Request(`/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ blocked }),
    });

    logger.info({ userId, blocked }, 'ユーザーステータスを更新しました');
  } catch (error) {
    logger.error({ error, userId }, 'ユーザーステータス更新に失敗しました');
    throw error;
  }
}

function generateTemporaryPassword(): string {
  const chars =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
  const length = 16;
  const charCount = chars.length;
  const maxValidByte = Math.floor(256 / charCount) * charCount;

  const password: string[] = [];
  while (password.length < length) {
    const bytes = randomBytes(64);
    for (let i = 0; i < bytes.length && password.length < length; i++) {
      const byte = bytes[i];
      if (byte < maxValidByte) {
        password.push(chars.charAt(byte % charCount));
      }
    }
  }
  return password.join('');
}

export async function createAdminUser(
  orgName: string,
  email: string,
  name: string
): Promise<{ userId: string; temporaryPassword: string }> {
  const temporaryPassword = generateTemporaryPassword();

  try {
    let user = await getUserByEmail(email);

    if (!user) {
      user = await createUser(email, name, temporaryPassword);
    }

    const org = await getOrganizationByName(orgName);
    if (org) {
      await addMemberToOrganization(org.id, user.user_id);
    }

    logger.info({ orgName, email }, '管理者ユーザーを作成しました');

    return {
      userId: user.user_id,
      temporaryPassword,
    };
  } catch (error) {
    logger.error(
      { error, orgName, email },
      '管理者ユーザーの作成に失敗しました'
    );
    throw error;
  }
}

export const auth0Config = config;
