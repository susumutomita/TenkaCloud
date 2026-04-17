import type { OnePassStepResult } from '../../../packages/shared/src/quality';
import type {
  HarnessConfig,
  CliOptions,
  OnePassState,
  DevIdentityHeaders,
} from '../config';
import { createStep, gamedayAdminUrl, gamedayParticipantUrl } from '../config';
import { HttpError, requestJson, formatError } from '../http';

async function createSoloMembership(
  config: HarnessConfig,
  eventId: string,
  participantHeaders: DevIdentityHeaders,
): Promise<{ teamId: string }> {
  await requestJson(
    gamedayParticipantUrl(config, '/teams/solo'),
    {
      method: 'POST',
      body: JSON.stringify({ eventId }),
    },
    config.applicationParticipantToken,
    participantHeaders,
  );

  const membershipResponse = await requestJson<
    | { teamId: string }
    | {
        membership?: {
          teamId?: string;
        } | null;
      }
  >(
    gamedayParticipantUrl(
      config,
      `/teams/my-membership?eventId=${encodeURIComponent(eventId)}`,
    ),
    { method: 'GET' },
    config.applicationParticipantToken,
    participantHeaders,
  );

  const teamId =
    'teamId' in membershipResponse
      ? membershipResponse.teamId
      : membershipResponse.membership?.teamId;

  if (!teamId) {
    throw new Error('Participant team membership did not return a teamId');
  }

  return { teamId };
}

async function exerciseParticipantFlow(
  config: HarnessConfig,
  eventId: string,
  teamId: string,
  participantHeaders: DevIdentityHeaders,
  adminHeaders: DevIdentityHeaders,
): Promise<void> {
  const attacks = await requestJson<{ attacks: Array<{ id: string; slug: string }> }>(
    gamedayParticipantUrl(
      config,
      `/attacks/catalog?eventId=${encodeURIComponent(eventId)}`,
    ),
    { method: 'GET' },
    config.applicationParticipantToken,
    participantHeaders,
  );
  const attack = attacks.attacks[0];
  if (!attack) {
    throw new Error('Attack catalog is empty');
  }

  await requestJson(
    gamedayParticipantUrl(config, '/attacks/purchase'),
    {
      method: 'POST',
      body: JSON.stringify({ eventId, teamId, attackId: attack.id }),
    },
    config.applicationParticipantToken,
    participantHeaders,
  );

  await requestJson(
    gamedayParticipantUrl(config, '/attacks/execute'),
    {
      method: 'POST',
      body: JSON.stringify({
        eventId,
        teamId,
        attackId: attack.id,
        targetTeamId: 'one-pass-target',
      }),
    },
    config.applicationParticipantToken,
    participantHeaders,
  );

  await requestJson(
    gamedayAdminUrl(config, '/fault-injection/execute'),
    {
      method: 'POST',
      body: JSON.stringify({
        eventId,
        teamId,
        attackSlug: attack.slug,
      }),
    },
    config.applicationAdminToken,
    adminHeaders,
  );

  const defense = await requestJson<{ attacks: Array<{ attackId: string }> }>(
    gamedayParticipantUrl(
      config,
      `/defense/active?eventId=${encodeURIComponent(eventId)}&teamId=${encodeURIComponent(teamId)}`,
    ),
    { method: 'GET' },
    config.applicationParticipantToken,
    participantHeaders,
  );

  if (defense.attacks.length === 0) {
    throw new Error('Defense active list is empty after fault injection');
  }

  await requestJson(
    gamedayParticipantUrl(config, '/defense/hint'),
    {
      method: 'POST',
      body: JSON.stringify({ eventId, teamId, attackId: attack.id }),
    },
    config.applicationParticipantToken,
    participantHeaders,
  );

  await requestJson(
    gamedayParticipantUrl(config, '/defense/report-fix'),
    {
      method: 'POST',
      body: JSON.stringify({
        eventId,
        teamId,
        vulnerabilitySlug: attack.slug,
      }),
    },
    config.applicationParticipantToken,
    participantHeaders,
  );

  await requestJson(
    gamedayParticipantUrl(config, '/voting/vote'),
    {
      method: 'POST',
      body: JSON.stringify({
        eventId,
        teamId,
        votedForTeamId: 'one-pass-target',
      }),
    },
    config.applicationParticipantToken,
    participantHeaders,
  );

  const voting = await requestJson<{ results: unknown[] }>(
    gamedayParticipantUrl(
      config,
      `/voting/results?eventId=${encodeURIComponent(eventId)}`,
    ),
    { method: 'GET' },
    config.applicationParticipantToken,
    participantHeaders,
  );

  if (voting.results.length === 0) {
    throw new Error('Voting results are empty after submitting a vote');
  }
}

