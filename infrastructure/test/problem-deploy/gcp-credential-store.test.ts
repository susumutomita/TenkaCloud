import { ParameterNotFound } from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import {
  buildGcpCredentialParameterArnPattern,
  buildGcpCredentialParameterName,
  deleteGcpCredential,
  type GcpCredentialStoreDeps,
  getGcpCredential,
  putGcpCredential,
} from "../../lib/problem-deploy/handlers/shared/gcp-credential-store.js";

/**
 * [#1411] per-team GCP WIF config store の振る舞い pin。 鍵レス (= federate 先 config のみ) だが
 * Sakura/Azure と同じ SecureString store に相乗りする。 path / 必須 field parse / round-trip / not-found を観測。
 */

function makeDeps(send: ReturnType<typeof vi.fn>): GcpCredentialStoreDeps {
  return { ssm: { send } as never, env: "development" };
}

const CRED = {
  wifAudience:
    "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/aws",
  serviceAccountEmail: "deployer@proj.iam.gserviceaccount.com",
  projectId: "proj-1",
  location: "asia-northeast1",
};

describe("gcp-credential-store (#1411)", () => {
  it("should build the per-team path + IAM ARN pattern", () => {
    expect(buildGcpCredentialParameterName("development", "t1", "team-a")).toBe(
      "/development/tenants/t1/teams/team-a/gcp-credential",
    );
    expect(buildGcpCredentialParameterArnPattern("us-east-1", "123456789012", "production")).toBe(
      "arn:aws:ssm:us-east-1:123456789012:parameter/production/tenants/*/teams/*/gcp-credential",
    );
  });

  it("should round-trip the WIF config", async () => {
    let stored: string | undefined;
    const send = vi
      .fn()
      .mockImplementation((cmd: { constructor: { name: string }; input?: { Value?: string } }) => {
        if (cmd.constructor.name === "PutParameterCommand") {
          stored = cmd.input?.Value;
          return Promise.resolve({});
        }
        return Promise.resolve({ Parameter: { Value: stored } });
      });
    const deps = makeDeps(send);
    await putGcpCredential(deps, "t", "team", CRED);
    expect(await getGcpCredential(deps, "t", "team")).toEqual(CRED);
  });

  it("should return undefined when a required field is missing (fail-safe)", async () => {
    for (const value of [
      "not json",
      JSON.stringify({ ...CRED, wifAudience: undefined }),
      JSON.stringify({ ...CRED, projectId: "" }),
      "null",
    ]) {
      const send = vi.fn().mockResolvedValue({ Parameter: { Value: value } });
      expect(await getGcpCredential(makeDeps(send), "t", "team")).toBeUndefined();
    }
  });

  it("should return undefined on ParameterNotFound and treat delete as idempotent", async () => {
    const send = vi.fn().mockRejectedValue(new ParameterNotFound({ message: "x", $metadata: {} }));
    expect(await getGcpCredential(makeDeps(send), "t", "team")).toBeUndefined();
    await expect(deleteGcpCredential(makeDeps(send), "t", "team")).resolves.toBeUndefined();
  });

  /**
   * [Issue #2745] `artifactBucket` is an optional field for the GCS blueprint materializer.
   */
  describe("artifactBucket (#2745)", () => {
    it("should round-trip a credential that declares artifactBucket", async () => {
      let stored: string | undefined;
      const send = vi
        .fn()
        .mockImplementation(
          (cmd: { constructor: { name: string }; input?: { Value?: string } }) => {
            if (cmd.constructor.name === "PutParameterCommand") {
              stored = cmd.input?.Value;
              return Promise.resolve({});
            }
            return Promise.resolve({ Parameter: { Value: stored } });
          },
        );
      const deps = makeDeps(send);
      const withBucket = { ...CRED, artifactBucket: "team-a-gcp-artifacts" };
      await putGcpCredential(deps, "t", "team", withBucket);
      expect(await getGcpCredential(deps, "t", "team")).toEqual(withBucket);
    });

    it("should keep parsing a pre-existing credential with no artifactBucket (backward compatible)", async () => {
      const send = vi.fn().mockResolvedValue({ Parameter: { Value: JSON.stringify(CRED) } });
      const parsed = await getGcpCredential(makeDeps(send), "t", "team");
      expect(parsed).toEqual(CRED);
      expect(parsed?.artifactBucket).toBeUndefined();
    });

    it("should drop a non-string/empty artifactBucket without failing the whole parse", async () => {
      for (const badValue of [123, "", null]) {
        const send = vi.fn().mockResolvedValue({
          Parameter: { Value: JSON.stringify({ ...CRED, artifactBucket: badValue }) },
        });
        const parsed = await getGcpCredential(makeDeps(send), "t", "team");
        expect(parsed).toBeDefined();
        expect(parsed?.artifactBucket).toBeUndefined();
      }
    });
  });
});
