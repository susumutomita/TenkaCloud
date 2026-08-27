import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("Cognito / SAML IdP operations playbook", () => {
  const playbook = readRepoFile("docs/operations/cognito-saml-idp-playbook.md");

  it("is linked from both operator entry points", () => {
    const eventRunbook = readRepoFile("docs/operations/event-runbook.md");
    const deploymentGuide = readRepoFile("DEPLOYMENT_GUIDE.md");

    expect(eventRunbook).toContain(
      "[cognito-saml-idp-playbook.md](./cognito-saml-idp-playbook.md)",
    );
    expect(deploymentGuide).toContain(
      "[Cognito / SAML IdP operations playbook](./docs/operations/cognito-saml-idp-playbook.md)",
    );
  });

  it("keeps the documented Cognito SP values aligned with the setup UI", () => {
    const createIdpModal = readRepoFile(
      "apps/application-admin-console/src/pages/CreateIdpModal.tsx",
    );
    const cognitoHelpers = readRepoFile("apps/application-admin-console/src/lib/cognito.ts");
    const emailClaim = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";

    expect(createIdpModal).toMatch(/new URL\(\s*"\/saml2\/idpresponse"/);
    expect(cognitoHelpers).toMatch(/urn:amazon:cognito:sp:\$\{userPoolId\}/);
    expect(createIdpModal).toContain(emailClaim);

    expect(playbook).toContain("ID プロバイダ追加画面に表示される値をコピーする");
    expect(playbook).toContain("/saml2/idpresponse");
    expect(playbook).toContain("urn:amazon:cognito:sp:<user-pool-id>");
    expect(playbook).toContain(emailClaim);
  });

  it("documents the supported providers and the separate participant authentication path", () => {
    expect(playbook).toContain("Microsoft Entra ID");
    expect(playbook).toContain("Google Workspace");
    expect(playbook).toContain("AWS IAM Identity Center");
    expect(playbook).toContain("その他の SAML 2.0 IdP");
    expect(playbook).toContain("Participant Portal はチームログイン鍵");
    expect(playbook).toContain("samlIdpDirectory");
  });

  it("publishes the administrator SSO procedure in the public event manual", () => {
    const publicManualJa = readRepoFile(
      "apps/developer-portal/src/app/developers/docs/operate/run-an-event/page.ja.mdx",
    );
    const publicManualEn = readRepoFile(
      "apps/developer-portal/src/app/developers/docs/operate/run-an-event/page.mdx",
    );
    const publicHtmlJa = readRepoFile("landing/docs/operate/run-an-event/index.html");
    const publicHtmlEn = readRepoFile("landing/docs/operate/run-an-event/index.en.html");

    for (const source of [publicManualJa, publicManualEn, publicHtmlJa, publicHtmlEn]) {
      expect(source).toContain("AWS IAM Identity Center");
      expect(source).toContain("docs/operations/cognito-saml-idp-playbook.md");
    }
    expect(publicManualJa).toContain("管理者SSOを企業IdPに接続する");
    expect(publicManualEn).toContain("Connect administrator SSO to a corporate IdP");
  });
});
