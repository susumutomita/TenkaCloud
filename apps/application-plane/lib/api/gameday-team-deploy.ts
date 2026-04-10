import type { AdminProblem } from '@/lib/api/admin-types';

type TeamDeployableProblem = Pick<AdminProblem, 'type' | 'deployment'>;

export function getGameDayTeamDeploymentIssue(
  problem: TeamDeployableProblem,
): string | null {
  if (problem.type !== 'gameday') {
    return 'GameDay 問題のみチーム配布に対応しています。';
  }

  if (!problem.deployment.providers.includes('aws')) {
    return 'チーム配布には AWS デプロイ設定が必要です。';
  }

  if (!problem.deployment.templates.aws) {
    return 'チーム配布には AWS テンプレートの設定が必要です。';
  }

  return null;
}

export function canDeployGameDayProblemToTeams(
  problem: TeamDeployableProblem,
): boolean {
  return getGameDayTeamDeploymentIssue(problem) === null;
}