export async function runParticipantSteps(
  config: HarnessConfig,
  options: CliOptions,
  state: OnePassState,
): Promise<OnePassStepResult[]> {
  const steps: OnePassStepResult[] = [];

  if (state.event) {
    try {
      const registerResult = await requestJson<{ success: boolean; message: string }>(
        `${config.applicationParticipantApiBaseUrl}/participant/events/${state.event.id}/register`,
        { method: 'POST' },
        config.applicationParticipantToken,
        state.participantHeaders,
      );

      steps.push(
        createStep(
          '14',
          'participant register',
          registerResult.success ? 'passed' : 'failed',
          registerResult.message,
        ),
      );
    } catch (error) {
      steps.push(
        createStep(
          '14',
          'participant register',
          'failed',
          formatError(error),
        ),
      );
    }

    try {
      const myEvents = await requestJson<{ events: Array<{ id: string }> }>(
        `${config.applicationParticipantApiBaseUrl}/participant/events/me`,
        { method: 'GET' },
        config.applicationParticipantToken,
        state.participantHeaders,
      );
      const found = myEvents.events.some((candidate) => candidate.id === state.event?.id);

      steps.push(
        createStep(
          '15',
          'participant my events',
          found ? 'passed' : 'failed',
          found
            ? `registered event ${state.event.id} is present in /participant/events/me`
            : `registered event ${state.event.id} is missing from /participant/events/me`,
        ),
      );
    } catch (error) {
      steps.push(
        createStep(
          '15',
          'participant my events',
          'failed',
          formatError(error),
        ),
      );
    }

    let membership: { teamId: string } | null = null;
    try {
      membership = await createSoloMembership(config, state.event.id, state.participantHeaders);
      steps.push(
        createStep(
          '16',
          'participant team membership',
          'passed',
          `teamId=${membership.teamId}`,
        ),
      );
    } catch (error) {
      steps.push(
        createStep(
          '16',
          'participant team membership',
          'failed',
          formatError(error),
        ),
      );
    }

    if (membership) {
      try {
      await exerciseParticipantFlow(
        config,
        state.event.id,
        membership.teamId,
        state.participantHeaders,
        state.adminHeaders,
      );
      steps.push(
        createStep(
          '17',
          'attack / defense / vote',
          'passed',
          `eventId=${state.event.id} teamId=${membership.teamId}`,
        ),
      );
      } catch (error) {
        steps.push(
          createStep(
            '17',
            'attack / defense / vote',
            'failed',
            formatError(error),
          ),
        );
      }
    } else {
      steps.push(
        createStep(
          '17',
          'attack / defense / vote',
          'blocked',
          'team membership の確立に失敗したため実行できません。',
        ),
      );
    }

    try {
      await requestJson<{ url: string }>(
        `${config.applicationPlaneUrl}/api/participant/events/${state.event.id}/aws-console`,
        { method: 'GET' },
        undefined,
        state.participantHeaders,
      );

      steps.push(
        createStep(
          '18',
          'participant aws console',
          'passed',
          'aws console url generated',
        ),
      );
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.status === 404 &&
        /not configured/i.test(error.message)
      ) {
        steps.push(
          createStep(
            '18',
            'participant aws console',
            options.target === 'local' ? 'passed' : 'blocked',
            options.target === 'local'
              ? 'local mode は aws-console を fail-closed で確認しました。'
              : 'AWS Console role federation が event に接続されていません。',
            options.target === 'local'
              ? 'AWS_PARTICIPANT_ROLE_ARN を設定した場合は `--target=aws` の受け入れ条件で成功確認してください。'
              : 'deploy outputs か event settings から participant console role を解決する必要があります。',
          ),
        );
      } else {
        steps.push(
          createStep(
            '18',
            'participant aws console',
            'failed',
            formatError(error),
          ),
        );
      }
    }
  } else {
    steps.push(
      createStep(
        '14',
        'participant register',
        'blocked',
        'event create に失敗したため実行できません。',
      ),
    );
    steps.push(
      createStep(
        '15',
        'participant my events',
        'blocked',
        'event create に失敗したため実行できません。',
      ),
    );
    steps.push(
      createStep(
        '16',
        'participant team membership',
        'blocked',
        'event create に失敗したため実行できません。',
      ),
    );
    steps.push(
      createStep(
        '17',
        'attack / defense / vote',
        'blocked',
        'event create に失敗したため実行できません。',
      ),
    );
    steps.push(
      createStep(
        '18',
        'participant aws console',
        'blocked',
        'event create に失敗したため実行できません。',
      ),
    );
  }

  return steps;
}
