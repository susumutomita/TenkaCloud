/**
 * Problem Service Types
 */

import type { DynamoDBItem } from './base-types';

// Problem Type
export const ProblemType = {
  GAMEDAY: 'GAMEDAY',
  JAM: 'JAM',
} as const;

export type ProblemType = (typeof ProblemType)[keyof typeof ProblemType];

// Problem Category
export const ProblemCategory = {
  ARCHITECTURE: 'ARCHITECTURE',
  SECURITY: 'SECURITY',
  COST: 'COST',
  PERFORMANCE: 'PERFORMANCE',
  RELIABILITY: 'RELIABILITY',
  OPERATIONS: 'OPERATIONS',
} as const;

export type ProblemCategory =
  (typeof ProblemCategory)[keyof typeof ProblemCategory];

// Difficulty Level
export const DifficultyLevel = {
  EASY: 'EASY',
  MEDIUM: 'MEDIUM',
  HARD: 'HARD',
  EXPERT: 'EXPERT',
} as const;

export type DifficultyLevel =
  (typeof DifficultyLevel)[keyof typeof DifficultyLevel];

// Cloud Provider
export const CloudProvider = {
  AWS: 'AWS',
  GCP: 'GCP',
  AZURE: 'AZURE',
  LOCAL: 'LOCAL',
} as const;

export type CloudProvider = (typeof CloudProvider)[keyof typeof CloudProvider];

// Problem Template Status
export const ProblemTemplateStatus = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  ARCHIVED: 'ARCHIVED',
} as const;

export type ProblemTemplateStatus =
  (typeof ProblemTemplateStatus)[keyof typeof ProblemTemplateStatus];

// Template Type
export const TemplateType = {
  CLOUDFORMATION: 'CLOUDFORMATION',
  SAM: 'SAM',
  CDK: 'CDK',
  TERRAFORM: 'TERRAFORM',
  DEPLOYMENT_MANAGER: 'DEPLOYMENT_MANAGER',
  ARM: 'ARM',
  DOCKER_COMPOSE: 'DOCKER_COMPOSE',
} as const;

export type TemplateType = (typeof TemplateType)[keyof typeof TemplateType];

// Scoring Function Type
export const ScoringFunctionType = {
  LAMBDA: 'LAMBDA',
  CONTAINER: 'CONTAINER',
  API: 'API',
  MANUAL: 'MANUAL',
} as const;

export type ScoringFunctionType =
  (typeof ScoringFunctionType)[keyof typeof ScoringFunctionType];

// Problem Template Item
export interface ProblemTemplateItem extends DynamoDBItem {
  EntityType: 'PROBLEM_TEMPLATE';
  id: string;
  name: string;
  description: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  status: ProblemTemplateStatus;
  variables: unknown[];
  overviewTemplate: string;
  objectivesTemplate: string[];
  hintsTemplate: string[];
  prerequisites: string[];
  estimatedTimeMinutes?: number;
  providers: CloudProvider[];
  templateType: TemplateType;
  templateContent: string;
  regions: Record<string, string[]>;
  deploymentTimeout: number;
  scoringType: ScoringFunctionType;
  criteriaTemplate: unknown[];
  scoringTimeout: number;
  tags: string[];
  author: string;
  version: string;
  usageCount: number;
}

// Problem Template Domain Type
export interface ProblemTemplate {
  id: string;
  name: string;
  description: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  status: ProblemTemplateStatus;
  variables: unknown[];
  overviewTemplate: string;
  objectivesTemplate: string[];
  hintsTemplate: string[];
  prerequisites: string[];
  estimatedTimeMinutes?: number;
  providers: CloudProvider[];
  templateType: TemplateType;
  templateContent: string;
  regions: Record<string, string[]>;
  deploymentTimeout: number;
  scoringType: ScoringFunctionType;
  criteriaTemplate: unknown[];
  scoringTimeout: number;
  tags: string[];
  author: string;
  version: string;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// Problem Template Input Types
export interface CreateProblemTemplateInput {
  name: string;
  description: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  overviewTemplate: string;
  objectivesTemplate?: string[];
  hintsTemplate?: string[];
  prerequisites?: string[];
  estimatedTimeMinutes?: number;
  providers: CloudProvider[];
  templateType: TemplateType;
  templateContent: string;
  regions?: Record<string, string[]>;
  deploymentTimeout?: number;
  scoringType: ScoringFunctionType;
  criteriaTemplate?: unknown[];
  scoringTimeout?: number;
  tags?: string[];
  author: string;
}

export interface UpdateProblemTemplateInput {
  name?: string;
  description?: string;
  status?: ProblemTemplateStatus;
  overviewTemplate?: string;
  objectivesTemplate?: string[];
  hintsTemplate?: string[];
  templateContent?: string;
  criteriaTemplate?: unknown[];
  tags?: string[];
}
