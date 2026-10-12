import { expect, it } from "vitest";
import battle from "../../../problems/battles/hello-world-battle/metadata.json";
import challenge from "../../../problems/challenges/hello-world/metadata.json";
import { cloudSkillCatalog } from "../../lib/problem-deploy/handlers/event-handler/skill-catalog.js";
import type { ResolvedExecutionCatalog } from "../../lib/problem-deploy/handlers/shared/execution-catalog.js";

it("projects only the current source-backed metadata from the saved cloud catalog", () => {
  const catalog = {
    catalogKey: `catalogs/${"a".repeat(64)}.json`,
    skills: { [challenge.id]: challenge.skillEvidence, [battle.id]: battle.skillEvidence },
    scoring: { [challenge.id]: challenge.scoring, [battle.id]: battle.scoring },
  } as unknown as ResolvedExecutionCatalog;
  expect(cloudSkillCatalog(catalog, challenge.id)?.declarations[0]?.rule.source).toBe("flag");
  expect(cloudSkillCatalog(catalog, battle.id)?.declarations[0]?.rule.source).toBe("uptime");
  expect(cloudSkillCatalog(catalog, battle.id)?.revision).toBe(`sha256:${"a".repeat(64)}`);
  expect(cloudSkillCatalog(undefined, challenge.id)).toBeUndefined();
  expect(cloudSkillCatalog({ ...catalog, catalogKey: "unknown" }, challenge.id)).toBeUndefined();
  expect(cloudSkillCatalog({ ...catalog, skills: {} }, challenge.id)).toBeUndefined();
});

it("preserves unknown scoring classification without inferring a supported skill", () => {
  const catalog = {
    catalogKey: `catalogs/${"b".repeat(64)}.json`,
    skills: { [challenge.id]: challenge.skillEvidence },
    scoring: { [challenge.id]: { kind: 42 } },
  } as unknown as ResolvedExecutionCatalog;
  expect(cloudSkillCatalog(catalog, challenge.id)?.scoringKind).toBe("unknown");
  expect(cloudSkillCatalog({ ...catalog, scoring: {} }, challenge.id)?.scoringKind).toBe("unknown");
});

it("retains uptime-multi attack scoring as a kind that uptime evidence cannot assess", () => {
  const catalog = {
    catalogKey: `catalogs/${"c".repeat(64)}.json`,
    skills: { [battle.id]: battle.skillEvidence },
    scoring: {
      [battle.id]: {
        kind: "uptime-multi",
        pointsAllOk: 5,
        attackBlocked: { slot: "web", path: "/blocked", pointsPerBlock: 5 },
      },
    },
  } as unknown as ResolvedExecutionCatalog;
  expect(cloudSkillCatalog(catalog, battle.id)?.scoringKind).toBe("uptime-multi+attack-scoring");
});
