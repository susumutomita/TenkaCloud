import { DefaultStackSynthesizer } from "aws-cdk-lib";
import { projectBootstrap } from "./bootstrap.js";

export function projectSynthesizer(environment: string): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({ qualifier: projectBootstrap(environment).qualifier });
}
