import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { cloudMasterFiles, cloudMasterVersion, stampCloudMasterFile } from "./stamp-asset-versions";

const directory = join(import.meta.dir, "../../landing/cloud-master");
const files = cloudMasterFiles(directory);
const version = cloudMasterVersion(files);
const html = readFileSync(join(directory, "index.html"), "utf8");

test("game entry, CSS, static imports and lazy English data use one current content version", () => {
  expect(html).toContain(`src="./game.js?v=${version}"`);
  expect(html).toContain(`href="./game.css?v=${version}"`);
  let references = 0;
  for (const [name, source] of Object.entries(files)) {
    for (const match of source.matchAll(/(["'])(\.\/[^"'?\s]+\.(?:js|css))(?:\?v=([^"']+))?\1/g)) {
      if (!Object.hasOwn(files, posix.join(posix.dirname(name), match[2]))) continue;
      references++;
      expect(match[3]).toBe(version);
    }
    expect(stampCloudMasterFile(source, name, files, version)).toBe(source);
  }
  expect(references).toBeGreaterThan(20);
  expect(files["question-locales.js"]).toContain(
    `import("./locales/en-scenarios.js?v=${version}")`,
  );
  expect(stampCloudMasterFile(html, "index.html", files, version)).toBe(html);
});

test("a transitive English data change invalidates the whole release without hash churn", () => {
  const changed = {
    ...files,
    "locales/en-ui.js": `${files["locales/en-ui.js"]}\n// translated copy changed\n`,
  };
  const next = cloudMasterVersion(changed);
  expect(next).not.toBe(version);
  const stamped = Object.fromEntries(
    Object.entries(changed).map(([name, source]) => [
      name,
      stampCloudMasterFile(source, name, changed, next),
    ]),
  );
  expect(cloudMasterVersion(stamped)).toBe(next);
  expect(stampCloudMasterFile(html, "index.html", changed, next)).toContain(`./game.js?v=${next}`);
  expect(stamped["i18n.js"]).toContain(`./locales/en-ui.js?v=${next}`);
});
