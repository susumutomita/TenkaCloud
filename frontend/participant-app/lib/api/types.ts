/**
 * API Types
 *
 * 参加者向け API の型定義
 */

// =============================================================================
// Event Types
// =============================================================================

export type EventStatus =
  | "draft"
  | "scheduled"
  | "active"
  | "paused"
  | "completed"
  | "cancelled";
export type ParticipantType = "individual" | "team";
export type ScoringType = "realtime" | "batch";
export type ProblemType = "gameday" | "jam";
export type CloudProvider = "aws" | "gcp" | "azure" | "local";
export type DifficultyLevel = "easy" | "medium" | "hard" | "expert";
export type ProblemCategory =
  | "architecture"
  | "security"
  | "cost"
  | "performance"
  | "reliability"
  | "operations";

export interface ParticipantEvent {
  id: string;
  name: string;
  type: ProblemType;
  status: EventStatus;
  startTime: string;
  endTime: string;
  timezone: string;
  participantType: ParticipantType;
  cloudProvider: CloudProvider;
  regions: string[];
  scoringType: ScoringType;
  leaderboardVisible: boolean;
  problemCount: number;
  participantCount: number;
  isRegistered: boolean;
  myRank?: number;
  myScore?: number;
}

export interface EventDetails extends ParticipantEvent {
  problems: ChallengeProblem[];
  teamInfo?: TeamInfo;
}

// =============================================================================
// Challenge/Problem Types
// =============================================================================

export interface ChallengeProblem {
  id: string;
  title: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  overview: string;
  objectives: string[];
  order: number;
  unlockTime?: string;
  isUnlocked: boolean;
  pointMultiplier: number;
  maxScore: number;
  myScore?: number;
  isCompleted: boolean;
  estimatedTimeMinutes?: number;
}

export interface ChallengeDetails extends ChallengeProblem {
  description: string;
  instructions: string[];
  hints: ChallengeHint[];
  resources: ChallengeResource[];
  scoringCriteria: ScoringCriterion[];
  awsAccountId?: string;
  awsConsoleUrl?: string;
  credentials?: AWSCredentials;
}

export interface ChallengeHint {
  id: string;
  content: string;
  costPoints: number;
  isRevealed: boolean;
}

export interface ChallengeResource {
  name: string;
  type: "link" | "document" | "video";
  url: string;
}

export interface ScoringCriterion {
  name: string;
  description: string;
  maxPoints: number;
  currentPoints?: number;
  isPassed?: boolean;
}

export interface AWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt: string;
  region: string;
}

// =============================================================================
// Team Types
// =============================================================================

export interface TeamInfo {
  id: string;
  name: string;
  members: TeamMember[];
  captainId: string;
  inviteCode?: string;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: "captain" | "member";
  joinedAt: string;
}

export interface CreateTeamInput {
  name: string;
}

export interface JoinTeamInput {
  inviteCode: string;
}

// =============================================================================
// Leaderboard Types
// =============================================================================

export interface LeaderboardEntry {
  rank: number;
  teamId?: string;
  participantId?: string;
  name: string;
  totalScore: number;
  problemScores: Record<string, number>;
  lastScoredAt?: string;
  trend?: "up" | "down" | "same";
  isMe?: boolean;
}

export interface Leaderboard {
  eventId: string;
  entries: LeaderboardEntry[];
  isFrozen: boolean;
  updatedAt: string;
  myPosition?: number;
}

// =============================================================================
// Submission Types
// =============================================================================

export interface Submission {
  id: string;
  problemId: string;
  eventId: string;
  submittedAt: string;
  status: "pending" | "scoring" | "completed" | "failed";
  score?: number;
  maxScore?: number;
  feedback?: SubmissionFeedback[];
}

export interface SubmissionFeedback {
  criterion: string;
  passed: boolean;
  score: number;
  maxScore: number;
  message?: string;
}

export interface SubmitAnswerInput {
  answer: string;
}

// =============================================================================
// JAM-specific Types (Answer-key based scoring)
// =============================================================================

export interface JamChallenge extends ChallengeDetails {
  clues: JamClue[];
  answerFormat: string;
  answerValidation?: string;
}

export interface JamClue {
  id: string;
  order: number;
  title: string;
  content: string;
  costPoints: number;
  isRevealed: boolean;
  revealedAt?: string;
}

export interface JamSubmission extends Submission {
  answer: string;
  isCorrect?: boolean;
  cluesUsed: number;
  clueDeduction: number;
}

// =============================================================================
// Participant Profile Types
// =============================================================================

export interface ParticipantProfile {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  totalEventsParticipated: number;
  totalScore: number;
  rank?: number;
  badges: Badge[];
  recentEvents: ParticipantEventSummary[];
}

export interface Badge {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  earnedAt: string;
}

export interface ParticipantEventSummary {
  eventId: string;
  eventName: string;
  eventType: ProblemType;
  participatedAt: string;
  finalRank: number;
  totalParticipants: number;
  score: number;
}
