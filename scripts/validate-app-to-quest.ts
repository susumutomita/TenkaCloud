#!/usr/bin/env bun
/**
 * Validate App-to-Quest authoring fixtures.
 *
 * This is a local authoring gate for issue #1824. It keeps the sample source
 * profile, risk inventory, quest candidates, and draft files aligned with the
 * App-to-Quest schemas before the workflow graduates into product UI work.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import Ajv from "ajv";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const FIXTURES_DIR = join(REPO_ROOT, "fixtures", "app-to-quest");
const SOURCE_PROFILE_SCHEMA_PATH = join(
  REPO_ROOT,
  ".claude",
  "skills",
  "create-problem",
  "references",
  "app-to-quest",
  "source-app-profile.schema.json",
);
const QUEST_CANDIDATE_SCHEMA_PATH = join(
  REPO_ROOT,
  ".claude",
  "skills",
  "create-problem",
  "references",
  "app-to-quest",
  "quest-candidate.schema.json",
);

type JsonObject = Record<string, unknown>;

type Candidate = {
  id: string;
  title: string;
  sourceEvidence: string[];
};

type CandidateSet = {
  candidates: Candidate[];
};

const REQUIRED_DRAFT_HEADINGS = [
  "## Source App Context",
  "## What Happens If Ignored",
  "## Mission",
  "## Success Criteria",
  "## Scoring Design",
  "## Safe Simulation Plan",
  "## Safety Notes",
] as const;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function rel(path: string): string {
  return relative(REPO_ROOT, path);
}

function formatAjvErrors(path: string, errors: NonNullable<ReturnType<Ajv["errorsText"]>>): string {
  return `${rel(path)}: ${errors}`;
}

function fixtureDirectories(): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .map((entry) => join(FIXTURES_DIR, entry))
    .filter((path) => statSync(path).isDirectory())
    .sort();
}

function hasObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasCandidateSet(value: unknown): value is CandidateSet {
  if (!hasObject(value) || !Array.isArray(value.candidates)) return false;
  return value.candidates.every((candidate) => {
    if (!hasObject(candidate)) return false;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.title === "string" &&
      Array.isArray(candidate.sourceEvidence) &&
      candidate.sourceEvidence.every((evidence) => typeof evidence === "string")
    );
  });
}

function validateJsonSchema(
  path: string,
  data: unknown,
  validate: ReturnType<Ajv["compile"]>,
  ajv: Ajv,
): string[] {
  if (validate(data)) return [];
  return [formatAjvErrors(path, ajv.errorsText(validate.errors))];
}

function validateCandidateCount(candidatesPath: string, candidates: Candidate[]): string[] {
  const errors: string[] = [];
  if (candidates.length < 5 || candidates.length > 10) {
    errors.push(
      `${rel(candidatesPath)}: expected 5 to 10 quest candidates, got ${candidates.length}`,
    );
  }
  return errors;
}

function validateUniqueCandidateIds(candidatesPath: string, candidates: Candidate[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      errors.push(`${rel(candidatesPath)}: duplicate candidate id "${candidate.id}"`);
    }
    seen.add(candidate.id);
  }
  return errors;
}

function validateCandidateDraft(draftsDir: string, candidate: Candidate): string[] {
  const errors: string[] = [];
  const draftPath = join(draftsDir, `${candidate.id}.md`);
  if (!existsSync(draftPath)) {
    return [`${rel(draftPath)}: draft file is required`];
  }
  const draft = readFileSync(draftPath, "utf8");
  for (const heading of REQUIRED_DRAFT_HEADINGS) {
    if (!draft.includes(heading)) {
      errors.push(`${rel(draftPath)}: missing heading "${heading}"`);
    }
  }
  return errors;
}

function validateSourceEvidence(
  fixtureDir: string,
  candidatesPath: string,
  candidate: Candidate,
): string[] {
  const errors: string[] = [];
  for (const evidence of candidate.sourceEvidence) {
    if (!existsSync(join(fixtureDir, evidence))) {
      errors.push(`${rel(candidatesPath)}: sourceEvidence "${evidence}" does not exist`);
    }
  }
  return errors;
}

function validateCandidates(
  fixtureDir: string,
  candidatesPath: string,
  draftsDir: string,
  candidates: Candidate[],
): string[] {
  return [
    ...validateCandidateCount(candidatesPath, candidates),
    ...validateUniqueCandidateIds(candidatesPath, candidates),
    ...candidates.flatMap((candidate) => validateCandidateDraft(draftsDir, candidate)),
    ...candidates.flatMap((candidate) =>
      validateSourceEvidence(fixtureDir, candidatesPath, candidate),
    ),
  ];
}

function validateFixture(fixtureDir: string): string[] {
  const expectedDir = join(fixtureDir, "expected");
  const profilePath = join(expectedDir, "01-source-app-profile.json");
  const riskInventoryPath = join(expectedDir, "02-risk-inventory.md");
  const candidatesPath = join(expectedDir, "03-quest-candidates.json");
  const draftsDir = join(expectedDir, "problem-drafts");
  const ajv = new Ajv({ allErrors: true, strict: false });
  const profile = readJson(profilePath);
  const candidates = readJson(candidatesPath);
  const errors = [
    ...validateJsonSchema(
      profilePath,
      profile,
      ajv.compile(readJson(SOURCE_PROFILE_SCHEMA_PATH)),
      ajv,
    ),
    ...validateJsonSchema(
      candidatesPath,
      candidates,
      ajv.compile(readJson(QUEST_CANDIDATE_SCHEMA_PATH)),
      ajv,
    ),
  ];

  if (!existsSync(riskInventoryPath)) {
    errors.push(`${rel(riskInventoryPath)}: file is required`);
  }
  if (!hasCandidateSet(candidates)) {
    errors.push(`${rel(candidatesPath)}: expected an object with candidates[]`);
    return errors;
  }
  errors.push(...validateCandidates(fixtureDir, candidatesPath, draftsDir, candidates.candidates));

  return errors;
}

const fixtures = fixtureDirectories();
const errors = fixtures.flatMap(validateFixture);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`OK app-to-quest fixtures (${fixtures.length})`);
