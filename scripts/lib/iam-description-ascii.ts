/**
 * [Issue #664 follow-up] IAM Description ASCII / Latin-1 gate — pure logic.
 *
 * IAM `AWS::IAM::Role` / `AWS::IAM::ManagedPolicy` `Description` is constrained by the IAM service to
 * a regex allowing only tab/LF/CR + printable ASCII (0x20-0x7E) + Latin-1 supplement (0xA1-0xFF).
 * Anything outside it (CJK, an em-dash, a U+2192 arrow) makes CloudFormation fail the stack with
 * `CREATE_FAILED ... failed to satisfy constraint ... regular expression pattern`.
 *
 * `scripts/check-template-ascii.ts` already gates the hand-written YAML templates. But a description
 * set in CDK (e.g. `new iam.Role(this, "X", { description: "... -> ..." })`) never appears in a YAML
 * file — it lands in the *synthesized* CloudFormation, often wrapped in an `Fn::Join` because it
 * interpolates a token. That gap let a U+2192 arrow in `ChallengePayloadStack`'s PublishRole reach a
 * real deploy and fail it. This module scans the **synthesized template** (the actual deploy
 * artifact), recursing into CFn intrinsics, so the same class of bug is caught before deploy.
 *
 * Pure (no fs). The I/O shell is scripts/check-synth-iam-ascii.ts.
 */

/** Resource types whose `Description` carries the IAM Latin-1 constraint. */
export const IAM_DESCRIPTION_RESOURCE_TYPES = [
  "AWS::IAM::Role",
  "AWS::IAM::ManagedPolicy",
] as const;

/** The exact character class IAM allows in a Description (shared with check-template-ascii). */
export function isAllowedCharCode(cp: number): boolean {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0x7e) ||
    (cp >= 0xa1 && cp <= 0xff)
  );
}

export interface DisallowedChar {
  readonly char: string;
  readonly codePoint: number;
}

/** First character in `s` outside the IAM Latin-1 range, or undefined when all are allowed. */
export function firstDisallowedChar(s: string): DisallowedChar | undefined {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && !isAllowedCharCode(cp)) return { char: ch, codePoint: cp };
  }
  return undefined;
}

/**
 * Collect every leaf string inside a (possibly intrinsic-wrapped) value. An `Fn::Join` description
 * is `["", ["lit -> ", {"Ref": "X"}]]`; the literal fragments carry the user text and must be
 * scanned. We recurse object *values* (not keys — `Fn::Join`/`Ref` are CFn syntax, not content).
 */
export function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  }
  return [];
}

export interface IamDescriptionFinding {
  readonly logicalId: string;
  readonly resourceType: string;
  readonly fragment: string;
  readonly char: string;
  readonly codePoint: number;
}

/** Format a codepoint as `U+XXXX`. */
export function formatCodePoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Scan one parsed CloudFormation template for IAM Role / ManagedPolicy descriptions containing a
 * character outside the IAM Latin-1 range. Returns one finding per offending resource.
 */
export function scanTemplateForIamDescriptions(template: unknown): IamDescriptionFinding[] {
  const resources =
    template && typeof template === "object"
      ? (template as Record<string, unknown>).Resources
      : undefined;
  if (!resources || typeof resources !== "object") return [];

  const findings: IamDescriptionFinding[] = [];
  for (const [logicalId, raw] of Object.entries(resources as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const resource = raw as Record<string, unknown>;
    const type = resource.Type;
    if (typeof type !== "string" || !IAM_DESCRIPTION_RESOURCE_TYPES.includes(type as never)) {
      continue;
    }
    const props = resource.Properties;
    const description =
      props && typeof props === "object"
        ? (props as Record<string, unknown>).Description
        : undefined;
    if (description === undefined || description === null) continue;
    for (const fragment of collectStrings(description)) {
      const bad = firstDisallowedChar(fragment);
      if (bad) {
        findings.push({
          logicalId,
          resourceType: type,
          fragment,
          char: bad.char,
          codePoint: bad.codePoint,
        });
        break; // one finding per resource is enough to fail + locate it
      }
    }
  }
  return findings;
}
