import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getNpmLatestUrl, getPiWebReleaseUrl, isNewerStableVersion, UPSTREAM_PACKAGE, UPSTREAM_REPO_URL } = await jiti.import("./app-update.ts");
const packageJson = createRequire(import.meta.url)("../package.json");
const repoUrl = packageJson.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

test("detects newer stable Pi Web versions", () => {
  assert.equal(isNewerStableVersion("0.8.8", "0.8.7"), true);
  assert.equal(isNewerStableVersion("0.9.0", "0.8.7"), true);
  assert.equal(isNewerStableVersion("1.0.0", "0.9.9"), true);
});

test("does not report equal, older, or unsupported versions as updates", () => {
  assert.equal(isNewerStableVersion("0.8.7", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.6", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.8-beta.1", "0.8.7"), false);
  assert.equal(isNewerStableVersion("invalid", "0.8.7"), false);
});

test("builds a release-notes URL only for stable versions", () => {
  assert.equal(
    getPiWebReleaseUrl("0.8.8"),
    `${repoUrl}/releases/tag/v0.8.8`,
  );
  assert.equal(getPiWebReleaseUrl("0.8.8-beta.1"), null);
});

test("the fork's update notice tracks the upstream package and its releases", () => {
  assert.equal(UPSTREAM_PACKAGE, "@agegr/pi-web");
  assert.equal(
    getNpmLatestUrl(),
    "https://registry.npmjs.org/%40agegr%2Fpi-web/latest",
  );
  assert.equal(
    getPiWebReleaseUrl("0.14.2", UPSTREAM_REPO_URL),
    "https://github.com/agegr/pi-web/releases/tag/v0.14.2",
  );
});
