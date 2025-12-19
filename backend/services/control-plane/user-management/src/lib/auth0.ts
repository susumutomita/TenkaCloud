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

interface Auth0User {
  user_id: string;
  email: string;
  name: string;
  nickname?: string;
  picture?: string;
  created_at: string;
}

function getConfig(): Auth0Config {
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

const config = getConfig();

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

export interface CreateUserResult {
  auth0Id: string;
  temporaryPassword: string;
}

export async function createAuth0User(
  _orgName: string,
  email: string,
  name: string
): Promise<CreateUserResult> {
  const temporaryPassword = generateTemporaryPassword();

  try {
    const user = await auth0Request<Auth0User>('/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        name,
        password: temporaryPassword,
        connection: 'Username-Password-Authentication',
        email_verified: false,
        verify_email: true,
      }),
    });

    logger.info({ email }, 'Auth0 user created');

    // Add user to organization if it exists
    const org = await getOrganizationByName(_orgName);
    if (org) {
      await addMemberToOrganization(org.id, user.user_id);
    }

    return {
      auth0Id: user.user_id,
      temporaryPassword,
    };
  } catch (error) {
    logger.error({ error, email }, 'Auth0 ユーザー作成に失敗しました');
    throw error;
  }
}

async function getOrganizationByName(
  name: string
): Promise<{ id: string; name: string } | null> {
  try {
    return await auth0Request<{ id: string; name: string }>(
      `/organizations/name/${name}`
    );
  } catch {
    return null;
  }
}

async function addMemberToOrganization(
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

export async function resetAuth0Password(
  _orgName: string,
  auth0Id: string
): Promise<string> {
  const temporaryPassword = generateTemporaryPassword();

  try {
    await auth0Request(`/users/${auth0Id}`, {
      method: 'PATCH',
      body: JSON.stringify({ password: temporaryPassword }),
    });

    logger.info({ auth0Id }, 'Auth0 password reset');

    return temporaryPassword;
  } catch (error) {
    logger.error({ error, auth0Id }, 'Auth0 パスワードリセットに失敗しました');
    throw error;
  }
}

export async function disableAuth0User(
  _orgName: string,
  auth0Id: string
): Promise<void> {
  try {
    await auth0Request(`/users/${auth0Id}`, {
      method: 'PATCH',
      body: JSON.stringify({ blocked: true }),
    });

    logger.info({ auth0Id }, 'Auth0 user disabled');
  } catch (error) {
    logger.error({ error, auth0Id }, 'Auth0 ユーザー無効化に失敗しました');
    throw error;
  }
}

export async function deleteAuth0User(
  _orgName: string,
  auth0Id: string
): Promise<void> {
  try {
    await auth0Request(`/users/${auth0Id}`, {
      method: 'DELETE',
    });

    logger.info({ auth0Id }, 'Auth0 user deleted');
  } catch (error) {
    logger.error({ error, auth0Id }, 'Auth0 ユーザー削除に失敗しました');
    throw error;
  }
}
