import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cdk from 'aws-cdk-lib';

const { shouldFailScriptLoad } = vi.hoisted(() => {
  return { shouldFailScriptLoad: { value: false } };
});

vi.mock('fs', async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import('fs');
  const realReadFileSync = mod.readFileSync.bind(mod);
  return {
    ...mod,
    readFileSync: (...args: Parameters<typeof mod.readFileSync>) => {
      const filePath = args[0];
      if (
        shouldFailScriptLoad.value &&
        typeof filePath === 'string' &&
        (filePath.endsWith('provision-tenant.sh') ||
          filePath.endsWith('deprovision-tenant.sh'))
      ) {
        throw new Error('ENOENT: no such file or directory');
      }
      return realReadFileSync(...args);
    },
  };
});

const { AppPlaneStack } = await import('../lib/app-plane-stack');
type AppPlaneStackProps = ConstructorParameters<typeof AppPlaneStack>[2];

describe('AppPlaneStack', () => {
  beforeEach(() => {
    shouldFailScriptLoad.value = false;
  });

  function createStack(overrides?: Partial<AppPlaneStackProps>): {
    stack: InstanceType<typeof AppPlaneStack>;
    template: cdk.assertions.Template;
  } {
    const app = new cdk.App();
    const stack = new AppPlaneStack(app, 'TestAppPlane', {
      eventBusArn:
        'arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus',
      ...overrides,
    });
    const template = cdk.assertions.Template.fromStack(stack);
    return { stack, template };
  }

  it('CoreApplicationPlane を作成すべき', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
  });

  it('ProvisioningScriptJob の CodeBuild プロジェクトを作成すべき', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Source: {
        Type: 'NO_SOURCE',
      },
    });
  });

  it('DeprovisioningScriptJob の CodeBuild プロジェクトを作成すべき', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::CodeBuild::Project', 2);
  });

  it('EventBridge ルールを作成すべき', () => {
    const { template } = createStack();
    template.resourcePropertiesCountIs(
      'AWS::Events::Rule',
      {
        State: 'ENABLED',
      },
      2
    );
  });

  it('既存の EventBus ARN を使用すべき', () => {
    const { template } = createStack({
      eventBusArn:
        'arn:aws:events:ap-northeast-1:123456789012:event-bus/custom-bus',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      EventBusName: 'custom-bus',
    });
  });

  it('プロビジョニングスクリプトを CodeBuild の buildspec に含むべき', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Source: {
        Type: 'NO_SOURCE',
        BuildSpec: cdk.assertions.Match.stringLikeRegexp(
          'TenkaCloud Tenant Provisioning'
        ),
      },
    });
  });

  it('eventBusArn なしでも EventManager を作成すべき', () => {
    const app = new cdk.App();
    const stack = new AppPlaneStack(app, 'TestAppPlaneNoArn', {
      eventBusArn: '',
    });
    const template = cdk.assertions.Template.fromStack(stack);
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
  });

  it('スクリプトファイルが存在しない場合はデフォルトスクリプトを使用すべき', () => {
    shouldFailScriptLoad.value = true;

    const app = new cdk.App();
    const stack = new AppPlaneStack(app, 'TestAppPlaneFallback', {
      eventBusArn:
        'arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus',
    });
    const template = cdk.assertions.Template.fromStack(stack);

    // Default scripts should still produce valid CodeBuild projects
    template.resourceCountIs('AWS::CodeBuild::Project', 2);

    // Default provisioning script uses the embedded fallback
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Source: {
        Type: 'NO_SOURCE',
        BuildSpec: cdk.assertions.Match.stringLikeRegexp('Provisioning tenant'),
      },
    });
  });
});
