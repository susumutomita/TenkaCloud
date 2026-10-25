import { expect, test } from "bun:test";
import { captureCandidate, catalogIdentity, HostCandidateSchema } from "./host-candidate";

const source = "a".repeat(40);
const catalog = {
  schemaVersion: 1 as const,
  sources: [
    {
      url: "https://example.invalid/pack.git",
      ref: "main",
      commit: "b".repeat(40),
      digest: "f".repeat(64),
      problemsRoot: ".",
    },
  ],
};
const input = {
  tag: "tenkacloud-host:review",
  platformCommit: source,
  catalog: catalog,
  inspection: [
    {
      Id: `sha256:${"c".repeat(64)}`,
      RepoTags: ["tenkacloud-host:review"],
      RepoDigests: [],
      Config: {
        Labels: {
          "org.opencontainers.image.revision": source,
          "io.tenkacloud.catalog.digest": catalogIdentity(catalog),
        },
      },
    },
  ],
};
test("a local candidate records the exact image and source pins without claiming publication", () => {
  const result = captureCandidate(input);
  expect(result.status).toBe("unpublished");
  expect(result.image).toEqual({
    tag: input.tag,
    imageId: `sha256:${"c".repeat(64)}`,
    registryDigests: [],
  });
  expect(result.schemaVersion).toBe(3);
  expect(result.sources).toEqual({ platformCommit: source });
});
test("local RepoDigests metadata does not promote an image to a published release", () => {
  const repoDigest = `tenkacloud-host@sha256:${"c".repeat(64)}`;
  const result = captureCandidate({
    ...input,
    inspection: input.inspection.map((image) => ({ ...image, RepoDigests: [repoDigest] })),
  });
  expect(result.image?.registryDigests).toEqual([repoDigest]);
  expect(result.status).toBe("unpublished");
  expect(result.limitations).toContain(
    "imageId is Docker inspect Id; registryDigests copies Docker RepoDigests. Neither field proves registry publication.",
  );
});
test("candidate capture rejects a stale source, catalog or tag", () => {
  expect(() => captureCandidate({ ...input, platformCommit: "d".repeat(40) })).toThrow("labels");
  expect(() =>
    captureCandidate({
      ...input,
      catalog: {
        ...catalog,
        sources: catalog.sources.map((revision) => ({ ...revision, digest: "e".repeat(64) })),
      },
    }),
  ).toThrow("labels");
  expect(() => captureCandidate({ ...input, tag: "unrelated:latest" })).toThrow("tag");
});
test("pending and built candidate identities cannot be mixed or promoted by changing status", () => {
  const built = captureCandidate(input);
  expect(
    HostCandidateSchema.safeParse({ ...built, sources: { ...built.sources, platformCommit: null } })
      .success,
  ).toBe(false);
  expect(HostCandidateSchema.safeParse({ ...built, status: "published" }).success).toBe(false);
  expect(
    HostCandidateSchema.safeParse({ ...built, image: { ...built.image, imageId: "latest" } })
      .success,
  ).toBe(false);
});
