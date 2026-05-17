import { adrMustBeHtml } from "./adr-must-be-html.ts";
import { adrSelfContained } from "./adr-self-contained.ts";
import { iamWildcardNeedsJustify } from "./iam-wildcard-needs-justify.ts";

export const architectureRules = [
  adrMustBeHtml,
  adrSelfContained,
  iamWildcardNeedsJustify,
] as const;
