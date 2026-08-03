import { describe, expect, it } from "bun:test";
import {
  BOOTSTRAP_FUNCTION,
  buildSecretPlan,
  editorUrl,
  parseArgs,
  parseBootstrapPayload,
  parseDeploymentId,
  parseScriptId,
  readScriptId,
  webAppUrl,
} from "./setup-core";

describe("parseArgs", () => {
  it("should default to the google-form environment and a real run", () => {
    const options = parseArgs([]);
    expect(options.environment).toBe("google-form");
    expect(options.repo).toBeNull();
    expect(options.skipWorkflow).toBe(false);
  });

  it("should accept an explicit repository and environment", () => {
    const options = parseArgs(["--repo", "owner/name", "--environment", "staging-form"]);
    expect(options.repo).toBe("owner/name");
    expect(options.environment).toBe("staging-form");
  });

  it("should accept --skip-workflow so the dry run can be triggered by hand", () => {
    expect(parseArgs(["--skip-workflow"]).skipWorkflow).toBe(true);
  });

  it("should reject a repository that is not owner/name", () => {
    expect(() => parseArgs(["--repo", "name-only"])).toThrow(/owner\/name/);
  });

  it("should reject an unknown flag instead of ignoring it", () => {
    expect(() => parseArgs(["--force"])).toThrow(/--force/);
  });

  it("should reject a flag that is missing its value", () => {
    expect(() => parseArgs(["--repo"])).toThrow(/--repo/);
  });
});

describe("readScriptId", () => {
  it("should return the script id recorded in .clasp.json", () => {
    expect(
      readScriptId('{"scriptId":"1a-Bc_dEfGhIjKlMnOpQrStUvWxYz0123456789","rootDir":"."}'),
    ).toBe("1a-Bc_dEfGhIjKlMnOpQrStUvWxYz0123456789");
  });

  it("should return null when the file is absent so the caller creates a project", () => {
    expect(readScriptId(null)).toBeNull();
  });

  it("should fail loudly on a corrupted .clasp.json rather than silently recreating a project", () => {
    expect(() => readScriptId("{not json")).toThrow(/\.clasp\.json/);
  });

  it("should reject a script id that cannot be an Apps Script id", () => {
    expect(() => readScriptId('{"scriptId":"short"}')).toThrow(/scriptId/);
  });
});

describe("parseScriptId", () => {
  it("should take the script id out of the clasp create output", () => {
    const stdout = [
      "Created new standalone script: https://script.google.com/d/1a-Bc_dEfGhIjKlMnOpQrStUvWxYz0123456789/edit",
      "Cloned 1 file.",
    ].join("\n");
    expect(parseScriptId(stdout)).toBe("1a-Bc_dEfGhIjKlMnOpQrStUvWxYz0123456789");
  });

  it("should fail when clasp printed no script id, instead of guessing one", () => {
    expect(() => parseScriptId("Authorization required")).toThrow(/script id/i);
  });
});

describe("parseDeploymentId", () => {
  it("should take the deployment id out of the clasp deploy output", () => {
    const stdout = ["Created version 3.", "- AKfycbwSample_Deployment-Id0123456789 @3."].join("\n");
    expect(parseDeploymentId(stdout)).toBe("AKfycbwSample_Deployment-Id0123456789");
  });

  it("should fail when no deployment id is present rather than building a broken URL", () => {
    expect(() => parseDeploymentId("Created version 3.")).toThrow(/deployment id/i);
  });
});

describe("webAppUrl", () => {
  it("should build the exec URL the workflow expects", () => {
    expect(webAppUrl("AKfycbwSample_Deployment-Id0123456789")).toBe(
      "https://script.google.com/macros/s/AKfycbwSample_Deployment-Id0123456789/exec",
    );
  });
});

describe("editorUrl", () => {
  it("should point at the Apps Script editor for the project", () => {
    expect(editorUrl("1a-Bc_dEfGhIjKlMnOpQrStUvWxYz0123456789")).toBe(
      "https://script.google.com/d/1a-Bc_dEfGhIjKlMnOpQrStUvWxYz0123456789/edit",
    );
  });
});

const validPayload = {
  formId: "1FAIpQLSc_form_id_that_is_long_enough_0123",
  syncToken: "0123456789abcdef0123456789abcdef",
  formResponseUrl: "https://docs.google.com/forms/d/e/1FAIpQLScSampleFormKey123/formResponse",
  responseSpreadsheetId: "1sheet_id_0123456789",
  notifyEmails: "ops@example.com",
};

