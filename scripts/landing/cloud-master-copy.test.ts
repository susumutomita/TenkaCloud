import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { LESSONS } from "../../landing/cloud-master/curriculum.js";
import { EVIDENCE_SCENARIOS } from "../../landing/cloud-master/evidence-scenarios.js";
import { explanationCard } from "../../landing/cloud-master/explanation.js";
import { API_COPY } from "../../landing/cloud-master/explanation-copy.js";
import coverage from "../../landing/cloud-master/guardduty-coverage.json";
import { EN_SCENARIOS } from "../../landing/cloud-master/locales/en-scenarios.js";
import {
  availableScenarios,
  createQuestionStream,
  nextQuestion,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
const officialDocsUrl = /^https:\/\/docs\.aws\.amazon\.com\//;
function checkCase(s: ReturnType<typeof availableScenarios>[number], danger: boolean) {
  const stream = createQuestionStream(catalog, 37);
  Object.assign(stream, {
    elapsed: 300000,
    taughtLevel: LESSONS.length,
    scenarioTier: LESSONS.length,
    scenarioBag: [s],
    outcomes: [danger],
  });
  const q = nextQuestion(stream),
    v = explanationCard(q);
  expect(v.field).toBe(q.decisionField);
  expect(v.actual).toBe(
    typeof q.context.actual === "string" ? q.context.actual : JSON.stringify(q.context.actual),
  );
  expect(v.source).toMatch(officialDocsUrl);
  expect(v.fullReason).toBe(q.why);
  expect(v.reason).not.toBe("表示された対象・用途の範囲内です。");
  expect(v.headline).toBeDefined();
  expect(v.headline).not.toMatch(/これは止めなくてOK|これは危険/);
  if (q.context.kind !== "evidence") expect(API_COPY[q.scenarioId]).toBeDefined();
  if (q.scenarioId === "RDSMasterPasswordReset") expect(v.field).toContain("changeTicket");
  if (["SageMakerLifecycleConfigModified", "EC2UserDataModified"].includes(q.scenarioId))
    expect(v.field).toContain("Hash");
  if (!danger && q.scenarioId === "Policy:S3/BucketPublicAccessGranted") {
    expect(v.actual).toBe("private");
    expect(v.reason).toContain("一覧を公開しない");
  }
}
test("all520 concise answers identify the actual predicate, source and case-specific reason", () => {
  for (const s of availableScenarios(catalog))
    for (const danger of [false, true]) checkCase(s, danger);
});

test("titles explain the same operation for both outcomes without changing the correct-hit reason", () => {
  for (const s of availableScenarios(catalog)) {
    const results = [false, true].map((danger) => {
      const stream = createQuestionStream(catalog, 37);
      Object.assign(stream, {
        elapsed: 300000,
        taughtLevel: LESSONS.length,
        scenarioTier: LESSONS.length,
        scenarioBag: [s],
        outcomes: [danger],
      });
      return explanationCard(nextQuestion(stream));
    });
    expect(results[0].headline).toBe(results[1].headline);
    expect(results[0].headline).not.toMatch(/止めなくてOK|これは危険|不一致|上限を超え/);
    if (s.id === "Policy:S3/BucketPublicAccessGranted")
      expect(results[0].headline).toBe("ファイル一覧を誰に見せるかの設定");
    if (s.operation === "GetPasswordData") expect(results[0].headline).toContain("Session Manager");
    if (s.operation === "DeleteFlowLogs") expect(results[0].headline).toContain("収集を止める操作");
  }
});

test("official documentation URLs require the exact AWS documentation hostname", () => {
  expect("https://docs.aws.amazon.com/guardduty/latest/ug/what-is-guardduty.html").toMatch(
    officialDocsUrl,
  );
  for (const url of [
    "https://docsXaws.amazon.com/reference",
    "https://docs.awsXamazon.com/reference",
    "https://docs.aws.amazonXcom/reference",
    "https://docs.aws.amazon.com.example/reference",
  ])
    expect(url).not.toMatch(officialDocsUrl);
});

test("practice activity log wording matches both outcomes and published examples", () => {
  const ids = [
    "CredentialAccess:IAMUser/AnomalousBehavior",
    "DefenseEvasion:IAMUser/AnomalousBehavior",
    "Discovery:IAMUser/AnomalousBehavior",
    "Impact:IAMUser/AnomalousBehavior",
    "InitialAccess:IAMUser/AnomalousBehavior",
    "Persistence:IAMUser/AnomalousBehavior",
    "PrivilegeEscalation:IAMUser/AnomalousBehavior",
  ];
  for (const id of ids) {
    const source = EVIDENCE_SCENARIOS.find((s) => s.id === id);
    expect(source.title).toEndWith(" · 操作ログ");
    expect(EN_SCENARIOS[id].title).toEndWith(" · Activity log");
    expect(EN_SCENARIOS[id].extra).toEqual([
      ["Record", "Practice activity log / Compare with the plan"],
    ]);
    const examples = coverage.active.find((s) => s.findingType === id).educationalEvidence;
    for (const danger of [false, true]) {
      const stream = createQuestionStream(catalog, 37);
      Object.assign(stream, {
        elapsed: 300000,
        taughtLevel: LESSONS.length,
        scenarioTier: LESSONS.length,
        scenarioBag: [source],
        outcomes: [danger],
      });
      const q = nextQuestion(stream);
      expect(q.danger).toBe(danger);
      expect(q.payload).toContain("練習用の操作ログ / 予定と比較");
      expect(q.payload).not.toContain("合成窓");
      expect(danger ? examples.flaggedExample : examples.normalExample).toBe(q.payload);
    }
  }
  const sharing = EVIDENCE_SCENARIOS.find((s) => s.id === "Exfiltration:IAMUser/AnomalousBehavior");
  expect(sharing.title).toEndWith(" · 操作ログ");
  expect(sharing.extra[0][1]).toContain("作成＋共有設定差分");
});
