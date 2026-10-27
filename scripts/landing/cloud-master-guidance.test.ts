import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { ALL_RULES_AT, LESSONS } from "../../landing/cloud-master/curriculum.js";
import { explanationCard } from "../../landing/cloud-master/explanation.js";
import coverage from "../../landing/cloud-master/guardduty-coverage.json";
import { loadQuestionLocale, questionView } from "../../landing/cloud-master/question-locales.js";
import {
  availableScenarios,
  createQuestionStream,
  nextQuestion,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
await loadQuestionLocale("en");
function question(id: string, danger: boolean) {
  const stream = createQuestionStream(catalog, 91);
  Object.assign(stream, {
    elapsed: ALL_RULES_AT,
    scenarioTier: LESSONS.length,
    scenarioBag: [availableScenarios(catalog).find((s) => s.id === id)],
    outcomes: [danger],
  });
  return nextQuestion(stream);
}

test("every normal contrast avoids long-term key creation and SSH authorization", () => {
  for (const s of availableScenarios(catalog)) {
    const q = question(s.id, false);
    expect(q.danger).toBe(false);
    expect(q.wire).not.toMatch(/CreateAccessKey|CreateServiceSpecificCredential|SendSSHPublicKey/);
    if (q.operation === "AuthorizeSecurityGroupIngress")
      expect(
        q.parameters.IpPermissions?.some((p: { FromPort?: number }) => p.FromPort === 22),
      ).not.toBe(true);
  }
});
test("bots use constrained federation; attempted IAM keys remain review-needed", () => {
  const normal = question("IAMAccessKeyCreated", false);
  const flag = question("IAMAccessKeyCreated", true);
  expect(normal.operation).toBe("AssumeRoleWithWebIdentity");
  expect(normal.parameters.RoleArn).toBe("arn:aws:iam::111122223333:role/build-role");
  expect(normal.parameters.WebIdentityToken).toBe("[REDACTED]");
  expect(normal.context.policy).toContain("信頼条件確認済み");
  expect(flag.operation).toBe("CreateAccessKey");
  expect(flag.parameters.UserName).toBe("build-bot");
  expect(flag.danger).toBe(true);
  expect(questionView(normal, "en").reason).toContain("scoped build role");
});
test("human normal cases use verified workforce federation rather than IAM passwords", () => {
  for (const id of ["IAMUserLoginProfileCreated", "IAMUserLoginProfileUpdated"]) {
    const q = question(id, false);
    expect(q.operation).toBe("AssumeRoleWithSAML");
    expect(q.parameters.SAMLAssertion).toBe("[REDACTED]");
    expect(q.context.policy).toContain("MFA");
  }
  const mfa = question("ConsoleLoginWithoutMFA", true);
  expect(mfa.parameters).toEqual({});
  expect(mfa.metadata.idpMfaVerified).toBe("No");
  expect(mfa.why).toContain("MFAUsedだけで判断しません");
});
test("managed recovery uses a Session Manager shell; even restricted SSH is flagged", () => {
  for (const id of ["EC2InstanceSSHKeyPushed", "EC2PasswordDataRetrieved"])
    expect(question(id, false).parameters.DocumentName).toBe("SSM-SessionManagerRunShell");
  const normal = question("EC2SecurityGroupPublicSSH", false);
  const flag = question("EC2SecurityGroupPublicSSH", true);
  expect(normal.operation).toBe("RevokeSecurityGroupIngress");
  expect(flag.operation).toBe("AuthorizeSecurityGroupIngress");
  expect(flag.parameters.IpPermissions[0].IpRanges[0].CidrIp).toBe("192.0.2.0/24");
  expect(flag.danger).toBe(true);
  for (const q of [normal, flag]) {
    expect(questionView(q, "en").payload).toBe(`Context.operation: ${q.operation}`);
    expect(questionView(q, "en").payload).not.toContain("CidrIp:");
  }
});
test("all 520 explanations distinguish exercise policy from real findings in both languages", () => {
  for (const s of availableScenarios(catalog))
    for (const danger of [false, true]) {
      const q = question(s.id, danger);
      expect(q.context.policy).not.toStartWith("演習方針 / ");
      expect(explanationCard(q).fullReason).toContain("GuardDuty findingの有無は判定しません");
      const en = questionView(q, "en");
      expect(en.policy).not.toStartWith("Exercise policy / ");
      expect(en.fullReason).toContain("not whether GuardDuty creates a finding");
      expect(en.fullReason).toContain("Passing is not proof of safety");
      if (!s.family && q.serviceId !== "signin") {
        const model = catalog.find((m) => m.id === q.serviceId);
        if (model) expect(model.operations.some((op) => op[0] === q.operation)).toBe(true);
      }
    }
});
test("IAM Tor observations use exit-node reputation and never authorize new keys", () => {
  for (const id of ["Recon:IAMUser/TorIPCaller", "UnauthorizedAccess:IAMUser/TorIPCaller"]) {
    const q = question(id, true);
    expect(q.context.policy).toContain("Tor出口");
    expect(questionView(q, "en").policy).toContain("Tor exit");
    expect(q.payload).not.toContain("CreateAccessKey");
  }
});
test("credential export contrasts distinguish other AWS accounts and external egress", () => {
  for (const resource of ["Instance", "Resource"]) {
    const inside = question(
      `UnauthorizedAccess:IAMUser/${resource}CredentialExfiltration.InsideAWS`,
      true,
    );
    const outside = question(
      `UnauthorizedAccess:IAMUser/${resource}CredentialExfiltration.OutsideAWS`,
      true,
    );
    expect(inside.context.actual).toContain("別アカウント444455556666");
    expect(outside.context.actual).toContain("AWS外");
    expect(outside.teachingNote).toContain("egress");
  }
});
test("least privilege normal example uses a dedicated service account", () => {
  const id = "Policy:Kubernetes/AdminAccessToDefaultServiceAccount";
  const normal = question(id, false);
  const flag = question(id, true);
  expect(normal.payload).toContain("system:serviceaccount:app:viewer");
  expect(normal.payload).not.toContain("system:serviceaccount:default:default");
  expect(flag.payload).toContain("system:serviceaccount:default:default");
});
test("Bedrock environment scope and network telemetry sources remain explicit", () => {
  const bedrock = question("DefenseEvasion:IAMUser/BedrockLoggingDisabled", true);
  expect(bedrock.payload).toContain("account/Region");
  expect(bedrock.teachingNote).toContain("引数なし");
  for (const id of [
    "UnauthorizedAccess:EC2/SSHBruteForce",
    "UnauthorizedAccess:EC2/RDPBruteForce",
  ]) {
    const q = question(id, true);
    expect(q.payload).toContain("VPC flow");
    expect(q.teachingNote).toContain("認証失敗ログからの検知とは扱いません");
    expect(q.why).toContain("演習");
  }
});

test("coverage examples pair sampled threat indicators with the same displayed baseline", () => {
  const scenarios = new Map(availableScenarios(catalog).map((s) => [s.id, s]));
  for (const row of [
    ...coverage.active,
    ...coverage.customSignals,
    ...coverage.runtimeCustomSignals,
  ]) {
    const example = row.educationalEvidence;
    const scenario = scenarios.get(example.caseId);
    if (
      typeof scenario.flag !== "string" ||
      !(/^203\.0\.113\.\d+$/.test(scenario.flag) || /^edge-[a-f0-9]+\.example$/.test(scenario.flag))
    )
      continue;
    const observed = example.flaggedExample.split("\n")[0].split(": ").slice(1).join(": ");
    expect(example.assumptions).toContain(observed);
    expect(example.normalExample.split("\n")[0]).not.toBe(example.flaggedExample.split("\n")[0]);
  }
});
