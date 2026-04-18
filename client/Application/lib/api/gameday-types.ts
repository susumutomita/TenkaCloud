/**
 * GameDay Security Battle Royale - Type Definitions
 */

export type AttackType = 'vulnerability' | 'chaos';
export type AllianceStatus = 'PENDING' | 'ACTIVE';
export type ScoreWeight = 'normal' | 'high';

export interface GameState {
  eventId: string;
  tenantId: string;
  isRunning: boolean;
  startedAt: string | null;
  scoreWeight: ScoreWeight;
  blackout: boolean;
  durationMinutes: number;
}

export interface Attack {
  id: string;
  name: string;
  slug: string;
  attackType: AttackType;
  targetVulnerability: string | null;
  description: string;
  purchaseCost: number;
  damage: number;
  reward: number;
  cooldownSeconds: number;
  defenseHint: string;
  hintCost: number;
}

export interface AttackPurchase {
  id: string;
  eventId: string;
  teamId: string;
  attackId: string;
  attackSlug: string;
  purchasedAt: string;
  lastUsedAt: string | null;
}

export interface AttackLog {
  id: string;
  eventId: string;
  attackerTeamId: string;
  defenderTeamId: string;
  attackId: string;
  attackSlug: string;
  success: boolean;
  neutralized: boolean;
  damage: number;
  reward: number;
  details: string;
  createdAt: string;
}

export interface Alliance {
  id: string;
  eventId: string;
  requesterTeamId: string;
  targetTeamId: string;
  status: AllianceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Vote {
  id: string;
  eventId: string;
  voterTeamId: string;
  votedForTeamId: string;
  createdAt: string;
}

export interface HealthCheckResult {
  id: string;
  eventId: string;
  teamId: string;
  checkType: 'website' | 'api';
  isHealthy: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  createdAt: string;
}

export interface Team {
  eventId: string;
  teamId: string;
  teamName: string;
  websiteUrl?: string;
  apiUrl?: string;
  score?: number;
}

export interface LeaderboardEntry {
  teamId: string;
  teamName: string;
  score: number;
  rank: number;
  attacksLaunched: number;
  attacksReceived: number;
  vulnerabilitiesFixed: number;
}

export interface AttackStats {
  attackSlug: string;
  attackName: string;
  totalExecutions: number;
  successRate: number;
}

export interface TeamDashboard {
  team: Team;
  score: number;
  healthChecks: HealthCheckResult[];
  recentAttacks: AttackLog[];
  activeAlliances: Alliance[];
}

export interface CooldownError {
  error: string;
  remainingSeconds: number;
}

export interface DeploymentStatus {
  deployed: boolean;
  status: string;
  outputs: Record<string, string> | null;
  roleArn: string | null;
  externalId: string | null;
  competitorAccountId: string | null;
  region: string | null;
  error: string | null;
}
