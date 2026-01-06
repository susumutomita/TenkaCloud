import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS SDK clients
const mockSend = vi.fn();

// コマンドクラスのモック（instanceof チェックが機能するように）
class MockCreateLogGroupCommand {
  constructor(public input: unknown) {}
}
class MockDeleteLogGroupCommand {
  constructor(public input: unknown) {}
}
class MockDescribeLogGroupsCommand {
  constructor(public input: unknown) {}
}
class MockPutRetentionPolicyCommand {
  constructor(public input: unknown) {}
}
class MockTagLogGroupCommand {
  constructor(public input: unknown) {}
}

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  CreateLogGroupCommand: MockCreateLogGroupCommand,
  DeleteLogGroupCommand: MockDeleteLogGroupCommand,
  DescribeLogGroupsCommand: MockDescribeLogGroupsCommand,
  PutRetentionPolicyCommand: MockPutRetentionPolicyCommand,
  TagLogGroupCommand: MockTagLogGroupCommand,
}));

// 環境変数をリセット
beforeEach(() => {
  vi.stubEnv('AWS_ENDPOINT_URL', undefined);
});

describe('CloudWatch Logs Provisioner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('FREE tier では 30 日の保持期間で Log Group を作成すべき', async () => {
    mockSend.mockImplementation((command) => {
      if (command.constructor.name === 'DescribeLogGroupsCommand') {
        return Promise.resolve({ logGroups: [] });
      }
      return Promise.resolve({});
    });

    const { createTenantLogGroup } = await import('./cloudwatch-provisioner');

    const result = await createTenantLogGroup(
      'tenant-123',
      'test-tenant',
      'FREE'
    );

    expect(result.logGroupName).toBe('/tenkacloud/tenants/tenant-123');
    expect(result.retentionDays).toBe(30);
  });

  it('PRO tier では 90 日の保持期間で Log Group を作成すべき', async () => {
    mockSend.mockImplementation((command) => {
      if (command.constructor.name === 'DescribeLogGroupsCommand') {
        return Promise.resolve({ logGroups: [] });
      }
      return Promise.resolve({});
    });

    const { createTenantLogGroup } = await import('./cloudwatch-provisioner');

    const result = await createTenantLogGroup(
      'tenant-pro',
      'pro-tenant',
      'PRO'
    );

    expect(result.retentionDays).toBe(90);
  });

  it('ENTERPRISE tier では 365 日の保持期間で Log Group を作成すべき', async () => {
    mockSend.mockImplementation((command) => {
      if (command.constructor.name === 'DescribeLogGroupsCommand') {
        return Promise.resolve({ logGroups: [] });
      }
      return Promise.resolve({});
    });

    const { createTenantLogGroup } = await import('./cloudwatch-provisioner');

    const result = await createTenantLogGroup(
      'tenant-ent',
      'enterprise-tenant',
      'ENTERPRISE'
    );

    expect(result.retentionDays).toBe(365);
  });

  it('既存の Log Group がある場合はスキップすべき', async () => {
    mockSend.mockImplementation((command) => {
      if (command.constructor.name === 'DescribeLogGroupsCommand') {
        return Promise.resolve({
          logGroups: [
            {
              logGroupName: '/tenkacloud/tenants/tenant-existing',
              retentionInDays: 30,
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    const { createTenantLogGroup } = await import('./cloudwatch-provisioner');

    const result = await createTenantLogGroup(
      'tenant-existing',
      'existing-tenant',
      'FREE'
    );

    expect(result.logGroupName).toBe('/tenkacloud/tenants/tenant-existing');
  });

  it('LocalStack モードでは保持ポリシー設定をスキップすべき', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL', 'http://localhost:4566');

    mockSend.mockImplementation((command) => {
      if (command.constructor.name === 'DescribeLogGroupsCommand') {
        return Promise.resolve({ logGroups: [] });
      }
      if (command.constructor.name === 'PutRetentionPolicyCommand') {
        throw new Error('Should not be called in LocalStack mode');
      }
      return Promise.resolve({});
    });

    const { createTenantLogGroup } = await import('./cloudwatch-provisioner');

    // LocalStack ではエラーにならない（PutRetentionPolicyCommand がスキップされる）
    const result = await createTenantLogGroup(
      'tenant-local',
      'local-tenant',
      'FREE'
    );

    expect(result.logGroupName).toBe('/tenkacloud/tenants/tenant-local');
  });

  it('ResourceAlreadyExistsException を gracefully に処理すべき', async () => {
    const alreadyExistsError = new Error('Log group already exists');
    (alreadyExistsError as Error & { name: string }).name =
      'ResourceAlreadyExistsException';

    mockSend.mockImplementation((command) => {
      if (command.constructor.name === 'DescribeLogGroupsCommand') {
        return Promise.resolve({ logGroups: [] });
      }
      if (command.constructor.name === 'CreateLogGroupCommand') {
        return Promise.reject(alreadyExistsError);
      }
      return Promise.resolve({});
    });

    const { createTenantLogGroup } = await import('./cloudwatch-provisioner');

    const result = await createTenantLogGroup(
      'tenant-conflict',
      'conflict-tenant',
      'FREE'
    );

    expect(result.logGroupName).toBe('/tenkacloud/tenants/tenant-conflict');
  });

  it('Log Group 削除を成功すべき', async () => {
    mockSend.mockResolvedValue({});

    const { deleteTenantLogGroup } = await import('./cloudwatch-provisioner');

    await expect(deleteTenantLogGroup('tenant-123')).resolves.toBeUndefined();
  });

  it('存在しない Log Group の削除は成功すべき', async () => {
    const notFoundError = new Error('Log group not found');
    (notFoundError as Error & { name: string }).name =
      'ResourceNotFoundException';
    mockSend.mockRejectedValue(notFoundError);

    const { deleteTenantLogGroup } = await import('./cloudwatch-provisioner');

    await expect(deleteTenantLogGroup('nonexistent')).resolves.toBeUndefined();
  });

  it('Log Group 削除でエラー発生時に例外をスローすべき', async () => {
    mockSend.mockRejectedValue(new Error('Delete failed'));

    const { deleteTenantLogGroup } = await import('./cloudwatch-provisioner');

    await expect(deleteTenantLogGroup('tenant-error')).rejects.toThrow(
      'Delete failed'
    );
  });

  it('tier 変更時に保持期間を更新すべき', async () => {
    // LocalStack モードではないことを明示
    vi.stubEnv('AWS_ENDPOINT_URL', '');

    let retentionSet = 0;
    const { PutRetentionPolicyCommand } =
      await import('@aws-sdk/client-cloudwatch-logs');

    mockSend.mockImplementation((command) => {
      if (command instanceof PutRetentionPolicyCommand) {
        retentionSet = command.input?.retentionInDays;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const { updateLogGroupRetention } =
      await import('./cloudwatch-provisioner');

    await updateLogGroupRetention('tenant-upgrade', 'ENTERPRISE');

    expect(retentionSet).toBe(365);
  });

  it('LocalStack モードでは保持期間更新をスキップすべき', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL', 'http://localhost:4566');

    mockSend.mockImplementation(() => {
      throw new Error('Should not be called');
    });

    const { updateLogGroupRetention } =
      await import('./cloudwatch-provisioner');

    await expect(
      updateLogGroupRetention('tenant-local', 'ENTERPRISE')
    ).resolves.toBeUndefined();
  });
});
