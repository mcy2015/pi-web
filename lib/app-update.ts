const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

import packageJson from "../package.json";

function repositoryWebUrl(pkg: { repository?: unknown } = packageJson): string {
  const repo = pkg.repository;
  const url = typeof repo === "string" ? repo : (typeof repo === "object" && repo !== null && "url" in repo)
    ? String((repo as { url?: unknown }).url ?? "")
    : "";
  return url.replace(/^git\+/, "").replace(/\.git$/, "");
}

/** This fork checks the upstream package for update notices: a newer upstream version is the cue to sync the fork, while the fork's own npm line (@mcy2015/pi-web) releases separately. */
export const UPSTREAM_PACKAGE = "@agegr/pi-web";
export const UPSTREAM_REPO_URL = "https://github.com/agegr/pi-web";

export function getNpmLatestUrl(packageName: string = UPSTREAM_PACKAGE): string {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
}

function parseStableVersion(version: string): [number, number, number] | null {
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match) return null;

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts as [number, number, number];
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  const candidateParts = parseStableVersion(candidate);
  const currentParts = parseStableVersion(current);
  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

export function getPiWebReleaseUrl(version: string, repoWebUrl: string = repositoryWebUrl()): string | null {
  if (!parseStableVersion(version)) return null;
  return `${repoWebUrl}/releases/tag/v${version}`;
}
