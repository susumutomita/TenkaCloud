export const REASON_DURATION_MS = 2000;
export function decisionFact(question) {
  const actual = question.context.actual;
  const fullValue = typeof actual === "string" ? actual : JSON.stringify(actual);
  const account = /^arn:aws:iam::(\d{12}):root$/.exec(fullValue);
  if (account) return { label: "AWSアカウント", value: account[1], fullValue };
  const policy = /^arn:aws:iam::aws:policy\/(.+)$/.exec(fullValue);
  if (policy) return { label: "AWS管理ポリシー", value: policy[1], fullValue };
  return { label: question.decisionField, value: fullValue, fullValue };
}
