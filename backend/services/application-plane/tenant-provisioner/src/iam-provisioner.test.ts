import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS SDK clients
const mockSend = vi.fn();

// コマンドクラスのモック（instanceof チェックが機能するように）
class MockCreateRoleCommand {
  constructor(public input: unknown) {}
}
class MockGetRoleCommand {
  constructor(public input: unknown) {}
}
class MockPutRolePolicyCommand {
  constructor(public input: unknown) {}
}
class MockDeleteRoleCommand {
  constructor(public input: unknown) {}
}
class MockDeleteRolePolicyCommand {
  constructor(public input: unknown) {}
}

vi.mock('@aws-sdk/client-iam', () => ({
  IAMClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  CreateRoleCommand: MockCreateRoleCommand,
  GetRoleCommand: MockGetRoleCommand,
  PutRolePolicyCommand: MockPutRolePolicyCommand,
  DeleteRoleCommand: MockDeleteRoleCommand,
  DeleteRolePolicyCommand: MockDeleteRolePolicyCommand,
}));

// LocalStack 環境変数をリセット
beforeEach(() => {
  vi.stubEnv('AWS_ENDPOINT_URL', undefined);
  vi.stubEnv('AUTH0_DOMAIN', 'test.auth0.com');
  vi.stubEnv('AWS_ACCOUNT_ID', '123456789012');
});

describe('IAM Provisioner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('LocalStack モードでは IAM Role 作成をスキップすべき', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL', 'http://localhost:4566');

    const { createTenantRole } = await import('./iam-provisioner');

    const result = await createTenantRole(
      'tenant-123',
      'test-tenant',
      'FREE',
      'tenkacloud-data'
    );

    expect(result.roleName).toBe('tenkacloud-tenant-test-tenant');
    expect(result.roleArn).toContain('tenkacloud-tenant-test-tenant');
    // IAM API は呼ばれない
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('新規 IAM Role を作成すべき', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL', '');

    // GetRole が NoSuchEntityException を返す（存在しない）
    const noSuchEntityError = new Error('Role not found');
    (noSuchEntityError as Error & { name: string }).name =
      'NoSuchEntityException';

    const { CreateRoleCommand, GetRoleCommand, PutRolePolicyCommand } =
      await import('@aws-sdk/client-iam');

    mockSend.mockImplementation((command) => {
      if (command instanceof GetRoleCommand) {
        return Promise.reject(noSuchEntityError);
      }
      if (command instanceof CreateRoleCommand) {
        return Promise.resolve({
          Role: {
            RoleName: 'tenkacloud-tenant-test-tenant',
            Arn: 'arn:aws:iam::123456789012:role/tenkacloud-tenant-test-tenant',
          },
        });
      }
      if (command instanceof PutRolePolicyCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const { createTenantRole } = await import('./iam-provisioner');

    const result = await createTenantRole(
      'tenant-123',
      'test-tenant',
      'FREE',
      'tenkacloud-data'
    );

    expect(result.roleName).toBe('tenkacloud-tenant-test-tenant');
    expect(result.roleArn).toBe(
      'arn:aws:iam::123456789012:role/tenkacloud-tenant-test-tenant'
    );
  });

  it('既存の IAM Role がある場合はスキップすべき', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL', undefined);

    mockSend.mockResolvedValue({
      Role: {
        RoleName: 'tenkacloud-tenant-existing',
        Arn: 'arn:aws:iam::123456789012:role/tenkacloud-tenant-existing',
      },
    });

    const { createTenantRole } = await import('./iam-provisioner');

    const result = await createTenantRole(
      'tenant-123',
      'existing',
      'FREE',
      'tenkacloud-data'
    );

    expect(result.roleArn).toBe(
      'arn:aws:iam::123456789012:role/tenkacloud-tenant-existing'
    );
  });

  it('ENTERPRISE tier では追加の権限を付与すべき', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL', '');

    const noSuchEntityError = new Error('Role not found');
    (noSuchEntityError as Error & { name: string }).name =
      'NoSuchEntityException';
    let policyDocument: string | undefined;

    const { CreateRoleCommand, GetRoleCommand, PutRolePolicyCommand } =
      await import('@aws-sdk/client-iam');

    mockSend.mockImplementation((command) => {
      if (command instanceof GetRoleCommand) {
        return Promise.reject(noSuchEntityError);
      }
      if (command instanceof CreateRoleCommand) {
        return Promise.resolve({
          Role: {
            RoleName: 'tenkacloud-tenant-enterprise',
            Arn: 'arn:aws:iam::123456789012:role/tenkacloud-tenant-enterprise',
          },
        });
      }
      if (command instanceof PutRolePolicyCommand) {
        policyDocument = command.input?.PolicyDocument;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const { createTenantRole } = await import('./iam-provisioner');

    await createTenantRole(
      'tenant-ent-123',
      'enterprise',
      'ENTERPRISE',
      'tenkacloud-data'
    );

    // ENTERPRISE 用の S3 バケットポリシーが含まれていることを確認
    expect(policyDocument).toBeDefined();
    const policy = JSON.parse(policyDocument!);
    const s3DedicatedStatement = policy.Statement.find(
      (s: { Sid?: string }) => s.Sid === 'S3DedicatedBucketAccess'
    );
    expect(s3DedicatedStatement).toBeDefined();
    expect(s3DedicatedStatement.Resource).toContain(
      'arn:aws:s3:::tenkacloud-tenant-ent-123'
    );
  });

  it('LocalStack モードでは IAM Role 削除をスキップすべき', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL', 'http://localhost:4566');

    const { deleteTenantRole } = await import('./iam-provisioner');

    await deleteTenantRole('test-tenant');

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('IAM Role 削除でエラー発生時に例外をスローすべき', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL', undefined);

    mockSend.mockRejectedValue(new Error('Delete failed'));

    const { deleteTenantRole } = await import('./iam-provisioner');

    await expect(deleteTenantRole('test-tenant')).rejects.toThrow(
      'Delete failed'
    );
  });

  it('存在しない IAM Role の削除は成功すべき', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL', undefined);

    const noSuchEntityError = new Error('Role not found');
    (noSuchEntityError as Error & { name: string }).name =
      'NoSuchEntityException';
    mockSend.mockRejectedValue(noSuchEntityError);

    const { deleteTenantRole } = await import('./iam-provisioner');

    await expect(deleteTenantRole('nonexistent')).resolves.toBeUndefined();
  });
});
