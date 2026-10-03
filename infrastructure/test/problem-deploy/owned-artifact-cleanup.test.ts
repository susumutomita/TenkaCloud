import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CompetitorBootstrapHosting } from "../../lib/problem-deploy/competitor-bootstrap-hosting";
import { CoordinationPluginBundle } from "../../lib/problem-deploy/coordination-plugin-bundle";

describe("owned cloud artifact cleanup", () => {
  it.each(["bootstrap", "coordination"] as const)(
    "deletes %s uploads before bucket cleanup on rollback",
    (kind) => {
      const app = new App({ autoSynth: false });
      const stack = new Stack(app, "Artifacts");
      const hosted =
        kind === "bootstrap"
          ? new CompetitorBootstrapHosting(stack, "Hosted")
          : new CoordinationPluginBundle(stack, "Hosted", {
              bundles: { sample: "export default {};" },
            });
      expect(hosted.node.id).toBe("Hosted");
      const template = Template.fromStack(stack);
      const cleanup = Object.keys(template.findResources("Custom::S3AutoDeleteObjects"));
      const uploads = Object.values(template.findResources("Custom::CDKBucketDeployment"));
      expect(cleanup).toHaveLength(1);
      expect(uploads).toHaveLength(1);
      for (const upload of uploads) {
        expect(upload.Properties.RetainOnDelete).toBe(false);
        expect(upload.DependsOn).toEqual(expect.arrayContaining(cleanup));
      }
    },
  );

  it("publishes only the secret-free competitor bootstrap template", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "Bootstrap");
    const hosted = new CompetitorBootstrapHosting(stack, "Hosted");
    expect(hosted.templateUrl).toContain("competitor-bootstrap.yaml");
    const policies = Object.values(
      Template.fromStack(stack).findResources("AWS::S3::BucketPolicy"),
    );
    const publicReads = policies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement) => statement.Effect === "Allow" && statement.Principal?.AWS === "*");
    expect(publicReads).toHaveLength(1);
    expect(publicReads[0].Action).toBe("s3:GetObject");
    expect(JSON.stringify(publicReads[0].Resource)).toContain("/competitor-bootstrap.yaml");
    expect(JSON.stringify(publicReads[0].Resource)).not.toContain("/*");
  });
});
