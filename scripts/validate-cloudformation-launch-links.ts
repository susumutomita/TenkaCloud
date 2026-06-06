import { readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");
const cloudFormationUrls = [
  ...readme.matchAll(
    /https:\/\/[^\s)]+cloudformation\/home\?[^\s)]*#\/stacks\/create\/review\?[^\s)]*/g,
  ),
].map((match) => match[0]);

const supportedS3TemplateUrl =
  /templateURL=https:\/\/(?:s3[.-][a-z0-9-]+\.amazonaws\.com\/[^\s)&]+|[^\s)&]+\.s3\.[a-z0-9-]+\.amazonaws\.com\/[^\s)&]+)/i;

const unsupportedUrls = cloudFormationUrls.filter((url) => {
  const decodedUrl = decodeURIComponent(url);
  return decodedUrl.includes("templateURL=") && !supportedS3TemplateUrl.test(decodedUrl);
});

if (unsupportedUrls.length > 0) {
  console.error(
    [
      "README.md contains CloudFormation quick-create links with unsupported templateURL values.",
      "CloudFormation quick-create templateURL must point to Amazon S3; GitHub raw URLs fail in the console.",
      ...unsupportedUrls.map((url) => `- ${url}`),
    ].join("\n"),
  );
  process.exit(1);
}