describe("parseBootstrapPayload", () => {
  it("should accept the JSON that bootstrap prints", () => {
    const parsed = parseBootstrapPayload(JSON.stringify(validPayload));
    expect(parsed.formId).toBe(validPayload.formId);
    expect(parsed.syncToken).toBe(validPayload.syncToken);
    expect(parsed.formResponseUrl).toBe(validPayload.formResponseUrl);
  });

  it("should tolerate the log prefix the Apps Script editor adds around the JSON", () => {
    const logged = `6:02:11 PM\tInfo\t${JSON.stringify(validPayload)}\n`;
    expect(parseBootstrapPayload(logged).formId).toBe(validPayload.formId);
  });

  it("should reject a response URL that the landing page would refuse to use", () => {
    // 組織ドメイン付きの URL は LP 側の検証が弾く。 secrets を書く前にここで止める。
    const domainScoped = {
      ...validPayload,
      formResponseUrl:
        "https://docs.google.com/a/example.com/forms/d/e/1FAIpQLScSampleFormKey123/formResponse",
    };
    expect(() => parseBootstrapPayload(JSON.stringify(domainScoped))).toThrow(/formResponseUrl/);
  });

  it("should reject a viewform URL that was never rewritten to formResponse", () => {
    const viewform = {
      ...validPayload,
      formResponseUrl: "https://docs.google.com/forms/d/e/1FAIpQLScSampleFormKey123/viewform",
    };
    expect(() => parseBootstrapPayload(JSON.stringify(viewform))).toThrow(/formResponseUrl/);
  });

  it("should reject a sync token short enough to be guessable", () => {
    expect(() =>
      parseBootstrapPayload(JSON.stringify({ ...validPayload, syncToken: "abc" })),
    ).toThrow(/syncToken/);
  });

  it("should reject a missing form id", () => {
    // shorthand rest-sibling omit: the renamed form (`formId: _dropped`) reads as a real
    // unused binding to sonarjs/no-unused-vars, the shorthand one is recognised as an omit.
    const { formId, ...withoutFormId } = validPayload;
    expect(() => parseBootstrapPayload(JSON.stringify(withoutFormId))).toThrow(/formId/);
  });

  it("should name the bootstrap function when the pasted text is not JSON at all", () => {
    expect(() => parseBootstrapPayload("Exception: You do not have permission")).toThrow(
      BOOTSTRAP_FUNCTION,
    );
  });

  it("should reject an empty paste instead of writing empty secrets", () => {
    expect(() => parseBootstrapPayload("   ")).toThrow(/貼り付け/);
  });
});

describe("buildSecretPlan", () => {
  const plan = buildSecretPlan({
    clasprcJson: '{"token":{"access_token":"x"}}',
    scriptId: "1a-Bc_dEfGhIjKlMnOpQrStUvWxYz0123456789",
    webAppUrl: "https://script.google.com/macros/s/AKfycbwSample_Deployment-Id0123456789/exec",
    syncToken: "0123456789abcdef0123456789abcdef",
  });

  it("should set exactly the four secrets the workflow reads", () => {
    expect(plan.map((entry) => entry.name)).toEqual([
      "CLASPRC_JSON",
      "FORM_SCRIPT_ID",
      "FORM_WEBAPP_URL",
      "FORM_SYNC_TOKEN",
    ]);
  });

  it("should carry the value for every secret so none is written empty", () => {
    for (const entry of plan) {
      expect(entry.value.length).toBeGreaterThan(0);
    }
  });

  it("should refuse to build a plan when a value is missing", () => {
    expect(() =>
      buildSecretPlan({
        clasprcJson: "",
        scriptId: "1a-Bc_dEfGhIjKlMnOpQrStUvWxYz0123456789",
        webAppUrl: "https://script.google.com/macros/s/AKfycbwSample_Deployment-Id0123456789/exec",
        syncToken: "0123456789abcdef0123456789abcdef",
      }),
    ).toThrow(/CLASPRC_JSON/);
  });

  it("should refuse a web app URL that the workflow would reject", () => {
    expect(() =>
      buildSecretPlan({
        clasprcJson: '{"token":{}}',
        scriptId: "1a-Bc_dEfGhIjKlMnOpQrStUvWxYz0123456789",
        webAppUrl: "https://script.google.com/macros/s/AKfycb0123456789/dev",
        syncToken: "0123456789abcdef0123456789abcdef",
      }),
    ).toThrow(/FORM_WEBAPP_URL/);
  });
});
