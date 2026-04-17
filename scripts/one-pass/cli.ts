import {
  createOnePassReport,
  formatOnePassReportAsMarkdown,
  type OnePassStepResult,
} from '../../packages/shared/src/quality';
import {
  parseArgs,
  getConfig,
  timestampSuffix,
  createDevHeaders,
  type OnePassState,
} from './config';
import { formatError } from './http';
import { runHealthSteps } from './steps/health';
import { runTenantSteps } from './steps/tenant';
import { runAdminSteps } from './steps/admin';
import { runDeploySteps } from './steps/deploy';
import { runParticipantSteps } from './steps/participant';

export async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = getConfig(options.target);
  const startedAt = new Date().toISOString();
  const steps: OnePassStepResult[] = [];
  const runId = timestampSuffix();
  const devTenantId = `one-pass-${runId.toLowerCase()}`;
  const adminHeaders = createDevHeaders({
    userId: `tenant-admin-${runId.toLowerCase()}`,
    tenantId: devTenantId,
    roles: ['tenant-admin', 'organizer'],
  });
  const participantHeaders = createDevHeaders({
    userId: `participant-${runId.toLowerCase()}`,
    tenantId: devTenantId,
    roles: ['participant', 'competitor'],
  });

  const state: OnePassState = {
    runId,
    devTenantId,
    adminHeaders,
    participantHeaders,
    tenant: null,
    provisioningStatus: null,
    event: null,
    problem: null,
  };

  steps.push(...(await runHealthSteps(config, options, state)));
  steps.push(...(await runTenantSteps(config, options, state)));
  steps.push(...(await runAdminSteps(config, options, state)));
  steps.push(...(await runDeploySteps(config, options, state)));
  steps.push(...(await runParticipantSteps(config, options, state)));

  const report = createOnePassReport({
    target: options.target,
    startedAt,
    completedAt: new Date().toISOString(),
    steps,
  });

  console.log(formatOnePassReportAsMarkdown(report));

  if (
    report.overallStatus === 'failed' ||
    (!options.allowBlocked && report.overallStatus === 'blocked')
  ) {
    process.exitCode = 2;
  }
}

export function run() {
  main().catch((error: unknown) => {
    console.error('[one-pass] failed:', formatError(error));
    process.exitCode = 1;
  });
}
