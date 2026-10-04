import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactType, Manifest } from "aws-cdk-lib/cloud-assembly-schema";
import { STANDARD_TOOLKIT_QUALIFIER } from "./bootstrap-check";

export interface DestroyAssemblyTarget {
  readonly name: string;
  readonly arn: string;
  readonly account: string;
  readonly region: string;
}
export interface DestroyAssembly {
  readonly directory: string;
  dispose(): void;
}

/** Use CDK's normal deployment credentials without synthesizing today's application. */
export function createDestroyAssembly(target: DestroyAssemblyTarget): DestroyAssembly {
  const directory = mkdtempSync(join(tmpdir(), "tenkacloud-destroy-"));
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  try {
    // Destroy never deploys this template; CloudFormation uses its deployed resource graph.
    writeFileSync(join(directory, "stack.template.json"), JSON.stringify({ Resources: {} }));
    Manifest.saveAssemblyManifest(
      {
        version: Manifest.version(),
        artifacts: {
          [target.name]: {
            type: ArtifactType.AWS_CLOUDFORMATION_STACK,
            environment: `aws://${target.account}/${target.region}`,
            properties: {
              templateFile: "stack.template.json",
              stackName: target.arn,
              assumeRoleArn: `arn:aws:iam::${target.account}:role/cdk-${STANDARD_TOOLKIT_QUALIFIER}-deploy-role-${target.account}-${target.region}`,
              // Omit an execution-role override: retain the stack's deployed service role.
            },
          },
        },
      },
      join(directory, "manifest.json"),
    );
    return { directory, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
