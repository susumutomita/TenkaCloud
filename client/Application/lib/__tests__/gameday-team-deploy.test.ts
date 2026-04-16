import { describe, expect, it } from 'vitest';

import { getGameDayTeamDeploymentIssue } from '../api/gameday-team-deploy';

const baseProblem = {
  type: 'gameday' as const,
  deployment: {
    providers: ['aws' as const],
    timeout: 60,
    templates: {
      aws: {
        type: 'cloudformation' as const,
        path: 's3://templates/problem.yaml',
      },
    },
    regions: {
      aws: ['ap-northeast-1'],
    },
  },
};

describe('getGameDayTeamDeploymentIssue', () => {
  it('GameDay の AWS 問題はチーム配布可能と判定すべき', () => {
    expect(getGameDayTeamDeploymentIssue(baseProblem)).toBeNull();
  });

  it('GameDay 以外の問題は未対応と判定すべき', () => {
    expect(
      getGameDayTeamDeploymentIssue({
        ...baseProblem,
        type: 'jam',
      }),
    ).toBe('GameDay 問題のみチーム配布に対応しています。');
  });

  it('AWS provider がない問題は未対応と判定すべき', () => {
    expect(
      getGameDayTeamDeploymentIssue({
        ...baseProblem,
        deployment: {
          ...baseProblem.deployment,
          providers: ['local'],
          templates: {},
        },
      }),
    ).toBe('チーム配布には AWS デプロイ設定が必要です。');
  });

  it('AWS テンプレートがない問題は未対応と判定すべき', () => {
    expect(
      getGameDayTeamDeploymentIssue({
        ...baseProblem,
        deployment: {
          ...baseProblem.deployment,
          templates: {},
        },
      }),
    ).toBe('チーム配布には AWS テンプレートの設定が必要です。');
  });
});
