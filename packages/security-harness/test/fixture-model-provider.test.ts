import { describe, expect, it } from "vitest";
import {
  FixtureModelProvider,
  fixtureFailure,
  fixtureSuccess,
} from "../src/fixture-model-provider.js";
import type { ModelProviderRequest } from "../src/model-provider.js";

function request(overrides: Partial<ModelProviderRequest> = {}): ModelProviderRequest {
  return {
    sessionId: "run-1-finder-0",
    focusArea: "documents-idor",
    systemPrompt: "sys",
    userPrompt: "user",
    maxOutputTokens: 100,
    ...overrides,
  };
}

describe("FixtureModelProvider: no live model call, ever", () => {
  it("should return scripted results in declaration order for a given focus area", async () => {
    const provider = new FixtureModelProvider({
      scripts: {
        "documents-idor": [
          fixtureSuccess("first"),
          fixtureSuccess("second"),
        ],
      },
    });
    const first = await provider.complete(request());
    const second = await provider.complete(request());
    expect(first.ok && first.response.outputText).toBe("first");
    expect(second.ok && second.response.outputText).toBe("second");
  });

  it("should track separate cursors per focus area", async () => {
    const provider = new FixtureModelProvider({
      scripts: {
        "area-a": [fixtureSuccess("a1")],
        "area-b": [fixtureSuccess("b1")],
      },
    });
    const a = await provider.complete(request({ focusArea: "area-a" }));
    const b = await provider.complete(request({ focusArea: "area-b" }));
    expect(a.ok && a.response.outputText).toBe("a1");
    expect(b.ok && b.response.outputText).toBe("b1");
  });

  it("should return an explicit invalid_response error for an undeclared focus area, never a silent empty success", async () => {
    const provider = new FixtureModelProvider({ scripts: {} });
    const result = await provider.complete(request({ focusArea: "unscripted" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("should repeat the last scripted entry once a script is exhausted, instead of throwing", async () => {
    const provider = new FixtureModelProvider({
      scripts: { "documents-idor": [fixtureSuccess("only")] },
    });
    await provider.complete(request());
    const second = await provider.complete(request());
    const third = await provider.complete(request());
    expect(second.ok && second.response.outputText).toBe("only");
    expect(third.ok && third.response.outputText).toBe("only");
  });

  it("should be able to script a scripted failure (rate limit, timeout, etc.)", async () => {
    const provider = new FixtureModelProvider({
      scripts: {
        "documents-idor": [fixtureFailure("rate_limited", "too many requests", true)],
      },
    });
    const result = await provider.complete(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("rate_limited");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("should default providerId/providerVersion but allow overriding them", () => {
    const defaulted = new FixtureModelProvider({ scripts: {} });
    expect(defaulted.providerId).toBe("fixture-no-model");
    const named = new FixtureModelProvider({
      scripts: {},
      providerId: "custom",
      providerVersion: "2.0.0",
    });
    expect(named.providerId).toBe("custom");
    expect(named.providerVersion).toBe("2.0.0");
  });
});
