/**
 * GameDay Deployments page helpers — types, status formatting, API fetchers.
 */

export interface CompetitorAccount {
  id: string;
  name: string;
  provider: string;
  accountId: string;
  region: string;
  roleArn?: string;
  externalId?: string;
  status: string;
}

export interface DeploymentJob {
  id: string;
  eventId: string;
  problemId: string;
  competitorAccountId: string;
  teamName?: string;
  awsAccountId?: string;
  provider: string;
  region: string;
  status: string;
  stackName?: string;
  stackId?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
}

export type StatusType =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'loading'
  | 'stopped'
  | 'in-progress'
  | 'pending';

export function mapJobStatus(status: string): StatusType {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
    case 'rolled_back':
      return 'error';
    case 'in_progress':
      return 'in-progress';
    case 'rollback_in_progress':
      return 'warning';
    case 'pending':
    case 'queued':
      return 'pending';
    case 'cancelled':
      return 'stopped';
    default:
      return 'info';
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Complete';
    case 'failed':
      return 'Failed';
    case 'in_progress':
      return 'In Progress';
    case 'rollback_in_progress':
      return 'Rolling Back';
    case 'rolled_back':
      return 'Rolled Back';
    case 'pending':
      return 'Pending';
    case 'queued':
      return 'Queued';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

export function hasActiveJobs(jobs: DeploymentJob[]): boolean {
  return jobs.some(
    (j) =>
      j.status === 'pending' ||
      j.status === 'queued' ||
      j.status === 'in_progress',
  );
}

/**
 * Shallow compare two job lists on the fields the UI renders. Lets the polling
 * loop skip a setState (and the table re-render) when nothing actually changed.
 */
export function jobsEqual(a: DeploymentJob[], b: DeploymentJob[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.status !== y.status ||
      x.stackName !== y.stackName ||
      x.error !== y.error ||
      x.retryCount !== y.retryCount ||
      x.completedAt !== y.completedAt
    ) {
      return false;
    }
  }
  return true;
}

export async function fetchAccounts(
  eventId: string,
): Promise<{ accounts: CompetitorAccount[] }> {
  const res = await fetch(`/api/admin/events/${eventId}/competitor-accounts`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createAccount(
  eventId: string,
  data: Omit<CompetitorAccount, 'id' | 'status'>,
): Promise<CompetitorAccount> {
  const res = await fetch(`/api/admin/events/${eventId}/competitor-accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteAccount(
  eventId: string,
  accountId: string,
): Promise<void> {
  const res = await fetch(
    `/api/admin/events/${eventId}/competitor-accounts/${accountId}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(await res.text());
}

export async function fetchJobs(
  eventId: string,
  problemId: string,
): Promise<{ jobs: DeploymentJob[] }> {
  const res = await fetch(
    `/api/admin/events/${eventId}/problems/${problemId}/deployments`,
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function startDeploy(
  eventId: string,
  problemId: string,
): Promise<{ jobs: DeploymentJob[] }> {
  const res = await fetch(
    `/api/admin/events/${eventId}/problems/${problemId}/deploy`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function retryJobApi(
  eventId: string,
  problemId: string,
  jobId: string,
): Promise<{ job: DeploymentJob }> {
  const res = await fetch(
    `/api/admin/events/${eventId}/problems/${problemId}/deployments/${jobId}/retry`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
