import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { explanationCard } from "../../landing/cloud-master/explanation.js";
import { API_COPY } from "../../landing/cloud-master/explanation-copy.js";
import {
  availableScenarios,
  createQuestionStream,
  nextQuestion,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
function checkCase(s: ReturnType<typeof availableScenarios>[number], danger: boolean) {
  const stream = createQuestionStream(catalog, 37);
  Object.assign(stream, {
    elapsed: 120000,
    scenarioTier: 5,
    scenarioBag: [s],
    outcomes: [danger],
  });
  const q = nextQuestion(stream),
    v = explanationCard(q);
  expect(v.field).toBe(q.decisionField);
  expect(v.actual).toBe(
    typeof q.context.actual === "string" ? q.context.actual : JSON.stringify(q.context.actual),
  );
  expect(v.source).toMatch(/^https:\/\/docs.aws.amazon.com\//);
  expect(v.fullReason).toBe(q.why);
  expect(v.reason).not.toBe("表示された対象・用途の範囲内です。");
  if (!danger) expect(v.headline).toBe("これは止めなくてOK");
  if (q.context.kind !== "evidence") expect(API_COPY[q.scenarioId]).toBeDefined();
  if (q.scenarioId === "RDSMasterPasswordReset") expect(v.field).toContain("changeTicket");
  if (["SageMakerLifecycleConfigModified", "EC2UserDataModified"].includes(q.scenarioId))
    expect(v.field).toContain("Hash");
  if (!danger && q.scenarioId === "Policy:S3/BucketPublicAccessGranted") {
    expect(v.actual).toBe("private");
    expect(v.reason).toContain("一覧を公開しない");
  }
}
test("all506 concise answers identify the actual predicate, source and case-specific reason", () => {
  for (const s of availableScenarios(catalog))
    for (const danger of [false, true]) checkCase(s, danger);
});
