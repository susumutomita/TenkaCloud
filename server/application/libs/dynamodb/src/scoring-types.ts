/**
 * Scoring Service Types
 */

import type { DynamoDBItem } from './base-types';

// Evaluation Category
export const EvaluationCategory = {
  INFRASTRUCTURE: 'INFRASTRUCTURE',
  COST: 'COST',
  SECURITY: 'SECURITY',
  PERFORMANCE: 'PERFORMANCE',
  RELIABILITY: 'RELIABILITY',
} as const;

export type EvaluationCategory =
  (typeof EvaluationCategory)[keyof typeof EvaluationCategory];

// Severity
export const Severity = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INFO: 'INFO',
} as const;

export type Severity = (typeof Severity)[keyof typeof Severity];

// Evaluation Status
export const EvaluationStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type EvaluationStatus =
  (typeof EvaluationStatus)[keyof typeof EvaluationStatus];

// Terraform Snapshot (stored as JSON in ScoringSession)
export interface TerraformSnapshot {
  stateVersion: number;
  resourceCount: number;
  stateData: unknown;
}

// Evaluation Item Result (stored as JSON in ScoringSession)
export interface EvaluationItemResult {
  criteriaId: string;
  score: number;
  maxScore: number;
  passed: boolean;
  actualValue?: string;
  expectedValue?: string;
  details?: Record<string, unknown>;
}

// Feedback (stored as JSON in ScoringSession)
export interface ScoringFeedback {
  category: EvaluationCategory;
  severity: Severity;
  title: string;
  message: string;
  suggestion?: string;
  resourceRef?: string;
}

// Criteria Detail (stored as JSON in EvaluationCriteria)
export interface CriteriaDetail {
  ruleKey: string;
  ruleValue: string;
  points: number;
  severity: Severity;
  description?: string;
}

// Scoring Session Item
export interface ScoringSessionItem extends DynamoDBItem {
  EntityType: 'SCORING_SESSION';
  id: string;
  tenantId: string;
  battleId?: string;
  participantId: string;
  status: EvaluationStatus;
  totalScore: number;
  maxPossibleScore: number;
  submittedAt?: string;
  evaluatedAt?: string;
  terraformSnapshot?: TerraformSnapshot;
  evaluationItems?: EvaluationItemResult[];
  feedbacks?: ScoringFeedback[];
}

// Evaluation Criteria Item
export interface EvaluationCriteriaItem extends DynamoDBItem {
  EntityType: 'EVALUATION_CRITERIA';
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  category: EvaluationCategory;
  weight: number;
  maxScore: number;
  isActive: boolean;
  criteriaDetails?: CriteriaDetail[];
}

// Scoring Domain Types
export interface ScoringSession {
  id: string;
  tenantId: string;
  battleId?: string;
  participantId: string;
  status: EvaluationStatus;
  totalScore: number;
  maxPossibleScore: number;
  submittedAt?: Date;
  evaluatedAt?: Date;
  terraformSnapshot?: TerraformSnapshot;
  evaluationItems?: EvaluationItemResult[];
  feedbacks?: ScoringFeedback[];
  createdAt: Date;
  updatedAt: Date;
}

export interface EvaluationCriteria {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  category: EvaluationCategory;
  weight: number;
  maxScore: number;
  isActive: boolean;
  criteriaDetails?: CriteriaDetail[];
  createdAt: Date;
  updatedAt: Date;
}

// Scoring Input Types
export interface CreateScoringSessionInput {
  tenantId: string;
  battleId?: string;
  participantId: string;
}

export interface CreateEvaluationCriteriaInput {
  tenantId: string;
  name: string;
  description?: string;
  category: EvaluationCategory;
  weight?: number;
  maxScore?: number;
  criteriaDetails?: CriteriaDetail[];
}

export interface UpdateScoringSessionInput {
  status?: EvaluationStatus;
  totalScore?: number;
  maxPossibleScore?: number;
  submittedAt?: Date;
  evaluatedAt?: Date;
  terraformSnapshot?: TerraformSnapshot;
  evaluationItems?: EvaluationItemResult[];
  feedbacks?: ScoringFeedback[];
}

export interface UpdateEvaluationCriteriaInput {
  name?: string;
  description?: string;
  category?: EvaluationCategory;
  weight?: number;
  maxScore?: number;
  isActive?: boolean;
  criteriaDetails?: CriteriaDetail[];
}
