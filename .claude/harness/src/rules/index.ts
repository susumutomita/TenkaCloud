import { adrMustBeHtml } from "./adr-must-be-html.ts";
import { adrSelfContained } from "./adr-self-contained.ts";

export const architectureRules = [adrMustBeHtml, adrSelfContained] as const;
