import { describe, expect, it } from "vitest";
import {
  type AwsSignedRequest,
  createSigV4SubjectTokenSigner,
  formatGcpSubjectToken,
} from "../../lib/problem-deploy/runtime-clients/gcp-aws-subject-token.js";

/**
 * [#1411] AWS subject-token builder の pin。 formatGcpSubjectToken は純関数なので exact 検証。
 * SigV4 signer は static credentials で構造 (url / method / x-goog-cloud-target-resource + 署名ヘッダ) を
 * 観測する。署名値そのものの正当性は実 AWS STS / GCP WIF に対する integration test で検証する。
 */

describe("gcp-aws-subject-token (#1411)", () => {
  it("should URL-encode the signed request JSON for GCP STS", () => {
    const signed: AwsSignedRequest = {
      url: "https://sts.ap-northeast-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
      method: "POST",
      headers: [{ key: "host", value: "sts.ap-northeast-1.amazonaws.com" }],
    };
    const token = formatGcpSubjectToken(signed);
    expect(token).toBe(encodeURIComponent(JSON.stringify(signed)));
    expect(JSON.parse(decodeURIComponent(token))).toEqual(signed);
  });

  it("should SigV4-sign GetCallerIdentity binding the WIF audience into the signed headers", async () => {
    const signer = createSigV4SubjectTokenSigner({
      credentials: { accessKeyId: "AKIA_TEST", secretAccessKey: "secret" },
    });
    const signed = await signer.sign({
      region: "ap-northeast-1",
      wifAudience:
        "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/aws",
    });
    expect(signed.method).toBe("POST");
    expect(signed.url).toBe(
      "https://sts.ap-northeast-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
    );
    const byKey = (k: string) => signed.headers.find((h) => h.key.toLowerCase() === k)?.value;
    // GCP が検証する target-resource が署名済ヘッダに乗っている
    expect(byKey("x-goog-cloud-target-resource")).toBe(
      "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/aws",
    );
    // SigV4 の Authorization + x-amz-date が付いている (署名値そのものは検証しない)
    expect(byKey("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(byKey("x-amz-date")).toBeDefined();
  });
});
