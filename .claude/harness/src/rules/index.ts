import { adrMustBeHtml } from "./adr-must-be-html.ts";
import { adrSelfContained } from "./adr-self-contained.ts";
import { fileTooLarge } from "./file-too-large.ts";
import { handlerNoDirectSdkImport } from "./handler-no-direct-sdk-import.ts";
import { iamWildcardNeedsJustify } from "./iam-wildcard-needs-justify.ts";

export const architectureRules = [
  adrMustBeHtml,
  adrSelfContained,
  iamWildcardNeedsJustify,
  // Issue #986 / SOLID 規律強制
  fileTooLarge,
  handlerNoDirectSdkImport,
] as const;
