import { DefaultStackSynthesizer } from "aws-cdk-lib";

/** Keep the reviewed standard toolkit independent of ambient CDK context. */
export function standardSynthesizer(): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({ qualifier: DefaultStackSynthesizer.DEFAULT_QUALIFIER });
}
