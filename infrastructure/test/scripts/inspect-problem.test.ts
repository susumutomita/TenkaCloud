import { describe, expect, it } from "vitest";
import { runInspect } from "../../../scripts/tenkacloud-problem";

/**
 * Issue #951 sub #5: `tenkacloud-problem.ts inspect <id>` の挙動を pin する。
 * 既存 4 問題で正しく metadata + template + cross-ref を dump できることを確認。
 */

describe("runInspect (#951 sub #5)", () => {
  it("hello-world: flag kind の scoring + template Outputs + cross-ref OK を含むべき", () => {
    const r = runInspect({ problemId: "hello-world" });
    expect(r.ok).toBe(true);
    const text = r.lines.join("\n");
    expect(text).toContain("=== Problem hello-world ===");
    expect(text).toContain("kind:             flag");
    expect(text).toContain("flagOutputKey:    ParameterValue");
    expect(text).toContain("Resources:  ParticipantViewerRole, HelloParameter");
    expect(text).toContain(
      "Outputs:    ParameterName, ParameterValue, NamePrefix, ParticipantViewerRoleArn",
    );
    expect(text).toContain("Cross-ref:  OK");
  });

  it("hello-world-battle: uptime-flat の endpoint registry を含むべき", () => {
    const r = runInspect({ problemId: "hello-world-battle" });
    expect(r.ok).toBe(true);
    const text = r.lines.join("\n");
    expect(text).toContain("Endpoint registry");
    expect(text).toContain("slot=frontend");
    expect(text).toContain("slot=api");
  });

  it("microservice-migration-battle: portal slots + phases + disruptions を含むべき", () => {
    const r = runInspect({ problemId: "microservice-migration-battle" });
    expect(r.ok).toBe(true);
    const text = r.lines.join("\n");
    expect(text).toContain("Portal slots");
    expect(text).toContain("RegistrationPanel");
    expect(text).toContain("StatusPanel");
    // 表示形式: ファイル存在 OK / 必須 PVR resource declared
    expect(text).toContain("(OK)");
  });

  it("security-battle-royale: uptime-multi の probedSlots を含むべき", () => {
    const r = runInspect({ problemId: "security-battle-royale" });
    expect(r.ok).toBe(true);
    const text = r.lines.join("\n");
    expect(text).toContain("kind:             uptime-multi");
    expect(text).toContain("probedSlots:");
  });

  it("存在しない problemId は ok=false を返すべき", () => {
    const r = runInspect({ problemId: "does-not-exist-12345" });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("not found");
  });
});
