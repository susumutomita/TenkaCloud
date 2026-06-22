import { describe, expect, it } from "vitest";
import { type ChallengeDefinition, publicStages } from "../src/challenge.js";
import { CLOUDFLARE_WORKERS_POLICY } from "../src/target-guard.js";

const challenge: ChallengeDefinition = {
  id: "demo",
  title: "Demo",
  targetPolicy: CLOUDFLARE_WORKERS_POLICY,
  stages: [
    {
      id: "0-deploy",
      title: "Deploy",
      probes: [
        {
          id: "secret-probe",
          request: { method: "GET", path: "/secret-path" },
          expect: { status: 200 },
          description: "公開",
        },
      ],
    },
  ],
};

describe("publicStages", () => {
  it("should expose only id + title and drop probes/expectations (trust boundary)", () => {
    const stages = publicStages(challenge);
    expect(stages).toEqual([{ id: "0-deploy", title: "Deploy" }]);
    expect(JSON.stringify(stages)).not.toContain("secret-path");
  });
});
